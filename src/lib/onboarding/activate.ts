import type { Location, User } from "../types";
import { getLocation, getTenant, getUser, listCalls, upsertLocation } from "../store";
import { publish } from "../brain";
import { track } from "../reception/events";
import { factsFrom, journey, recordStep, type Blocker } from "./journey";
import { paidWorkRefusal } from "../abuse/gate";
import { screenTrial } from "../abuse/review";
import { stripeEnabled } from "../billing/stripe";
import { cardRequired, cardSentence, resolveCardFingerprint, startTrialSubscription, trialEndFor } from "../billing/card";
import { openException } from "../exceptions";

/**
 * Going live, as the one place it happens.
 *
 * Both routes that can ask for it (/api/setup/activate and the journey route's
 * "activate" action) call this, and it re-reads the venue and re-runs the
 * journey itself, so a request sent by hand is held to exactly the gate the
 * page shows: every step done, the checks passed against the setup as it is
 * now, nothing readiness() finds missing, and a clinic only once clinics open.
 *
 * Then, in order (trial-at-golive.md and the abuse screening):
 *
 *   the owner's email is confirmed and the trial is not paused (abuse/gate.ts)
 *   with card payments open, a card is on file (billing/card.ts) — 402 with
 *     the page that takes it, charging nothing
 *   the business has no other account's trial or plan, by website, phone or
 *     that card's fingerprint (abuse/review.ts)
 *   the free month starts now: `trial.endsOn` is stamped 30 days from today,
 *     and with payments open Stripe gets a subscription whose first invoice
 *     falls on day 31
 *
 * With payments closed Go live is never blocked for a card: it activates, and
 * a `stripe_off_trial_end` row tells the team the date so they can ask for a
 * card before anything is charged.
 */

export type ActivateResult =
  | { ok: true; next: string }
  | { ok: false; status: number; error: string; fix?: string; blockers: Blocker[]; code?: string };

/** Where the card step sends the owner, and brings them back to. */
export function cardUrl(locationId: string): string {
  return `/api/billing/card?locationId=${encodeURIComponent(locationId)}`;
}

export async function activateVenue(locationId: string, by: Pick<User, "id" | "name">, now: Date = new Date()): Promise<ActivateResult> {
  const location = getLocation(locationId);
  if (!location) return { ok: false, status: 404, error: "Business not found.", blockers: [] };

  const facts = factsFrom(location, listCalls(location.id));
  const out = recordStep(location, { kind: "activate", by: by.id }, facts, now);
  if (!out.ok) {
    return { ok: false, status: out.status, error: out.error, fix: out.fix, blockers: journey(location, facts, now).blockers };
  }

  const held = paidWorkRefusal(getUser(by.id), location, { stage: "golive" });
  if (held) return { ok: false, status: held.status, error: held.error, fix: held.fix, code: held.code, blockers: [] };

  const payments = stripeEnabled();
  if (cardRequired(location, { payments })) {
    return { ok: false, status: 402, error: cardSentence(location, now), fix: cardUrl(location.id), code: "card_required", blockers: [] };
  }
  if (payments && location.stripe?.setupIntentId) {
    try {
      await resolveCardFingerprint(location);
    } catch (err) {
      console.error("[golive] card lookup failed:", err);
      return { ok: false, status: 502, error: "Belline could not check your card just now. Try again in a minute.", blockers: [] };
    }
  }
  const current = getLocation(location.id) ?? location;
  const duplicate = screenTrial(current, "golive", {}, now);
  if (duplicate) return { ok: false, status: duplicate.status, error: duplicate.error, fix: duplicate.fix, code: duplicate.code, blockers: [] };

  // The free month starts now.
  let next: Location = { ...current, onboarding: out.location.onboarding };
  const sub = current.subscription;
  if (sub?.status === "trialing" && sub.trial) {
    const endsOn = trialEndFor(now, current.timezone);
    next = { ...next, subscription: { ...sub, trial: { ...sub.trial, endsOn, extendedFrom: undefined, extendedAt: undefined } } };
    if (payments && current.stripe?.cardSavedAt && !current.stripe.trialSubscriptionId) {
      try {
        const id = await startTrialSubscription(current, endsOn);
        next = { ...next, stripe: { ...current.stripe, subscriptionId: id, trialSubscriptionId: id } };
      } catch (err) {
        console.error("[golive] trial subscription failed:", err);
        return { ok: false, status: 502, error: "Belline could not start your free month just now. Nothing was charged. Try again in a minute.", blockers: [] };
      }
    }
    if (!payments && !current.internal && !current.demo?.enabled && !current.prospect && !getTenant(current.tenantId)?.internal) {
      openException(
        {
          tenantId: current.tenantId,
          locationId: current.id,
          kind: "stripe_off_trial_end",
          reason: `${current.name} went live on ${now.toISOString().slice(0, 10)} with card payments closed. The free month runs to ${endsOn}; no card is on file yet, so ask for one before anything is charged.`,
          context: { activatedAt: now.toISOString(), endsOn, day: now.toISOString().slice(0, 10), stage: "golive" },
          source: "system",
        },
        now,
      );
    }
  }

  const saved = upsertLocation(next);
  // A line in the history, although nothing the agent says has changed: which
  // version a venue went live on is the first thing asked about its first call.
  publish(saved.id, by, "Went live", { force: true });
  // Never throws; without Postgres it is dropped.
  await track({ tenantId: saved.tenantId, locationId: saved.id, name: "account.activated", payload: { by: by.id } });

  const live = getLocation(saved.id) ?? saved;
  return { ok: true, next: journey(live, factsFrom(live, listCalls(live.id)), now).next?.url ?? "/" };
}

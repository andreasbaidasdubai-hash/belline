import type { Location } from "../types";
import { getTenant, listLocations, upsertLocation } from "../store";
import { listExceptions, openException } from "../exceptions";
import { addDays, todayIn } from "../time";
import { stripeEnabled } from "./stripe";
import { packsHeld, trialCapReached } from "./entitlement";

/**
 * A trial that reaches its end while card payments are closed.
 *
 * The owner cannot pay, so the trial cannot fairly end. It is extended once,
 * by `TRIAL_EXTENSION_DAYS`, and a `stripe_off_trial_end` exception tells the
 * team to plan the first payment. The owner is told they are covered until the
 * new date, never sent to an email address.
 *
 * Not extended twice: after the extension runs out with payments still closed,
 * the exception is raised again (the open row counts it) and entitlement.ts
 * keeps answering anyway, because the end date is not enforced while payments
 * are off. Only the date: a trial's voice minutes and text conversations stop
 * their channels always (entitlement.ts), and `raiseTrialCapIfPaymentsClosed`
 * tells the team when that happens with payments closed, because the owner has
 * no plan to choose.
 *
 * With card payments open, nothing here happens: the trial ends, the owner
 * chooses a plan, and the lapse is enforced as before.
 */

export const TRIAL_EXTENSION_DAYS = 14;

function exempt(location: Location): boolean {
  if (location.demo?.enabled || location.prospect || location.internal) return true;
  return Boolean(getTenant(location.tenantId)?.internal);
}

export interface TrialEndOutcome {
  location: Location;
  action: "none" | "extended" | "raised";
}

/** Extend one venue's trial if it is due. Idempotent: a second call the same day does nothing more. */
export function extendTrialIfPaymentsClosed(
  venue: Location,
  today: string = todayIn(venue.timezone),
  opts: { payments?: boolean; now?: Date } = {},
): TrialEndOutcome {
  const sub = venue.subscription;
  const payments = opts.payments ?? stripeEnabled();
  if (payments || !sub || sub.status !== "trialing" || !sub.trial || exempt(venue)) return { location: venue, action: "none" };
  // The last day of the trial counts: extended on the day it would end, so
  // there is never a day on which it has lapsed.
  if (today < sub.trial.endsOn) return { location: venue, action: "none" };

  const now = opts.now ?? new Date();
  if (sub.trial.extendedFrom) {
    // The one extension is used and payments are still closed. The team
    // already has the row; this adds to its count at most once a day, however
    // often the billing page is opened.
    const already = listExceptions({ kind: "stripe_off_trial_end" }).some(
      (e) => e.locationId === venue.id && e.status !== "resolved" && e.context.day === today,
    );
    if (already) return { location: venue, action: "none" };
    const opened = openException(
      {
        tenantId: venue.tenantId,
        locationId: venue.id,
        kind: "stripe_off_trial_end",
        reason: `The extended trial for ${venue.name} ended on ${sub.trial.endsOn} and card payments are still closed. Belline keeps answering while the trial's voice minutes and text conversations last.`,
        context: { endsOn: sub.trial.endsOn, extendedFrom: sub.trial.extendedFrom, day: today },
        source: "system",
      },
      now,
    );
    return { location: venue, action: opened.exception ? "raised" : "none" };
  }

  const endsOn = addDays(sub.trial.endsOn, TRIAL_EXTENSION_DAYS);
  const saved =
    upsertLocation({
      ...venue,
      subscription: { ...sub, trial: { ...sub.trial, endsOn, extendedFrom: sub.trial.endsOn, extendedAt: now.toISOString() } },
    }) ?? venue;
  openException(
    {
      tenantId: venue.tenantId,
      locationId: venue.id,
      kind: "stripe_off_trial_end",
      reason: `The trial for ${venue.name} reached ${sub.trial.endsOn} with card payments closed. It was extended to ${endsOn}.`,
      context: { endsOn, extendedFrom: sub.trial.endsOn, day: today },
      source: "system",
    },
    now,
  );
  return { location: saved, action: "extended" };
}

/**
 * A trial cap (voice minutes or text conversations) has stopped a channel while
 * card payments are closed. The owner is told "the Belline team has been told",
 * so this is what makes that true: one open `trial_cap_reached` row per venue,
 * counted at most once a day however often the dashboard is opened.
 */
export function raiseTrialCapIfPaymentsClosed(
  venue: Location,
  today: string = todayIn(venue.timezone),
  opts: { payments?: boolean; now?: Date } = {},
): boolean {
  const payments = opts.payments ?? stripeEnabled();
  if (payments || exempt(venue)) return false;
  const cap = trialCapReached(venue, today);
  if (!cap) return false;
  const already = listExceptions({ kind: "trial_cap_reached" }).some(
    (e) => e.locationId === venue.id && e.status !== "resolved" && e.context.day === today && e.context.cap === cap,
  );
  if (already) return false;
  const words = cap === "trial_minutes_used" ? "voice minutes" : "text conversations";
  openException(
    {
      tenantId: venue.tenantId,
      locationId: venue.id,
      kind: "trial_cap_reached",
      reason: `The trial for ${venue.name} has used all its ${words} and card payments are closed, so Belline has stopped answering on those channels.`,
      context: { cap, day: today },
      source: "system",
    },
    opts.now ?? new Date(),
  );
  return true;
}

/**
 * A paid plan whose owner chose "add a pack automatically" has used up an
 * allowance while card payments are closed. No pack is added — it could never
 * be charged — so the pool has stopped (usage-policy.ts), and the owner is
 * told the team has been told. This makes that true, the same way
 * `raiseTrialCapIfPaymentsClosed` does: one open row per venue and pool,
 * counted at most once a day.
 */
export function raisePacksHeldIfPaymentsClosed(
  venue: Location,
  today: string = todayIn(venue.timezone),
  opts: { payments?: boolean; now?: Date } = {},
): boolean {
  const payments = opts.payments ?? stripeEnabled();
  if (payments || exempt(venue)) return false;
  let raised = false;
  for (const pool of packsHeld(venue, today, { payments: false })) {
    const already = listExceptions({ kind: "packs_held_payments_off" }).some(
      (e) => e.locationId === venue.id && e.status !== "resolved" && e.context.day === today && e.context.pool === pool,
    );
    if (already) continue;
    const words = pool === "minutes" ? "voice minutes" : "text conversations";
    openException(
      {
        tenantId: venue.tenantId,
        locationId: venue.id,
        kind: "packs_held_payments_off",
        reason: `${venue.name} has used this period's ${words}. The owner chose to add packs automatically, but card payments are closed, so no pack was added and Belline has stopped answering on those channels.`,
        context: { pool, day: today },
        source: "system",
      },
      opts.now ?? new Date(),
    );
    raised = true;
  }
  return raised;
}

/** Every venue, for the billing sweep. */
export function sweepTrialEnds(now: Date = new Date()): { extended: number; raised: number } {
  if (stripeEnabled()) return { extended: 0, raised: 0 };
  let extended = 0;
  let raised = 0;
  for (const venue of listLocations()) {
    const today = todayIn(venue.timezone);
    const out = extendTrialIfPaymentsClosed(venue, today, { payments: false, now });
    if (out.action === "extended") extended++;
    if (out.action === "raised") raised++;
    if (raiseTrialCapIfPaymentsClosed(out.location, today, { payments: false, now })) raised++;
    if (raisePacksHeldIfPaymentsClosed(out.location, today, { payments: false, now })) raised++;
  }
  return { extended, raised };
}

function spoken(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long" });
}

/** The owner's sentence while payments are closed. Never an email address. */
export function paymentsSoonSentence(venue: Location | undefined): string {
  const endsOn = venue?.subscription?.status === "trialing" ? venue.subscription.trial?.endsOn : undefined;
  return endsOn
    ? `Payments open soon — you're covered until ${spoken(endsOn)}.`
    : "Payments open soon — Belline keeps answering until then.";
}

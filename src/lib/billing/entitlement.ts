import type { Location } from "../types";
import { getTenant } from "../store";
import { accountFor, isPooledTrial, meterFor, periodFor, productsOf } from "./usage";
import { channelsOf, grandfatherExpires, poolOf, type Channel } from "./plans";
import { stripeEnabled } from "./stripe";
import { applyUsagePolicy, governs, notifyAlerts, poolExhausted, settlePacks } from "./usage-policy";

/**
 * Is this venue entitled to be answered — at all, and on this channel?
 *
 * Three questions, with different answers about strictness.
 *
 * **Lapsing** — a trial that ended or used its voice minutes, a cancelled
 * period that ran out, an original-ladder plan past its grandfathered date.
 * Nothing here is enforced while card payments are switched off: stopping a
 * trial customer's phone when the checkout cannot take their card would
 * punish them for our gap. `lapsed` is still reported, so the client book can
 * show who needs a call. A September 2026 bundle never lapses.
 *
 * **Units** — a trial's text conversations used up stops its chat (and only
 * its chat), under the same card-payments guard. On a 2026-10 plan a pool at
 * 100% is decided by the owner's usage policy (billing/usage-policy.ts): a
 * pack is added if they chose packs and it fits their cap; otherwise that
 * pool's channels stop with `allowance_exhausted` — again only while card
 * payments are on. Older products keep the terms they were sold on.
 *
 * **Channels** — a plan that does not include this channel (today only the
 * original ladder, which was never sold WhatsApp). That is enforced always:
 * it is not a gap on our side, and answering a channel nobody pays for spends
 * real money.
 *
 * A failed card never stops anybody while Stripe retries.
 */

export type Lapse = "trial_ended" | "trial_minutes_used" | "cancelled" | "legacy_plan_ended";
export type Refusal = Lapse | "not_in_plan" | "trial_conversations_used" | "allowance_exhausted";

export interface ServiceState {
  /** Whether this venue — on this channel, if one was asked about — should be answered right now. */
  answering: boolean;
  /** Why the venue is past what it has paid for, whether or not that is enforced. */
  lapsed: Lapse | null;
  /** Why `answering` is false. */
  refused?: Refusal;
  /** Said to a caller or shown to a visitor when not answering. Never mentions money. */
  callerMessage?: string;
}

/** Venues that are ours to pay for, or predate billing: never lapsed, every channel open. */
function exempt(location: Location): boolean {
  if (!location.subscription) return true;
  if (location.demo?.enabled || location.prospect || location.internal) return true;
  return Boolean(getTenant(location.tenantId)?.internal);
}

export function lapseOf(location: Location, today: string): Lapse | null {
  if (exempt(location)) return null;
  const sub = location.subscription!;

  if (sub.status === "trialing") {
    if (sub.trial && today > sub.trial.endsOn) return "trial_ended";
    const account = accountFor(location, today);
    // A 2026-10 trial caps pooled voice minutes; an older one, phone minutes.
    const voice = account?.usage.meters.find((m) => m.id === (isPooledTrial(sub) ? "minutes" : "phone"));
    const allowance = sub.trial?.minutes ?? 0;
    if (voice && allowance > 0 && voice.used >= allowance) return "trial_minutes_used";
    return null;
  }

  if (sub.status === "cancelled") {
    // Service runs to the end of the period in which they cancelled.
    const from = (sub.cancelledAt ?? today).slice(0, 10);
    const end = periodFor(sub, from).end;
    return today >= end ? "cancelled" : null;
  }

  // Only a grandfathering that runs out can end. A September bundle carrying
  // a stray date is kept regardless.
  if (grandfatherExpires(productsOf(sub)) && sub.grandfatheredUntil && today > sub.grandfatheredUntil) {
    return "legacy_plan_ended";
  }

  return null;
}

/** Does the venue's plan include this channel? A trial includes all of them. */
export function channelIncluded(location: Location, channel: Channel): boolean {
  if (exempt(location)) return true;
  const sub = location.subscription!;
  if (sub.status === "trialing") return true;
  return channelsOf(productsOf(sub)).includes(channel);
}

/** A unit used up on this channel, independent of whether that is enforced. */
export function unitRefusal(location: Location, today: string, channel: Channel): Refusal | null {
  if (exempt(location)) return null;
  const sub = location.subscription!;
  if (isPooledTrial(sub) && poolOf(channel) === "conversations") {
    const account = accountFor(location, today);
    const m = account && meterFor(account, channel);
    if (m && m.included !== null && m.used >= m.included) return "trial_conversations_used";
  }
  if (governs(location) && poolExhausted(location, today, poolOf(channel))) return "allowance_exhausted";
  return null;
}

function messageFor(location: Location, channel: Channel | undefined): string {
  switch (channel) {
    case "web_voice":
      return "Nobody can take a call through the website just now. Please try again a little later.";
    case "chat":
    case "whatsapp":
      return location.phone
        ? `We can't reply here just now. Please ring us on ${location.phone}.`
        : "We can't reply here just now. Please try again a little later.";
    default:
      return `Thank you for calling ${location.name}. Nobody is able to take your call just now. Please try again a little later.`;
  }
}

export function serviceState(
  venue: Location,
  today: string,
  opts: { enforce?: boolean; channel?: Channel } = {},
): ServiceState {
  let location = venue;
  // On a live channel, let the owner's usage policy act first — record the
  // alerts it raises and add the packs they chose — so a pool that a pack
  // refills is not refused. Charging (Stripe) and telling the owner (email)
  // happen off the call path.
  if (opts.channel && governs(location)) {
    const applied = applyUsagePolicy(location, today, { stripe: stripeEnabled() });
    location = applied.location;
    if (applied.added.length && stripeEnabled()) void settlePacks(location.id).catch((err) => console.error("[packs]", err));
    if (applied.alerts.length) void notifyAlerts(location, applied.alerts).catch((err) => console.error("[usage alerts]", err));
  }
  const lapsed = lapseOf(location, today);
  const enforce = opts.enforce ?? stripeEnabled();
  const refuse = (refused: Refusal): ServiceState => ({
    answering: false,
    lapsed,
    refused,
    callerMessage: messageFor(location, opts.channel),
  });

  if (lapsed && enforce) return refuse(lapsed);
  if (opts.channel && !channelIncluded(location, opts.channel)) return refuse("not_in_plan");
  if (opts.channel && enforce) {
    const unit = unitRefusal(location, today, opts.channel);
    if (unit) return refuse(unit);
  }

  return { answering: true, lapsed };
}

/** One sentence for the owner's dashboard. */
export function lapseSentence(lapsed: Lapse, enforced: boolean): string {
  const what =
    lapsed === "trial_ended"
      ? "Your free trial has ended."
      : lapsed === "trial_minutes_used"
        ? "Your trial's voice minutes are used up."
        : lapsed === "legacy_plan_ended"
          ? "Your original plan's grandfathered period is over."
          : "Your plan was cancelled and the paid period is over.";
  return enforced
    ? `${what} Belline has stopped answering. Choose a plan and it answers again straight away.`
    : `${what} Choose a plan to keep Belline answering.`;
}

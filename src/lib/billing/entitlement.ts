import type { Location } from "../types";
import { getTenant } from "../store";
import { accountFor, isLegacy, periodFor, productsOf } from "./usage";
import { channelsOf, type Channel } from "./plans";
import { stripeEnabled } from "./stripe";

/**
 * Is this venue entitled to be answered — at all, and on this channel?
 *
 * Two different questions with two different answers about strictness.
 *
 * **Lapsing** — a trial that ended, a cancelled period that ran out, a
 * grandfathered plan past its date. Nothing here is enforced while card
 * payments are switched off: stopping a trial customer's phone on day fifteen
 * when the checkout cannot take their card would punish them for our gap.
 * `lapsed` is still reported, so the client book can show who needs a call.
 *
 * **Channels** — a plan that does not include this channel (today only a
 * grandfathered plan, which was never sold WhatsApp). That is enforced always:
 * it is not a gap on our side, and answering a channel nobody pays for spends
 * real money.
 *
 * And the softness that never changes: a paying venue past its allowance is
 * never stopped, and neither is one whose card failed while Stripe retries.
 * The pricing page promises both, and this file is where that promise could
 * quietly break.
 */

export type Lapse = "trial_ended" | "trial_minutes_used" | "cancelled" | "legacy_plan_ended";
export type Refusal = Lapse | "not_in_plan";

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
    const phone = accountFor(location, today)?.usage.channels.find((c) => c.channel === "phone");
    const allowance = sub.trial?.minutes ?? 0;
    if (phone && allowance > 0 && phone.used >= allowance) return "trial_minutes_used";
    return null;
  }

  if (sub.status === "cancelled") {
    // Service runs to the end of the period in which they cancelled.
    const from = (sub.cancelledAt ?? today).slice(0, 10);
    const end = periodFor(sub, from).end;
    return today >= end ? "cancelled" : null;
  }

  if (isLegacy(sub) && sub.grandfatheredUntil && today > sub.grandfatheredUntil) {
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
  location: Location,
  today: string,
  opts: { enforce?: boolean; channel?: Channel } = {},
): ServiceState {
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

  return { answering: true, lapsed };
}

/** One sentence for the owner's dashboard. */
export function lapseSentence(lapsed: Lapse, enforced: boolean): string {
  const what =
    lapsed === "trial_ended"
      ? "Your free trial has ended."
      : lapsed === "trial_minutes_used"
        ? "Your trial's live-call minutes are used up."
        : lapsed === "legacy_plan_ended"
          ? "Your original plan's grandfathered period is over."
          : "Your plan was cancelled and the paid period is over.";
  return enforced
    ? `${what} Belline has stopped answering. Choose a plan and it answers again straight away.`
    : `${what} Choose a plan to keep Belline answering.`;
}

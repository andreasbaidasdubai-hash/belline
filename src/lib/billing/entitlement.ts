import type { Location } from "../types";
import { getTenant } from "../store";
import { accountFor, periodFor } from "./usage";
import { stripeEnabled } from "./stripe";

/**
 * Is this venue still entitled to have its phone answered?
 *
 * Until this existed the trial was decorative. `trial.endsOn` and
 * `trial.minutes` were written at signup and read only by the billing page,
 * so a venue that signed up and never paid was answered for ever, on our
 * vendor bill.
 *
 * Two deliberate softnesses:
 *
 *   Nothing is enforced while card payments are switched off. Stopping a
 *   trial customer's phone on day fifteen when the checkout cannot take their
 *   card would punish them for our gap. `lapsed` is still reported, so the
 *   client book can show who is past their trial and needs a call.
 *
 *   A paying venue is never stopped here — not for going past its allowance,
 *   not for a failed card while Stripe retries. The pricing page promises
 *   both, and this file is where that promise could quietly break.
 */

export type Lapse = "trial_ended" | "trial_minutes_used" | "cancelled";

export interface ServiceState {
  /** Whether a call to this venue should be answered right now. */
  answering: boolean;
  /** Why the venue is past what it has paid for, whether or not that is enforced. */
  lapsed: Lapse | null;
  /** Said to a caller when the line is not answering. Never mentions money. */
  callerMessage?: string;
}

export function lapseOf(location: Location, today: string): Lapse | null {
  const sub = location.subscription;
  // No subscription: seeded fixtures and venues that predate billing.
  if (!sub) return null;
  // Our own lines and prospect demos are ours to pay for and have caps of their own.
  if (location.demo?.enabled || location.prospect || location.internal) return null;
  if (getTenant(location.tenantId)?.internal) return null;

  if (sub.status === "trialing") {
    if (sub.trial && today > sub.trial.endsOn) return "trial_ended";
    const account = accountFor(location, today);
    const allowance = sub.trial?.minutes ?? 0;
    if (account && allowance > 0 && account.usage.minutes >= allowance) return "trial_minutes_used";
    return null;
  }

  if (sub.status === "cancelled") {
    // Service runs to the end of the period in which they cancelled.
    const from = (sub.cancelledAt ?? today).slice(0, 10);
    const end = periodFor(sub, from).end;
    return today >= end ? "cancelled" : null;
  }

  return null;
}

export function serviceState(
  location: Location,
  today: string,
  opts: { enforce?: boolean } = {},
): ServiceState {
  const lapsed = lapseOf(location, today);
  const enforce = opts.enforce ?? stripeEnabled();
  if (!lapsed || !enforce) return { answering: true, lapsed };
  return {
    answering: false,
    lapsed,
    callerMessage: `Thank you for calling ${location.name}. Nobody is able to take your call just now. Please try again a little later.`,
  };
}

/** One sentence for the owner's dashboard. */
export function lapseSentence(lapsed: Lapse, enforced: boolean): string {
  const what =
    lapsed === "trial_ended"
      ? "Your free trial has ended."
      : lapsed === "trial_minutes_used"
        ? "Your trial's live-call minutes are used up."
        : "Your plan was cancelled and the paid period is over.";
  return enforced
    ? `${what} Belline has stopped answering calls. Choose a plan and it answers again straight away.`
    : `${what} Choose a plan to keep Belline answering.`;
}

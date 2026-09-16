import type { Location } from "../types";
import { getTenant } from "../store";
import { accountFor, isPooledTrial, meterFor, periodFor, productsOf } from "./usage";
import { channelsOf, grandfatherExpires, poolOf, type Channel } from "./plans";
import { stripeEnabled } from "./stripe";
import { applyUsagePolicy, governs, markAlertsSent, notifyAlerts, poolExhausted, settlePacks } from "./usage-policy";

/**
 * Is this venue entitled to be answered — at all, and on this channel?
 *
 * Three questions, with different answers about strictness.
 *
 * **Usage caps are cost protection, not billing, and are enforced always** —
 * whether or not card payments are open. A trial's voice minutes used up
 * (`trial_minutes_used`) stops its phone and voice button; its text
 * conversations used up stops its chat and WhatsApp; a 2026-10 pool at 100%
 * that the owner's policy does not refill stops that pool's channels. Every
 * one of those minutes and conversations is paid to our providers, and a free
 * trial that never stops is an open-ended bill.
 *
 * **Lapsing by date** — a trial past its end date, a cancelled period that ran
 * out, an original-ladder plan past its grandfathered date. These are billing,
 * and stay soft while card payments are switched off: stopping a customer by
 * the calendar when the checkout cannot take their card would punish them for
 * our gap. Soft only while usage is inside the caps above. `lapsed` is still
 * reported, so the client book can show who needs a call. A September 2026
 * bundle never lapses.
 *
 * **Units** — on a 2026-10 plan a pool at 100% is decided by the owner's usage
 * policy (billing/usage-policy.ts): a pack is added if they chose packs and it
 * fits their cap; otherwise that pool's channels stop with
 * `allowance_exhausted`. Older products keep the terms they were sold on.
 *
 * **Exempt** — Belline's own venues (loc_belline, the website's "Speak to
 * Belline"), the demo lines (loc_azure, loc_lumiere, loc_meridian), prospect
 * demos and any venue with no subscription are never lapsed and never capped
 * here: they have their own per-call and per-day ceilings (`demo`).
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
    // The usage cap first: it is enforced always, the end date only with card
    // payments open, so a trial past both must report the one that stops it.
    const account = accountFor(location, today);
    // A 2026-10 trial caps pooled voice minutes; an older one, phone minutes.
    const voice = account?.usage.meters.find((m) => m.id === (isPooledTrial(sub) ? "minutes" : "phone"));
    const allowance = sub.trial?.minutes ?? 0;
    if (voice && allowance > 0 && voice.used >= allowance) return "trial_minutes_used";
    if (sub.trial && today > sub.trial.endsOn) return "trial_ended";
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

function trialPastEnd(location: Location, today: string): boolean {
  const sub = location.subscription;
  return Boolean(sub?.status === "trialing" && sub.trial && today > sub.trial.endsOn);
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
    if (applied.alerts.length) {
      // Marked sent only once the email went; otherwise they stay pending and
      // the billing sweep tries again.
      const { id } = location;
      const periodStart = applied.decision.periodStart;
      const alerts = applied.alerts;
      void notifyAlerts(location, alerts)
        .then((sent) => {
          if (sent) markAlertsSent(id, periodStart, alerts);
        })
        .catch((err) => console.error("[usage alerts]", err));
    }
  }
  const lapsed = lapseOf(location, today);
  // `enforce` decides only the date-based lapses. Usage caps are not billing
  // and have no switch: see the note at the top.
  const enforce = opts.enforce ?? stripeEnabled();
  const refuse = (refused: Refusal): ServiceState => ({
    answering: false,
    lapsed,
    refused,
    callerMessage: messageFor(location, opts.channel),
  });

  if (lapsed && (enforce || isUsageCap(lapsed))) {
    // Voice minutes used up stop the voice channels. Chat and WhatsApp draw on
    // the trial's text conversations and keep going while those last (checked
    // below) — unless the trial's end date is also past and that is enforced.
    const textChannel = opts.channel !== undefined && poolOf(opts.channel) === "conversations";
    if (lapsed !== "trial_minutes_used" || !textChannel) return refuse(lapsed);
    if (enforce && trialPastEnd(location, today)) return refuse("trial_ended");
  }
  if (opts.channel && !channelIncluded(location, opts.channel)) return refuse("not_in_plan");
  if (opts.channel) {
    const unit = unitRefusal(location, today, opts.channel);
    if (unit) return refuse(unit);
  }

  return { answering: true, lapsed };
}

/** A lapse that is a usage cap: enforced whether or not card payments are open. */
export function isUsageCap(reason: Refusal): boolean {
  return reason === "trial_minutes_used" || reason === "trial_conversations_used" || reason === "allowance_exhausted";
}

/** Can the owner choose a plan right now? Only with card payments open — otherwise it is a button that cannot be pressed. */
export function canChoosePlan(): boolean {
  return stripeEnabled();
}

/** What the owner does next when card payments are closed and a cap has stopped something. */
const TEAM_WILL_CALL = "Card payments are not open yet, so there is no plan to choose here — the Belline team has been told and will contact you to keep it going.";

/** One sentence for the owner's dashboard. `enforced` is whether Belline has actually stopped. */
export function lapseSentence(lapsed: Lapse, enforced: boolean): string {
  const payments = stripeEnabled();
  if (lapsed === "trial_minutes_used") {
    const what = "Your trial's voice minutes are used up, so Belline has stopped answering calls and the voice button on your website.";
    return payments ? `${what} Choose a plan and it answers again straight away.` : `${what} ${TEAM_WILL_CALL}`;
  }
  const what =
    lapsed === "trial_ended"
      ? "Your free trial has ended."
      : lapsed === "legacy_plan_ended"
        ? "Your original plan's grandfathered period is over."
        : "Your plan was cancelled and the paid period is over.";
  if (enforced) {
    return payments
      ? `${what} Belline has stopped answering. Choose a plan and it answers again straight away.`
      : `${what} Belline has stopped answering. ${TEAM_WILL_CALL}`;
  }
  // Not enforced means card payments are closed: "choose a plan" would be a
  // button that cannot be pressed.
  if (payments) return `${what} Choose a plan to keep Belline answering.`;
  return lapsed === "trial_ended"
    ? `${what} Card payments are not open yet, so Belline keeps answering until the trial's voice minutes or text conversations are used up.`
    : `${what} Payments open soon — Belline keeps answering until then.`;
}

/** The sentence for a trial whose text conversations are used up. Chat and WhatsApp only. */
export function conversationsSentence(): string {
  const what = "Your trial's text conversations are used up, so Belline has stopped replying on your website chat and WhatsApp.";
  return stripeEnabled() ? `${what} Choose a plan and it replies again straight away.` : `${what} ${TEAM_WILL_CALL}`;
}

export interface OwnerNotice {
  /** What happened and what to do, in one or two sentences. */
  sentence: string;
  /** Offer "Choose a plan"? Never while card payments are closed. */
  choosePlan: boolean;
  /** Has Belline actually stopped answering somewhere? */
  stopped: boolean;
}

/**
 * Everything the owner must be told about service stopping or lapsing, for the
 * dashboard. Covers the text-conversation cap too, which is not a lapse (it
 * stops two channels, not the venue) and so used to reach no page at all.
 */
export function ownerNotice(location: Location, today: string): OwnerNotice | null {
  if (exempt(location)) return null;
  const service = serviceState(location, today);
  const conversations = unitRefusal(location, today, "chat") === "trial_conversations_used";
  const choosePlan = canChoosePlan();
  if (service.lapsed === "trial_minutes_used" && conversations) {
    const what = "Your trial's voice minutes and text conversations are all used up, so Belline has stopped answering on every channel.";
    return { sentence: `${what} ${choosePlan ? "Choose a plan and it answers again straight away." : TEAM_WILL_CALL}`, choosePlan, stopped: true };
  }
  if (service.lapsed && conversations && !service.answering) {
    // A date lapse that is enforced already stops everything.
    return { sentence: lapseSentence(service.lapsed, true), choosePlan, stopped: true };
  }
  const lines: string[] = [];
  if (service.lapsed) lines.push(lapseSentence(service.lapsed, !service.answering));
  if (conversations) lines.push(conversationsSentence());
  if (lines.length === 0) return null;
  return { sentence: lines.join(" "), choosePlan, stopped: !service.answering || conversations };
}

/** Does this venue need the team told that a trial cap stopped it while payments are closed? */
export function trialCapReached(location: Location, today: string): Refusal | null {
  if (exempt(location) || location.subscription?.status !== "trialing") return null;
  if (lapseOf(location, today) === "trial_minutes_used") return "trial_minutes_used";
  return unitRefusal(location, today, "chat") === "trial_conversations_used" ? "trial_conversations_used" : null;
}

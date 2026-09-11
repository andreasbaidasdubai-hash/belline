import type { Call, Location, Subscription } from "../types";
import { listCalls } from "../store";
import { callDurationSeconds } from "../calls";
import {
  ANNUAL_MONTHS_FREE,
  aed,
  annualPerMonth,
  planById,
  planFor,
  type Plan,
} from "./plans";

/**
 * Minutes, allowance, overage, and what the invoice will say.
 *
 * The promise on the pricing page is "no surprise invoices", and a promise
 * like that is kept in this file or not at all. Three decisions carry it:
 *
 *   A minute is defined once, here, and the website quotes this definition
 *   rather than paraphrasing it.
 *
 *   The invoice is the plan fee and nothing else. There is no metered charge
 *   anywhere in this product: an allowance that runs out is a prompt to move
 *   up a plan, never a second number on a bill. The moment anything else can
 *   appear in `dueNow`, the promise stops being true.
 *
 *   Where the rule is genuinely ambiguous, the customer wins. Calls we broke
 *   are not counted; the projection rounds toward telling somebody sooner;
 *   and going past the allowance never stops the phone being answered.
 */

// ---------------------------------------------------------------------------
// What counts as a minute
// ---------------------------------------------------------------------------

/**
 * Billable minutes for one call.
 *
 * Connected talking time, from the moment Belline answers to the moment the
 * call ends, rounded up to the next whole minute. Deliberately excluded:
 *
 *   Test-console calls. They cost us money with three vendors, but nobody
 *   should be charged for trying their own agent out before pointing a real
 *   line at it.
 *
 *   Demo-line calls. Strangers kicking the tyres are our expense, not a
 *   venue's.
 *
 *   Calls that ended in `failed` — the status a call is given when the server
 *   stopped underneath it. The caller may well have been served, but a rule
 *   that bills for our own crash is the wrong rule at any volume.
 */
export function billableMinutes(call: Call): number {
  if (call.isDemo) return 0;
  if (call.channel !== "phone") return 0;
  if (call.status !== "completed") return 0;
  if (!call.endedAt) return 0;

  const seconds = callDurationSeconds(call);
  if (seconds <= 0) return 0;
  return Math.ceil(seconds / 60);
}

/** The definition above, in the words the website uses. Quoted, not rewritten. */
export const MINUTE_DEFINITION =
  "A voice minute is time Belline spends on a live call with your caller — " +
  "from the moment it answers to the moment the call ends — rounded up to the " +
  "next whole minute. Calls you make from your own test console do not count, " +
  "and neither do calls cut short by a fault on our side.";

// ---------------------------------------------------------------------------
// Billing periods
// ---------------------------------------------------------------------------

export interface Period {
  /** Inclusive, YYYY-MM-DD. */
  start: string;
  /** Exclusive, YYYY-MM-DD. */
  end: string;
  /** 0 for the first period since the subscription began. */
  index: number;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function parse(date: string): { y: number; m: number; d: number } {
  const [y, m, d] = date.split("-").map(Number);
  return { y, m: m - 1, d };
}

function fmt(y: number, m: number, d: number): string {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * The k-th period boundary after the anchor date.
 *
 * The anchor *day* is remembered rather than clamped permanently: a
 * subscription that began on the 31st bills on the 28th in February and goes
 * back to the 31st in March. Clamping once and carrying the clamped day
 * forward silently moves every future invoice, which is the kind of bug that
 * is found a year later by a customer with a spreadsheet.
 */
function boundary(anchor: { y: number; m: number; d: number }, k: number): string {
  const months = anchor.m + k;
  const y = anchor.y + Math.floor(months / 12);
  const m = ((months % 12) + 12) % 12;
  return fmt(y, m, Math.min(anchor.d, daysInMonth(y, m)));
}

/** The billing period a given date falls inside. */
export function periodFor(sub: Subscription, onDate: string): Period {
  const anchor = parse(sub.startedOn);
  const today = parse(onDate);

  let k = (today.y - anchor.y) * 12 + (today.m - anchor.m);
  // Before this month's billing day: still inside the previous period.
  if (today.d < Math.min(anchor.d, daysInMonth(today.y, today.m))) k -= 1;
  if (k < 0) k = 0;

  return { index: k, start: boundary(anchor, k), end: boundary(anchor, k + 1) };
}

// ---------------------------------------------------------------------------
// Usage and the bill
// ---------------------------------------------------------------------------

export interface Usage {
  period: Period;
  calls: number;
  minutes: number;
  /**
   * Minutes this period includes: the plan's allowance, or the trial's.
   * `null` on an unlimited plan — not a very large number, because a very
   * large number renders as a progress bar and unlimited has no bar.
   */
  included: number | null;
  /** Minutes past the allowance. Nothing is charged for them; see `upgrade`. */
  overBy: number;
  /** The plan they should be on, when this one no longer fits. */
  upgrade: Plan | null;
  /** Share of the allowance used. 0 when unlimited. */
  fraction: number;
  /**
   * Minutes this period will end on if the rest of it runs at the same pace.
   *
   * The whole point of showing it is to tell somebody *before* the invoice
   * rather than after, so it is deliberately not conservative.
   */
  projectedMinutes: number;
}

export interface Bill {
  /** What the plan costs for this period. */
  planFee: number;
  /** True on the annual cycle: the plan fee was paid up front for the year. */
  prepaid: boolean;
  /**
   * What will actually be invoiced at the end of this period, in fils.
   *
   * This is the plan fee and nothing else, ever. There is no metered charge
   * in this product — going past the allowance is a prompt to move up a plan,
   * not a line on a bill. It is the whole of what "no surprise invoices"
   * means, and the moment a second number can appear here it stops being true.
   */
  dueNow: number;
  state: Subscription["status"];
}

export interface Account {
  plan: Plan;
  subscription: Subscription;
  usage: Usage;
  bill: Bill;
  /** Plain sentences for the dashboard. Never a bare number. */
  notes: string[];
}

/** The venue's own calendar day, which is the only one its invoice means. */
function dayOf(call: Call, location: Location): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: location.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(call.startedAt));
}

/** How far through the period we are, 0 to 1. Never 0, so pace never divides by it. */
function elapsed(period: Period, today: string): number {
  const start = Date.parse(`${period.start}T00:00:00Z`);
  const end = Date.parse(`${period.end}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`) + 86_400_000; // through the end of today
  return Math.min(1, Math.max((now - start) / (end - start), 1 / 31));
}

export function accountFor(location: Location, today: string): Account | null {
  const sub = location.subscription;
  if (!sub) return null;

  const plan = planById(sub.planId);
  const period = periodFor(sub, today);

  const calls = listCalls(location.id).filter((c) => {
    const day = dayOf(c, location);
    return day >= period.start && day < period.end && billableMinutes(c) > 0;
  });

  const minutes = calls.reduce((n, c) => n + billableMinutes(c), 0);

  const trialing = sub.status === "trialing";
  const included = trialing ? (sub.trial?.minutes ?? 0) : plan.includedMinutes;

  const overBy = included === null ? 0 : Math.max(0, minutes - included);
  const share = elapsed(period, today);
  const projectedMinutes = Math.round(minutes / share);

  const usage: Usage = {
    period,
    calls: calls.length,
    minutes,
    included,
    overBy,
    // Recommended off the projection, not off today's total: telling somebody
    // to move up on the last day of the period is telling them too late.
    upgrade: trialing ? null : planFor(Math.max(minutes, projectedMinutes), plan.id),
    fraction: included && included > 0 ? minutes / included : 0,
    projectedMinutes,
  };

  const planFee = trialing
    ? 0
    : sub.cycle === "annual"
      ? annualPerMonth(plan)
      : plan.monthly;

  const prepaid = !trialing && sub.cycle === "annual";

  const bill: Bill = {
    planFee,
    prepaid,
    // Prepaid means the year is already paid: nothing further this period.
    dueNow: prepaid || trialing ? 0 : planFee,
    state: sub.status,
  };

  return { plan, subscription: sub, usage, bill, notes: notesFor(plan, sub, usage, bill) };
}

/**
 * The sentences the dashboard shows.
 *
 * Written here rather than in the page because they are the same commitment
 * the pricing page makes, and two copies of a promise drift apart.
 */
function notesFor(plan: Plan, sub: Subscription, usage: Usage, bill: Bill): string[] {
  const notes: string[] = [];

  if (sub.status === "trialing") {
    const allowance = usage.included ?? 0;
    const left = Math.max(0, allowance - usage.minutes);
    notes.push(
      left > 0
        ? `Trial: ${left} of ${allowance} minutes left. Nothing is charged during the trial.`
        : `Trial: all ${allowance} minutes used. Nothing has been charged — pick a plan to keep going.`,
    );
    return notes;
  }

  if (sub.status === "cancelled") {
    notes.push("Cancelled. Belline keeps answering until the end of this period, then stops.");
  }

  if (usage.included === null) {
    notes.push("Unlimited minutes. Nothing to watch.");
  } else if (usage.overBy > 0) {
    // Deliberately not an apology and not a threat. The phone keeps being
    // answered — a receptionist that stops answering because of an invoice is
    // not a receptionist — and the answer is a bigger plan, not a bigger bill.
    notes.push(
      `${usage.overBy} minutes past the ${usage.included} on ${plan.name}. ` +
        `Calls are still being answered and nothing extra has been charged.`,
    );
  } else if (usage.projectedMinutes > usage.included) {
    notes.push(
      `On this pace you will finish the period around ${usage.projectedMinutes} minutes, ` +
        `past the ${usage.included} on ${plan.name}. Told now rather than at the end.`,
    );
  } else if (usage.fraction >= 0.8) {
    notes.push(`${Math.round(usage.fraction * 100)}% of the allowance used.`);
  }

  if (usage.upgrade) {
    notes.push(
      `${usage.upgrade.name} would cover it — ` +
        `${usage.upgrade.includedMinutes === null ? "unlimited minutes" : `${usage.upgrade.includedMinutes} minutes`}, ` +
        `${aed(usage.upgrade.monthly)} a month.`,
    );
  }

  if (bill.prepaid) {
    notes.push(
      `Paid up front for the year — ${ANNUAL_MONTHS_FREE} months free — so there is ` +
        `nothing to invoice this period.`,
    );
  }

  return notes;
}

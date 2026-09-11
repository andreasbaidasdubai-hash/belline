import type { Call, Location, Subscription } from "../types";
import { listCalls } from "../store";
import { callDurationSeconds } from "../calls";
import {
  ANNUAL_MONTHS_FREE,
  FILS,
  annualPerMonth,
  planById,
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
 *   Every sum is integer fils. Money that has been through a float is money
 *   that eventually prints a wrong number on a document a customer keeps.
 *
 *   Where the rule is genuinely ambiguous, the customer wins. Calls we broke
 *   are not billed; the projection rounds toward telling somebody sooner.
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
  /** Minutes this period includes: the plan's allowance, or the trial's. */
  included: number;
  overageMinutes: number;
  /** Share of the allowance used. Above 1 means there is overage. */
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
  overage: number;
  /** What will actually be invoiced at the end of this period, in fils. */
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

  // A trial's allowance is its own, and it is the whole of what is on offer —
  // there is no overage to charge somebody who has not yet agreed to pay.
  const trialing = sub.status === "trialing";
  const included = trialing ? (sub.trial?.minutes ?? 0) : plan.includedMinutes;

  const overageMinutes = Math.max(0, minutes - included);
  const share = elapsed(period, today);

  const usage: Usage = {
    period,
    calls: calls.length,
    minutes,
    included,
    overageMinutes,
    fraction: included > 0 ? minutes / included : 0,
    projectedMinutes: Math.round(minutes / share),
  };

  const planFee = trialing
    ? 0
    : sub.cycle === "annual"
      ? annualPerMonth(plan)
      : plan.monthly;

  const overage = trialing ? 0 : overageMinutes * plan.overagePerMinute;
  const prepaid = !trialing && sub.cycle === "annual";

  const bill: Bill = {
    planFee,
    prepaid,
    overage,
    dueNow: prepaid ? overage : planFee + overage,
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
    const left = Math.max(0, usage.included - usage.minutes);
    notes.push(
      left > 0
        ? `Trial: ${left} of ${usage.included} minutes left. Nothing is charged during the trial.`
        : `Trial: all ${usage.included} minutes used. Nothing has been charged — pick a plan to keep going.`,
    );
    return notes;
  }

  if (sub.status === "cancelled") {
    notes.push("Cancelled. Belline keeps answering until the end of this period, then stops.");
  }

  if (usage.overageMinutes > 0) {
    notes.push(
      `${usage.overageMinutes} minutes past the ${usage.included} included, ` +
        `at ${(plan.overagePerMinute / FILS).toFixed(2)} a minute.`,
    );
  } else if (usage.projectedMinutes > usage.included) {
    notes.push(
      `On this pace you will finish the period around ${usage.projectedMinutes} minutes, ` +
        `which is past the ${usage.included} included. Told now rather than on the invoice.`,
    );
  } else if (usage.fraction >= 0.8) {
    notes.push(`${Math.round(usage.fraction * 100)}% of the allowance used.`);
  }

  if (bill.prepaid) {
    notes.push(
      `The annual cycle is paid up front — ${ANNUAL_MONTHS_FREE} months free — so only ` +
        `overage is invoiced during the year.`,
    );
  }

  return notes;
}

/**
 * Warm-up: how many a new mailbox may send today.
 *
 * A brand-new address that sends thirty cold emails on its first morning is a
 * spam trap with extra steps. Mailbox providers score a sending identity on
 * volume history as much as on content, and the only way to build that history
 * is slowly, from a handful a day, over weeks.
 *
 * The schedule below starts at five and roughly doubles each week to the
 * mailbox's own ceiling. It is deliberately a pure function of the start date
 * and today's date — no counters to drift, no state to reset by accident, and
 * a number anybody can check by hand.
 */

import type { SendingMailbox } from "./store";

/**
 * Cap by week of warm-up, week 1 being the first seven days.
 *
 * The last entry repeats: after week six a mailbox is on its own daily cap.
 */
export const WARMUP_WEEKS = [5, 10, 16, 22, 28, 30] as const;

export function dayNumber(startedOn: string, today: string): number {
  const start = Date.parse(`${startedOn.slice(0, 10)}T00:00:00Z`);
  const now = Date.parse(`${today.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(now)) return 0;
  return Math.floor((now - start) / 86_400_000);
}

/**
 * Today's ceiling for one mailbox.
 *
 * `0` when it is paused, when warm-up has not been started, or when the date
 * is before the start — all of which mean "not yet", never "no limit".
 */
export function warmupCap(mailbox: SendingMailbox, today: string): number {
  if (mailbox.status === "paused") return 0;
  if (!mailbox.warmupStartedOn) return 0;
  const day = dayNumber(mailbox.warmupStartedOn, today);
  if (day < 0) return 0;
  const week = Math.floor(day / 7);
  const scheduled = week >= WARMUP_WEEKS.length ? mailbox.dailyCap : WARMUP_WEEKS[week];
  return Math.max(0, Math.min(scheduled, mailbox.dailyCap));
}

/** The week's number for display: 1-based, capped at "warm". */
export function warmupWeek(mailbox: SendingMailbox, today: string): number | "warm" {
  if (!mailbox.warmupStartedOn) return 1;
  const week = Math.floor(dayNumber(mailbox.warmupStartedOn, today) / 7);
  return week >= WARMUP_WEEKS.length ? "warm" : week + 1;
}

/** The whole timetable for one mailbox, for the settings screen. */
export function warmupSchedule(mailbox: SendingMailbox): { week: number; cap: number }[] {
  return WARMUP_WEEKS.map((cap, i) => ({ week: i + 1, cap: Math.min(cap, mailbox.dailyCap) }));
}

import type { DateStr, Minutes, TimeRange } from "./types";

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** `YYYY-MM-DD` for "now" in the given IANA timezone. */
export function todayIn(timezone: string): DateStr {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Minutes from local midnight for "now" in the given timezone. */
export function nowMinutesIn(timezone: string): Minutes {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

/**
 * Weekday index (0 = Sunday) for a `YYYY-MM-DD` string.
 *
 * Parsed as UTC on purpose: a bare date string has no timezone, and using
 * UTC keeps the weekday stable no matter where the process runs.
 */
export function weekdayOf(date: DateStr): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function addDays(date: DateStr, days: number): DateStr {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: DateStr, to: DateStr): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

// Not a type predicate on purpose: `DateStr` is an alias for `string`, so
// narrowing on it would leave the false branch as `never`.
export function isValidDate(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`));
}

/** 1170 -> "19:30" */
export function minutesToClock(m: Minutes): string {
  const h = Math.floor(m / 60) % 24;
  const min = m % 60;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** 1170 -> "7:30 PM" — what the agent should say out loud. */
export function minutesToSpoken(m: Minutes): string {
  const h24 = Math.floor(m / 60) % 24;
  const min = m % 60;
  const period = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return min === 0
    ? `${h12} ${period}`
    : `${h12}:${String(min).padStart(2, "0")} ${period}`;
}

/**
 * Accepts "19:30", "7:30pm", "7pm", "1930", "7.30 pm". Returns null when the
 * input is not a time at all, so callers can surface a real error instead of
 * silently booking midnight.
 */
export function parseClock(input: string): Minutes | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, "");
  let m = s.match(/^(\d{1,2})[:.](\d{2})(am|pm)?$/);
  if (m) {
    let h = Number(m[1]);
    const min = Number(m[2]);
    if (m[3] === "pm" && h < 12) h += 12;
    if (m[3] === "am" && h === 12) h = 0;
    return h < 24 && min < 60 ? h * 60 + min : null;
  }
  m = s.match(/^(\d{1,2})(am|pm)$/);
  if (m) {
    let h = Number(m[1]);
    if (m[2] === "pm" && h < 12) h += 12;
    if (m[2] === "am" && h === 12) h = 0;
    return h < 24 ? h * 60 : null;
  }
  m = s.match(/^(\d{2})(\d{2})$/);
  if (m) {
    const h = Number(m[1]);
    const min = Number(m[2]);
    return h < 24 && min < 60 ? h * 60 + min : null;
  }
  return null;
}

/**
 * Resolve the loose date forms a caller might produce. The agent is told to
 * send ISO dates, but "tomorrow" and weekday names slip through often enough
 * that guessing here beats an error the caller has to hear.
 */
export function resolveDate(input: string, timezone: string): DateStr | null {
  const raw = input.trim().toLowerCase();
  if (isValidDate(raw)) return raw;

  const today = todayIn(timezone);
  if (raw === "today" || raw === "tonight") return today;
  if (raw === "tomorrow") return addDays(today, 1);
  if (raw === "day after tomorrow") return addDays(today, 2);

  const weekdayMatch = raw.match(
    /^(next\s+|this\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/,
  );
  if (weekdayMatch) {
    const target = DAY_NAMES.findIndex(
      (d) => d.toLowerCase() === weekdayMatch[2],
    );
    const current = weekdayOf(today);
    let delta = (target - current + 7) % 7;
    // "monday" said on a Monday means the next one, not today.
    if (delta === 0) delta = 7;
    if (weekdayMatch[1]?.trim() === "next" && delta < 7) delta += 7;
    return addDays(today, delta);
  }

  return null;
}

/** "Friday 12 September" — for confirmations read back to the caller. */
export function dateToSpoken(date: DateStr, timezone?: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const label = `${DAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]}`;
  if (!timezone) return label;
  const today = todayIn(timezone);
  if (date === today) return `today, ${label}`;
  if (date === addDays(today, 1)) return `tomorrow, ${label}`;
  return label;
}

export function rangesOverlap(a: TimeRange, b: TimeRange): boolean {
  return a.start < b.end && b.start < a.end;
}

export function withinAnyRange(range: TimeRange, ranges: TimeRange[]): boolean {
  return ranges.some((r) => range.start >= r.start && range.end <= r.end);
}

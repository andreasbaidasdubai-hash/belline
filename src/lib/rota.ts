import type { Booking, Location, StaffMember, TimeRange } from "./types";
import { listBookings } from "./store";
import { staffWorkingRanges } from "./booking/salon";
import { addDays, weekdayOf } from "./time";

/**
 * The rota: who works when, week by week.
 *
 * A person has usual weekly hours; a rota entry for a date replaces them for
 * that day (an empty entry is a day off), and time off takes a stretch out of
 * whatever they are working. The booking engine already reads all three —
 * this is the screen and the rules for changing them, and for telling the
 * manager which existing bookings a change leaves stranded.
 */

export interface RotaDay {
  date: string;
  /** What they actually work that day, after time off. */
  working: TimeRange[];
  /** Where the hours came from. */
  source: "usual" | "rota" | "off";
  timeOff: { start: number; end: number }[];
  bookings: number;
}

export interface RotaRow {
  id: string;
  name: string;
  days: RotaDay[];
}

export function weekRota(location: Location, weekStart: string): RotaRow[] {
  const salon = location.salon;
  if (!salon) return [];
  const dates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const bookings = listBookings({ locationId: location.id }).filter((b) => b.status === "confirmed" && dates.includes(b.date));
  return salon.staff.map((person) => ({
    id: person.id,
    name: person.name,
    days: dates.map((date) => {
      const shift = person.shifts?.find((s) => s.date === date);
      const usual = person.hours[weekdayOf(date)] ?? [];
      return {
        date,
        working: staffWorkingRanges(person, date),
        source: shift ? (shift.ranges.length ? "rota" : "off") : usual.length ? "usual" : "off",
        timeOff: person.timeOff.filter((t) => t.date === date).map((t) => ({ start: t.start, end: t.end })),
        bookings: bookings.filter((b) => b.staffId === person.id && b.date === date).length,
      };
    }),
  }));
}

export type RotaChange =
  | { kind: "shift"; staffId: string; date: string; ranges: TimeRange[] }
  | { kind: "usual"; staffId: string; date: string }
  | { kind: "time_off"; staffId: string; date: string; start: number; end: number }
  | { kind: "remove_time_off"; staffId: string; date: string; start: number; end: number };

function validRanges(ranges: TimeRange[]): boolean {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  return sorted.every((r, i) => Number.isInteger(r.start) && Number.isInteger(r.end) && r.start >= 0 && r.end <= 1440 && r.end > r.start && (i === 0 || r.start >= sorted[i - 1].end));
}

/** Apply one change. Pure: returns the venue it would become, or why not. */
export function applyRotaChange(location: Location, change: RotaChange): { ok: true; location: Location; person: StaffMember } | { ok: false; error: string } {
  const salon = location.salon;
  if (!salon) return { ok: false, error: "The rota is for salons and clinics." };
  const person = salon.staff.find((s) => s.id === change.staffId);
  if (!person) return { ok: false, error: "Unknown person." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(change.date)) return { ok: false, error: "Which day?" };

  let next: StaffMember = person;
  const otherShifts = (person.shifts ?? []).filter((s) => s.date !== change.date);
  switch (change.kind) {
    case "shift":
      if (!validRanges(change.ranges)) return { ok: false, error: "Check the hours — a finish is before a start, or two overlap." };
      next = { ...person, shifts: [...otherShifts, { date: change.date, ranges: [...change.ranges].sort((a, b) => a.start - b.start) }] };
      break;
    case "usual":
      next = { ...person, shifts: otherShifts.length ? otherShifts : undefined };
      break;
    case "time_off":
      if (!validRanges([{ start: change.start, end: change.end }])) return { ok: false, error: "Time off needs a start before its end." };
      next = { ...person, timeOff: [...person.timeOff, { date: change.date, start: change.start, end: change.end }] };
      break;
    case "remove_time_off":
      next = { ...person, timeOff: person.timeOff.filter((t) => !(t.date === change.date && t.start === change.start && t.end === change.end)) };
      break;
  }
  // Shifts in the past are history, not planning; keep the list from growing for ever.
  if (next.shifts) next = { ...next, shifts: next.shifts.slice(-400) };

  return {
    ok: true,
    person: next,
    location: { ...location, salon: { ...salon, staff: salon.staff.map((s) => (s.id === person.id ? next : s)) } },
  };
}

/** Confirmed bookings for this person on this day that fall outside what they now work. */
export function strandedBookings(location: Location, person: StaffMember, date: string): Booking[] {
  const working = staffWorkingRanges(person, date);
  return listBookings({ locationId: location.id }).filter(
    (b) => b.status === "confirmed" && b.staffId === person.id && b.date === date && !working.some((r) => r.start <= b.startMin && b.endMin <= r.end),
  );
}

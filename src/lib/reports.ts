import type { Booking, Call, Location } from "./types";
import { listBookings, listCalls } from "./store";
import { listGuests, normalisePhone } from "./guests";
import { callDurationSeconds } from "./calls";
import { minutesToClock } from "./time";

/**
 * How the business did over a stretch of days.
 *
 * Bookings by the day they happen, calls by the day they came in. Split the
 * way an owner asks the questions: how much did Belline take versus the desk,
 * how many did not show, what sold, who was busy, when is the rush.
 */

export interface Report {
  from: string;
  to: string;
  bookings: {
    total: number;
    upcoming: number;
    completed: number;
    cancelled: number;
    noShows: number;
    /** No-shows over bookings whose day has passed and were not cancelled. */
    noShowRate: number | null;
    byBelle: number;
    atDesk: number;
    covers: number;
  };
  revenue: number;
  calls: { total: number; minutes: number; bookedOnCall: number; byChannel: Record<string, number>; byOutcome: Record<string, number> };
  customers: { total: number; new: number; returning: number };
  byWeekday: number[];
  byHour: { hour: number; count: number }[];
  services: { name: string; count: number; revenue: number }[];
  staff: { name: string; count: number; revenue: number }[];
}

const TEST_CHANNELS = new Set<Call["channel"]>(["browser"]);

function inRange(date: string, from: string, to: string) {
  return date >= from && date <= to;
}

function priceOf(location: Location, b: Booking): number {
  const prices = new Map((location.salon?.services ?? []).map((s) => [s.id, s.price]));
  return (b.serviceIds ?? []).reduce((n, id) => n + (prices.get(id) ?? 0), 0);
}

export function buildReport(location: Location, from: string, to: string, today: string): Report {
  const all = listBookings({ locationId: location.id });
  const bookings = all.filter((b) => inRange(b.date, from, to));
  const live = bookings.filter((b) => b.status !== "cancelled" && b.status !== "no_show");
  const passed = bookings.filter((b) => b.date < today && b.status !== "cancelled");
  const noShows = bookings.filter((b) => b.status === "no_show").length;

  const calls = listCalls(location.id).filter((c) => !c.isDemo && !TEST_CHANNELS.has(c.channel) && inRange(c.startedAt.slice(0, 10), from, to));
  const byChannel: Record<string, number> = {};
  const byOutcome: Record<string, number> = {};
  for (const c of calls) {
    byChannel[c.channel] = (byChannel[c.channel] ?? 0) + 1;
    const outcome = c.outcome ?? "unfinished";
    byOutcome[outcome] = (byOutcome[outcome] ?? 0) + 1;
  }

  const byWeekday = [0, 0, 0, 0, 0, 0, 0];
  const hours = new Map<number, number>();
  for (const b of live) {
    byWeekday[new Date(`${b.date}T12:00:00Z`).getUTCDay()]++;
    const h = Math.floor(b.startMin / 60);
    hours.set(h, (hours.get(h) ?? 0) + 1);
  }

  const services = new Map<string, { name: string; count: number; revenue: number }>();
  const staff = new Map<string, { name: string; count: number; revenue: number }>();
  for (const b of live) {
    for (const id of b.serviceIds ?? []) {
      const svc = location.salon?.services.find((s) => s.id === id);
      if (!svc) continue;
      const row = services.get(id) ?? { name: svc.name, count: 0, revenue: 0 };
      row.count++;
      row.revenue += svc.price;
      services.set(id, row);
    }
    const person = location.salon?.staff.find((s) => s.id === b.staffId);
    if (person) {
      const row = staff.get(person.id) ?? { name: person.name, count: 0, revenue: 0 };
      row.count++;
      row.revenue += priceOf(location, b);
      staff.set(person.id, row);
    }
  }

  // New: a customer whose very first booking falls in the range.
  const firstSeen = new Map<string, string>();
  for (const b of all) {
    const key = normalisePhone(b.guestPhone);
    if (key.length < 6) continue;
    const seen = firstSeen.get(key);
    if (!seen || b.date < seen) firstSeen.set(key, b.date);
  }
  const inRangeCustomers = new Set(bookings.map((b) => normalisePhone(b.guestPhone)).filter((k) => k.length >= 6));
  const newCustomers = [...inRangeCustomers].filter((k) => inRange(firstSeen.get(k) ?? "", from, to)).length;

  return {
    from,
    to,
    bookings: {
      total: bookings.length,
      upcoming: bookings.filter((b) => b.status === "confirmed" && b.date >= today).length,
      completed: bookings.filter((b) => b.status === "completed" || (b.status === "confirmed" && b.date < today)).length,
      cancelled: bookings.filter((b) => b.status === "cancelled").length,
      noShows,
      noShowRate: passed.length ? noShows / passed.length : null,
      byBelle: bookings.filter((b) => b.source !== "manual").length,
      atDesk: bookings.filter((b) => b.source === "manual").length,
      covers: live.reduce((n, b) => n + (b.partySize ?? 0), 0),
    },
    revenue: live.reduce((n, b) => n + priceOf(location, b), 0),
    calls: {
      total: calls.length,
      minutes: Math.round(calls.reduce((n, c) => n + callDurationSeconds(c), 0) / 60),
      bookedOnCall: calls.filter((c) => c.outcome === "booking_created").length,
      byChannel,
      byOutcome,
    },
    customers: { total: inRangeCustomers.size, new: newCustomers, returning: inRangeCustomers.size - newCustomers },
    byWeekday,
    byHour: [...hours.entries()].map(([hour, count]) => ({ hour, count })).sort((a, b) => a.hour - b.hour),
    services: [...services.values()].sort((a, b) => b.count - a.count),
    staff: [...staff.values()].sort((a, b) => b.count - a.count),
  };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

export function csv(rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? "" : String(v);
    // A leading = + - @ is a formula to a spreadsheet; neutralise it.
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

export type ExportKind = "bookings" | "calls" | "customers";

export function exportCsv(location: Location, kind: ExportKind, from: string, to: string): string {
  if (kind === "calls") {
    const calls = listCalls(location.id)
      .filter((c) => !c.isDemo && !TEST_CHANNELS.has(c.channel) && inRange(c.startedAt.slice(0, 10), from, to))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    return csv([
      ["started", "channel", "from", "minutes", "outcome", "summary", "booking"],
      ...calls.map((c) => [c.startedAt, c.channel, c.from, Math.ceil(callDurationSeconds(c) / 60), c.outcome ?? "", c.summary ?? "", c.bookingId ?? ""]),
    ]);
  }
  if (kind === "customers") {
    return csv([
      ["name", "phone", "visits", "cancellations", "no_shows", "last_visit", "usually", "notes"],
      ...listGuests(location).map((g) => [g.name, g.phone, g.visits, g.cancellations, g.noShows, g.lastVisit ?? "", g.usual ?? "", g.notes.join("; ")]),
    ]);
  }
  const services = new Map((location.salon?.services ?? []).map((s) => [s.id, s.name]));
  const staff = new Map((location.salon?.staff ?? []).map((s) => [s.id, s.name]));
  const bookings = listBookings({ locationId: location.id })
    .filter((b) => inRange(b.date, from, to))
    .sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin);
  return csv([
    ["reference", "date", "time", "guest", "phone", "email", "status", "source", location.restaurant ? "covers" : "services", "with", "price", "notes"],
    ...bookings.map((b) => [
      b.ref,
      b.date,
      minutesToClock(b.startMin),
      b.guestName,
      b.guestPhone,
      b.guestEmail ?? "",
      b.status,
      b.source === "manual" ? "desk" : `belle:${b.source}`,
      location.restaurant ? b.partySize ?? "" : (b.serviceIds ?? []).map((id) => services.get(id)).filter(Boolean).join(" + "),
      b.staffId ? staff.get(b.staffId) ?? "" : "",
      priceOf(location, b) || "",
      b.notes,
    ]),
  ]);
}

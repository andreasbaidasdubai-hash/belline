import type { Booking, DateStr, Location } from "./types";
// `Booking` is used in the grouping index below as well as in the record.
import { listBookings } from "./store";
import { chainDuration, resolveServices } from "./booking/salon";
import { dateToSpoken, todayIn } from "./time";

/**
 * Guest recognition.
 *
 * This is the piece the incumbent booking systems do not have and cannot
 * easily get: a record built from who actually rings. It is deliberately a
 * *projection* over bookings rather than a second store — there is no guest
 * table to fall out of sync, and every venue that has taken one booking
 * already has guest history whether they asked for it or not.
 *
 * The briefing goes into the volatile half of the system prompt at call
 * start, not behind a tool call. A returning guest should hear "welcome back"
 * in the greeting, and a tool round-trip would put it three seconds too late.
 */

export interface GuestRecord {
  phone: string;
  name: string;
  visits: number;
  cancellations: number;
  noShows: number;
  lastVisit?: DateStr;
  upcoming: Booking[];
  /** What they usually book, derived from history. */
  usual?: string;
  /** Distinct notes left on past bookings — allergies, seating, occasions. */
  notes: string[];
}

/**
 * Last nine digits, so +971 50 123 4567 and 050 123 4567 are the same person.
 * Matching on the full string fails constantly in a country where half the
 * numbers are given with an international prefix and half without.
 */
export function normalisePhone(phone: string): string {
  return phone.replace(/\D/g, "").slice(-9);
}

function mostCommon<T>(values: T[]): T | undefined {
  const counts = new Map<string, { value: T; n: number }>();
  for (const value of values) {
    const key = JSON.stringify(value);
    const entry = counts.get(key) ?? { value, n: 0 };
    entry.n++;
    counts.set(key, entry);
  }
  return [...counts.values()].sort((a, b) => b.n - a.n)[0]?.value;
}

function describeUsual(location: Location, history: Booking[]): string | undefined {
  if (history.length < 2) return undefined;

  if (location.vertical === "restaurant") {
    const size = mostCommon(history.map((b) => b.partySize).filter(Boolean));
    return size ? `usually a table for ${size}` : undefined;
  }

  const serviceKey = mostCommon(history.map((b) => (b.serviceIds ?? []).join(",")));
  const staffId = mostCommon(history.map((b) => b.staffId).filter(Boolean));
  if (!serviceKey) return undefined;

  const { services } = resolveServices(location.salon!, serviceKey.split(","));
  if (services.length === 0) return undefined;
  const staff = location.salon!.staff.find((s) => s.id === staffId);
  const { price } = chainDuration(services);
  return `usually ${services.map((s) => s.name).join(" + ")}${
    staff ? ` with ${staff.name}` : ""
  } (${location.currency} ${price})`;
}

/** Everything known about the person on the other end, or null for a stranger. */
export function recallGuest(location: Location, phone: string): GuestRecord | null {
  const key = normalisePhone(phone);
  if (key.length < 6) return null;

  const all = listBookings({ locationId: location.id }).filter(
    (b) => normalisePhone(b.guestPhone) === key,
  );
  return buildGuest(location, phone, all);
}

/**
 * Assemble one guest from bookings already known to be theirs.
 *
 * Split out so the guest list can group the whole book in a single pass
 * instead of re-scanning it once per caller — that difference is the whole
 * gap between a page that loads and one that does not.
 */
function buildGuest(
  location: Location,
  phone: string,
  all: Booking[],
): GuestRecord | null {
  if (all.length === 0) return null;

  const today = todayIn(location.timezone);
  const past = all.filter((b) => b.date < today);
  // The most recent booking has the most current spelling of their name, and
  // the number as they actually gave it rather than the match key.
  const latest = all.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

  return {
    phone: latest?.guestPhone ?? phone,
    name: latest?.guestName ?? "",
    visits: past.filter((b) => b.status === "completed" || b.status === "confirmed").length,
    cancellations: all.filter((b) => b.status === "cancelled").length,
    noShows: all.filter((b) => b.status === "no_show").length,
    lastVisit: past
      .filter((b) => b.status !== "cancelled")
      .sort((a, b) => b.date.localeCompare(a.date))[0]?.date,
    upcoming: all
      .filter((b) => b.date >= today && b.status === "confirmed")
      .sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin),
    usual: describeUsual(
      location,
      all.filter((b) => b.status !== "cancelled"),
    ),
    notes: [...new Set(all.map((b) => b.notes.trim()).filter(Boolean))].slice(-4),
  };
}

/**
 * The guest paragraph dropped into the system prompt.
 *
 * Written as instructions rather than a data dump, because a model handed a
 * table of facts will recite them. The venue wants "lovely to hear from you
 * again" — not "I see you have visited four times and cancelled once".
 */
export function guestBriefing(location: Location, guest: GuestRecord): string {
  const lines: string[] = [
    `This caller is not new. Their number matches ${guest.name || "an existing guest"}.`,
  ];

  if (guest.visits > 0) {
    lines.push(
      `They have booked ${guest.visits} time${guest.visits === 1 ? "" : "s"} before${
        guest.lastVisit ? `, most recently ${dateToSpoken(guest.lastVisit, location.timezone)}` : ""
      }.`,
    );
  }
  if (guest.usual) lines.push(`They ${guest.usual}. Offer it, do not assume it.`);

  if (guest.upcoming.length > 0) {
    const next = guest.upcoming[0];
    lines.push(
      `They already have a booking on ${dateToSpoken(next.date, location.timezone)} (reference ${next.ref}). If they are calling about it, you already know which one they mean — do not make them recite the reference.`,
    );
  }

  if (guest.notes.length > 0) {
    lines.push(`Notes from previous visits: ${guest.notes.join("; ")}.`);
  }

  // A guest who no-shows twice is a commercial problem, but saying so on the
  // phone is not the agent's job.
  if (guest.noShows >= 2) {
    lines.push(
      `They have not turned up ${guest.noShows} times. Take the booking normally and say nothing about it; the team will decide whether to ask for a card.`,
    );
  }

  lines.push(
    `Greet them by name and make it sound like recognition, not a database lookup. Never read these facts back as a list.`,
  );

  return lines.join(" ");
}

/**
 * Guest list for the dashboard, most recently active first.
 *
 * One pass to bucket the book by caller, then one build per caller. The
 * obvious version — collect the distinct numbers, then call `recallGuest` for
 * each — re-reads every booking once per guest, which is quadratic and takes
 * most of a second on a venue with a year of history.
 */
export function listGuests(location: Location): GuestRecord[] {
  const byPhone = new Map<string, Booking[]>();

  for (const booking of listBookings({ locationId: location.id })) {
    const key = normalisePhone(booking.guestPhone);
    if (key.length < 6) continue;
    const bucket = byPhone.get(key);
    if (bucket) bucket.push(booking);
    else byPhone.set(key, [booking]);
  }

  const guests: GuestRecord[] = [];
  for (const [key, bookings] of byPhone) {
    const guest = buildGuest(location, key, bookings);
    if (guest) guests.push(guest);
  }

  return guests.sort((a, b) => (b.lastVisit ?? "").localeCompare(a.lastVisit ?? ""));
}

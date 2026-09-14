import type { Booking, Call, Location } from "./types";
import { listBookings, listCalls, saveBooking } from "./store";
import { listGuests, normalisePhone, type GuestRecord } from "./guests";
import { checkShape } from "./leads/email";

/**
 * One customer, as a profile rather than a row.
 *
 * Still a projection over bookings and calls — there is no customer table to
 * fall out of step with the book. A profile is everything those already know
 * about one phone number, in one place: every visit, every call, what they
 * spend, what they usually have, and the notes the team has left.
 */

export function guestKey(phone: string): string {
  return normalisePhone(phone);
}

/** Name, number or email, partial and forgiving. */
export function searchGuests(location: Location, raw: string): GuestRecord[] {
  const q = raw.trim().toLowerCase();
  const all = listGuests(location);
  if (!q) return all;
  const digits = q.replace(/\D/g, "");
  const emailsByKey = new Map<string, string>();
  for (const b of listBookings({ locationId: location.id })) {
    if (b.guestEmail) emailsByKey.set(normalisePhone(b.guestPhone), b.guestEmail.toLowerCase());
  }
  return all.filter(
    (g) =>
      g.name.toLowerCase().includes(q) ||
      (digits.length >= 3 && g.phone.replace(/\D/g, "").includes(digits)) ||
      (emailsByKey.get(normalisePhone(g.phone)) ?? "").includes(q),
  );
}

export interface GuestProfile {
  key: string;
  guest: GuestRecord;
  email?: string;
  /** Newest first. */
  bookings: Booking[];
  calls: Call[];
  /** At list price, for visits that happened. Salons and clinics only. */
  spend: number;
}

export function guestProfile(location: Location, key: string): GuestProfile | null {
  if (key.length < 6) return null;
  const guest = listGuests(location).find((g) => normalisePhone(g.phone) === key);
  if (!guest) return null;

  const bookings = listBookings({ locationId: location.id })
    .filter((b) => normalisePhone(b.guestPhone) === key)
    .sort((a, b) => b.date.localeCompare(a.date) || b.startMin - a.startMin);
  const calls = listCalls(location.id)
    .filter((c) => normalisePhone(c.from) === key)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  const prices = new Map((location.salon?.services ?? []).map((s) => [s.id, s.price]));
  const today = new Date().toISOString().slice(0, 10);
  const spend = bookings
    .filter((b) => b.date < today && (b.status === "confirmed" || b.status === "completed"))
    .reduce((n, b) => n + (b.serviceIds ?? []).reduce((m, id) => m + (prices.get(id) ?? 0), 0), 0);

  const email = bookings.find((b) => b.guestEmail)?.guestEmail;
  return { key, guest, email, bookings, calls, spend };
}

/**
 * Correct a customer's name or email everywhere it appears.
 *
 * Applied to every booking under their number, past and future — a guest
 * whose name was misheard once should not stay misspelt on every visit that
 * followed.
 */
export function updateGuest(
  location: Location,
  key: string,
  changes: { name?: string; email?: string },
): { ok: true; updated: number } | { ok: false; error: string } {
  const name = changes.name?.trim();
  if (changes.name !== undefined && !name) return { ok: false, error: "A customer needs a name." };
  let email: string | undefined;
  if (changes.email !== undefined && changes.email.trim()) {
    const shape = checkShape(changes.email);
    if (!shape.valid || !shape.email) return { ok: false, error: shape.reason ?? "That email does not look right." };
    email = shape.email;
  }

  const mine = listBookings({ locationId: location.id }).filter((b) => normalisePhone(b.guestPhone) === key);
  if (!mine.length || key.length < 6) return { ok: false, error: "No customer with that number." };

  let updated = 0;
  const at = new Date().toISOString();
  for (const booking of mine) {
    const next = {
      ...booking,
      guestName: name ?? booking.guestName,
      guestEmail: changes.email === undefined ? booking.guestEmail : email,
    };
    if (next.guestName !== booking.guestName || next.guestEmail !== booking.guestEmail) {
      saveBooking({ ...next, updatedAt: at });
      updated++;
    }
  }
  return { ok: true, updated };
}

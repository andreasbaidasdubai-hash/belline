import type { Booking, Location, Minutes, WaitlistEntry } from "./types";
import { id, listWaitlist, saveWaitlistEntry, getWaitlistEntry } from "./store";
import { findAvailability } from "./booking";
import { isRestaurant } from "./verticals";
import { minutesToSpoken } from "./time";

/**
 * The people who wanted a time that was gone.
 *
 * A full Friday is not a lost caller — it is a caller nobody wrote down. Every
 * booking system has a waitlist; the difference here is what happens next. A
 * cancellation at five o'clock normally means somebody has to notice it, look
 * up who wanted that slot, and ring them before the evening is wasted. Belline
 * can do all three itself, which is the whole argument for having reception
 * that never goes home.
 *
 * Two rules shape everything below.
 *
 * Order is by when they asked. Not by party size, not by spend, not by
 * anything clever — whoever rang first gets the table, because any other rule
 * is one a guest would be upset to learn about.
 *
 * A match must be a real booking. It is checked against the same engine as
 * everything else, so a slot offered to a waiting guest is a slot they can
 * actually have. Offering one that turns out not to exist is worse than
 * never ringing.
 */

/** How long an offer is theirs before the next person is told. */
const OFFER_HOLD_MINUTES = 30;

export interface JoinInput {
  locationId: string;
  guestName: string;
  guestPhone: string;
  date: string;
  earliestMin: Minutes;
  latestMin: Minutes;
  partySize?: number;
  serviceIds?: string[];
  staffId?: string;
  notes?: string;
  callId?: string;
}

export function join(input: JoinInput): WaitlistEntry {
  const now = new Date().toISOString();

  // Somebody who rings twice about the same evening is one entry, not two.
  // Both would be rung back, and the second call is the awkward one.
  const existing = listWaitlist({ locationId: input.locationId, date: input.date }).find(
    (w) =>
      w.status === "waiting" &&
      digits(w.guestPhone) === digits(input.guestPhone) &&
      digits(input.guestPhone).length > 0,
  );

  const entry: WaitlistEntry = {
    id: existing?.id ?? id("wait"),
    locationId: input.locationId,
    guestName: input.guestName.trim(),
    guestPhone: input.guestPhone.trim(),
    date: input.date,
    earliestMin: Math.min(input.earliestMin, input.latestMin),
    latestMin: Math.max(input.earliestMin, input.latestMin),
    partySize: input.partySize,
    serviceIds: input.serviceIds,
    staffId: input.staffId,
    status: "waiting",
    notes: input.notes?.trim() ?? "",
    callId: input.callId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  return saveWaitlistEntry(entry);
}

function digits(phone: string): string {
  return phone.replace(/\D/g, "").slice(-10);
}

export interface Match {
  entry: WaitlistEntry;
  /** A slot they can actually have, verified against the engine. */
  startMin: Minutes;
  /** What to say when ringing them. */
  say: string;
}

/**
 * Who is waiting for a slot that just became free.
 *
 * Called after a cancellation or a move. Returns matches in the order the
 * guests asked, each with a start time checked against real availability —
 * so a match is an offer that can be honoured rather than a hopeful guess.
 */
export function matchesFor(location: Location, date: string): Match[] {
  const waiting = listWaitlist({ locationId: location.id, date, status: "waiting" });
  if (waiting.length === 0) return [];

  const out: Match[] = [];

  for (const entry of waiting) {
    const slots = findAvailability(location, {
      locationId: location.id,
      date,
      preferredMin: entry.earliestMin,
      partySize: entry.partySize,
      serviceIds: entry.serviceIds,
      staffId: entry.staffId,
    });

    const usable = slots.find(
      (slot) => slot.startMin >= entry.earliestMin && slot.startMin <= entry.latestMin,
    );
    if (!usable) continue;

    out.push({
      entry,
      startMin: usable.startMin,
      say: offerWording(location, entry, usable.startMin),
    });
  }
  return out;
}

function offerWording(location: Location, entry: WaitlistEntry, startMin: Minutes): string {
  const when = minutesToSpoken(startMin);
  if (isRestaurant(location)) {
    const covers = entry.partySize ?? 2;
    return `${entry.guestName} — a table for ${covers} has come free at ${when}. Would they still like it?`;
  }
  const services = location.salon?.services ?? [];
  const names = (entry.serviceIds ?? [])
    .map((sid) => services.find((s) => s.id === sid)?.name)
    .filter(Boolean)
    .join(" and ");
  return `${entry.guestName} — ${names || "an appointment"} has come free at ${when}. Would they still like it?`;
}

/** Mark that the guest has been told about a slot. */
export function markOffered(entryId: string): WaitlistEntry | null {
  const entry = getWaitlistEntry(entryId);
  if (!entry) return null;
  return saveWaitlistEntry({
    ...entry,
    status: "offered",
    offeredAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

/** They took it. */
export function markConverted(entryId: string, booking: Booking): WaitlistEntry | null {
  const entry = getWaitlistEntry(entryId);
  if (!entry) return null;
  return saveWaitlistEntry({
    ...entry,
    status: "converted",
    bookingId: booking.id,
    updatedAt: new Date().toISOString(),
  });
}

export function markCancelled(entryId: string): WaitlistEntry | null {
  const entry = getWaitlistEntry(entryId);
  if (!entry) return null;
  return saveWaitlistEntry({
    ...entry,
    status: "cancelled",
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Put a stale offer back on the list.
 *
 * An offer nobody answered cannot hold a table indefinitely — the slot has to
 * go to the next person, or the waitlist quietly becomes a way of losing two
 * bookings instead of one.
 */
export function releaseStaleOffers(locationId: string): number {
  const cutoff = Date.now() - OFFER_HOLD_MINUTES * 60_000;
  let released = 0;

  for (const entry of listWaitlist({ locationId, status: "offered" })) {
    if (!entry.offeredAt || new Date(entry.offeredAt).getTime() > cutoff) continue;
    saveWaitlistEntry({
      ...entry,
      status: "waiting",
      offeredAt: undefined,
      updatedAt: new Date().toISOString(),
    });
    released++;
  }
  return released;
}

/** Everyone still waiting on a venue, soonest date first. */
export function openEntries(locationId: string): WaitlistEntry[] {
  return listWaitlist({ locationId })
    .filter((w) => w.status === "waiting" || w.status === "offered")
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
}

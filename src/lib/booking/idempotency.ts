import crypto from "node:crypto";
import type { Booking, Location } from "../types";
import { listBookings } from "../store";

/**
 * Making a booking twice.
 *
 * A retried tool call, a caller repeating themselves, a webhook delivered
 * twice, a network timeout on a request that actually succeeded — every one
 * of these ends with the same booking made twice, and a restaurant that finds
 * two tables held for the same six people at eight o'clock stops trusting the
 * system permanently. It is the failure that loses a customer for good, and
 * unlike most failures it cannot be apologised away afterwards: the table was
 * already gone.
 *
 * The defence is a key derived from what the booking *is* rather than from
 * the request that carried it. Two requests describing the same guest, in the
 * same place, at the same time, for the same thing, are the same booking —
 * whatever the transport did. That holds even when the caller genuinely says
 * it twice, which is the case a client-generated request id misses entirely.
 *
 * The window matters. Held open forever it would refuse a guest who really
 * does want the same table next week; too short and a slow retry slips
 * through. Same day, same slot is the honest reading of "the same booking".
 */

export interface BookingIdentity {
  locationId: string;
  date: string;
  startMin: number;
  guestPhone: string;
  guestName: string;
  /** Party size for a restaurant, the service list for a diary. */
  what: string;
}

/**
 * A stable fingerprint of the booking itself.
 *
 * Names and phone numbers are normalised because "Andreas" and "andreas ",
 * and "+44 20 7946 0000" and "02079460000", are the same person saying the
 * same thing — and on a phone line, which is where these come from, both
 * spellings of each will happen.
 */
export function bookingKey(identity: BookingIdentity): string {
  const phone = identity.guestPhone.replace(/\D/g, "").slice(-10);
  const name = identity.guestName.trim().toLowerCase().replace(/\s+/g, " ");
  return crypto
    .createHash("sha256")
    .update(
      [identity.locationId, identity.date, identity.startMin, phone, name, identity.what].join("|"),
    )
    .digest("hex")
    .slice(0, 24);
}

/** How the booking is described for fingerprinting. */
export function describeWhat(input: {
  partySize?: number;
  serviceIds?: string[];
}): string {
  if (input.partySize !== undefined) return `party:${input.partySize}`;
  return `services:${[...(input.serviceIds ?? [])].sort().join(",")}`;
}

/**
 * An existing booking that is the same booking as the one about to be made.
 *
 * Cancelled bookings do not count: a guest who cancelled and rang back to
 * rebook the same table means it, and refusing them would be a worse bug than
 * the one this prevents.
 */
export function findDuplicate(
  location: Location,
  identity: BookingIdentity,
): Booking | undefined {
  const key = bookingKey(identity);
  return listBookings({ locationId: location.id }).find(
    (b) => b.status === "confirmed" && b.idempotencyKey === key,
  );
}

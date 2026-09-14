import crypto from "node:crypto";
import type { Location } from "./types";
import { listBookings, listCalls } from "./store";

/**
 * Has anything changed since the page was drawn?
 *
 * A fingerprint of the bookings and calls across the venues somebody can see,
 * cheap enough to ask for every few seconds. The dashboard polls it and
 * re-renders only when it moves — so a booking Belle takes on the phone
 * appears on the calendar without anyone pressing reload.
 */

export interface LiveStamp {
  stamp: string;
  /** The most recent booking Belle took (not one made at the desk), if any. */
  latestFromBelle: { id: string; locationId: string; guestName: string; date: string; startMin: number; createdAt: string } | null;
}

export function liveStamp(locations: Location[]): LiveStamp {
  const hash = crypto.createHash("sha1");
  let latest: LiveStamp["latestFromBelle"] = null;

  for (const location of locations) {
    const bookings = listBookings({ locationId: location.id });
    const calls = listCalls(location.id);
    let newestBooking = "";
    for (const b of bookings) {
      const at = (b as { updatedAt?: string }).updatedAt ?? b.createdAt ?? "";
      if (at > newestBooking) newestBooking = at;
      if (b.source !== "manual" && b.createdAt && (!latest || b.createdAt > latest.createdAt)) {
        latest = { id: b.id, locationId: location.id, guestName: b.guestName, date: b.date, startMin: b.startMin, createdAt: b.createdAt };
      }
    }
    const newestCall = calls.reduce((n, c) => ((c.endedAt ?? c.startedAt) > n ? (c.endedAt ?? c.startedAt) : n), "");
    hash.update(`${location.id}:${bookings.length}:${newestBooking}:${calls.length}:${newestCall};`);
  }

  return { stamp: hash.digest("hex").slice(0, 16), latestFromBelle: latest };
}

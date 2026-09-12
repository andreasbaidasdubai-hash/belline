import crypto from "node:crypto";
import type { Booking, DateStr, Location, Minutes, Slot } from "../types";

/**
 * A slot kept back while somebody decides.
 *
 * The failure this exists for is specific to a phone agent and does not happen
 * to a web booking form. The agent offers three times, the caller says "let me
 * just check with my husband", and for the next forty seconds that table is
 * still, as far as the book is concerned, free. A second line rings. The
 * second agent offers the same table. Both callers say yes. One of them is
 * going to arrive to a room with no table in it, and the venue will remember
 * that for longer than it remembers anything else the product did.
 *
 * Every serious reservation system holds the slot the moment it is quoted —
 * OpenTable and Resy both do, which is why a table vanishes from the grid
 * while you are typing your name. This is that, sized for a conversation:
 *
 *   - **In memory, not in the store.** A hold lives about ninety seconds and
 *     is written and thrown away several times per call. Persisting that to
 *     JSON would thrash the disk on the one path where latency is audible, and
 *     a hold lost to a restart is harmless — the slot simply becomes free
 *     again, which is where it was heading anyway.
 *   - **Shaped like a booking.** `asBookings` hands the availability engines
 *     something they already know how to avoid, so neither restaurant.ts nor
 *     salon.ts has to learn what a hold is.
 *   - **Keyed by the call.** A caller's own hold must never block that same
 *     caller's booking, which is the bug every naive implementation of this
 *     ships with.
 */

export interface Hold {
  id: string;
  locationId: string;
  date: DateStr;
  startMin: Minutes;
  /** Includes any buffer — this is the diary block, not the guest-facing end. */
  endMin: Minutes;
  tableIds?: string[];
  staffId?: string;
  resourceIds?: string[];
  /** The conversation holding it. Its own holds never stand in its way. */
  callId?: string;
  /** Epoch ms. Swept lazily on every read. */
  expiresAt: number;
}

/**
 * Long enough for "let me ask", short enough that an abandoned call does not
 * hold a Saturday table hostage. A caller who needs longer than this is a
 * caller the agent should be talking to, and every mention of a time re-holds.
 */
export const DEFAULT_HOLD_SECONDS = 90;

// Pinned to the global for the same reason the store is: the dev server
// re-evaluates modules while the custom websocket server keeps running in the
// same process, and two copies of this map would defeat the entire point.
const globalRef = globalThis as unknown as { __bellineHolds?: Map<string, Hold> };

function holds(): Map<string, Hold> {
  globalRef.__bellineHolds ??= new Map();
  return globalRef.__bellineHolds;
}

function sweep(at = Date.now()): void {
  const map = holds();
  for (const [id, held] of map) {
    if (held.expiresAt <= at) map.delete(id);
  }
}

export interface HoldInput {
  locationId: string;
  date: DateStr;
  startMin: Minutes;
  endMin: Minutes;
  tableIds?: string[];
  staffId?: string;
  resourceIds?: string[];
  callId?: string;
  seconds?: number;
}

/**
 * Keep this slot back.
 *
 * Re-holding for the same call and the same slot extends the existing hold
 * rather than stacking a second one, so an agent that mentions a time three
 * times in a sentence does not leave three holds behind when the call drops.
 */
export function holdSlot(input: HoldInput): Hold {
  sweep();
  const expiresAt = Date.now() + (input.seconds ?? DEFAULT_HOLD_SECONDS) * 1000;

  if (input.callId) {
    for (const existing of holds().values()) {
      if (
        existing.callId === input.callId &&
        existing.locationId === input.locationId &&
        existing.date === input.date &&
        existing.startMin === input.startMin
      ) {
        existing.endMin = input.endMin;
        existing.tableIds = input.tableIds;
        existing.staffId = input.staffId;
        existing.resourceIds = input.resourceIds;
        existing.expiresAt = expiresAt;
        return existing;
      }
    }
  }

  const held: Hold = {
    id: `hd_${crypto.randomBytes(6).toString("hex")}`,
    locationId: input.locationId,
    date: input.date,
    startMin: input.startMin,
    endMin: input.endMin,
    tableIds: input.tableIds,
    staffId: input.staffId,
    resourceIds: input.resourceIds,
    callId: input.callId,
    expiresAt,
  };
  holds().set(held.id, held);
  return held;
}

/** Hold whatever a quoted slot would consume. */
export function holdForSlot(
  location: Location,
  slot: Slot,
  opts: { callId?: string; seconds?: number } = {},
): Hold {
  return holdSlot({
    locationId: location.id,
    date: slot.date,
    startMin: slot.startMin,
    endMin: slot.endMin,
    tableIds: slot.tableIds,
    staffId: slot.staffId,
    resourceIds: slot.resourceIds ?? (slot.resourceId ? [slot.resourceId] : undefined),
    callId: opts.callId,
    seconds: opts.seconds,
  });
}

export function release(holdId: string): void {
  holds().delete(holdId);
}

/**
 * Drop everything one conversation was holding.
 *
 * Called when a call ends, however it ends. Without it a dropped line leaves
 * the last quoted table unavailable until the timer runs out, which on a busy
 * Friday is the difference between taking a booking and not.
 */
export function releaseCall(callId: string): number {
  let dropped = 0;
  for (const [id, held] of holds()) {
    if (held.callId === callId) {
      holds().delete(id);
      dropped++;
    }
  }
  return dropped;
}

export function activeHolds(locationId: string, date?: DateStr): Hold[] {
  sweep();
  return [...holds().values()].filter(
    (h) => h.locationId === locationId && (!date || h.date === date),
  );
}

/**
 * Holds as the availability engines see them: bookings that are not quite real
 * yet. `exceptCallId` is the caller's own conversation, whose holds must be
 * invisible to it or it will be told its own table has gone.
 */
export function asBookings(
  locationId: string,
  date: DateStr,
  exceptCallId?: string,
): Booking[] {
  const now = new Date().toISOString();
  return activeHolds(locationId, date)
    .filter((h) => !exceptCallId || h.callId !== exceptCallId)
    .map((h) => ({
      id: h.id,
      ref: "HOLD",
      locationId: h.locationId,
      // The engines only branch on the venue's vertical, never on this one.
      vertical: "restaurant" as const,
      status: "confirmed" as const,
      date: h.date,
      startMin: h.startMin,
      endMin: h.endMin,
      guestName: "Held",
      guestPhone: "",
      notes: "",
      tableIds: h.tableIds,
      staffId: h.staffId,
      resourceId: h.resourceIds?.[0],
      resourceIds: h.resourceIds,
      source: "voice" as const,
      createdAt: now,
      updatedAt: now,
    }));
}

/** Testing and process teardown. Never call this on a live line. */
export function clearHolds(): void {
  holds().clear();
}

import type { Booking, Location, Table } from "./types";
import { listBookings } from "./store";

/**
 * The restaurant floor, right now.
 *
 * A host does not think in a list of reservations; they think in tables. So
 * this places every table on a plan and says what is happening at it: free,
 * a party due in the next half hour, a party that has arrived and is waiting,
 * seated, running late, or blocked out. The same bookings the calendar draws,
 * the same progress the booking panel writes.
 */

export type TableStatus = "free" | "soon" | "due" | "late" | "arrived" | "seated" | "blocked";

export interface FloorBooking {
  id: string;
  ref: string;
  guestName: string;
  partySize: number;
  startMin: number;
  endMin: number;
  arrived: boolean;
  seated: boolean;
  notes: string;
}

export interface FloorTable {
  id: string;
  name: string;
  section: string;
  minSeats: number;
  maxSeats: number;
  x: number;
  y: number;
  shape: "round" | "square";
  /** Whether the position was set by somebody, rather than laid out by default. */
  placed: boolean;
  status: TableStatus;
  label: string;
  current: FloorBooking | null;
  next: FloorBooking | null;
  blockReason?: string;
}

export const PLAN_WIDTH = 1000;
const CELL_X = 150;
const CELL_Y = 130;
const PER_ROW = 6;
/** A party more than this late is "late" rather than "due". */
const GRACE_MIN = 15;
/** A party this soon is shown as coming, so the table is not given away. */
const SOON_MIN = 30;

/** Default positions: sections top to bottom, tables across in rows. */
export function defaultLayout(tables: Table[]): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  const sections = [...new Set(tables.map((t) => t.section || ""))];
  let top = 60;
  for (const section of sections) {
    const inSection = tables.filter((t) => (t.section || "") === section);
    inSection.forEach((t, i) => {
      out.set(t.id, { x: 90 + (i % PER_ROW) * CELL_X, y: top + Math.floor(i / PER_ROW) * CELL_Y });
    });
    top += Math.ceil(inSection.length / PER_ROW) * CELL_Y + 60;
  }
  return out;
}

function lite(b: Booking): FloorBooking {
  return {
    id: b.id,
    ref: b.ref,
    guestName: b.guestName,
    partySize: b.partySize ?? 0,
    startMin: b.startMin,
    endMin: b.endMin,
    arrived: Boolean(b.service?.arrivedAt),
    seated: Boolean(b.service?.seatedAt),
    notes: b.notes,
  };
}

export function floorState(location: Location, date: string, nowMin: number): FloorTable[] {
  const config = location.restaurant;
  if (!config) return [];
  const defaults = defaultLayout(config.tables);
  const bookings = listBookings({ locationId: location.id }).filter(
    (b) => b.date === date && (b.status === "confirmed" || b.status === "completed"),
  );

  return config.tables.map((table) => {
    const mine = bookings
      .filter((b) => (b.tableIds ?? []).includes(table.id))
      .sort((a, b) => a.startMin - b.startMin);
    const fallback = defaults.get(table.id) ?? { x: 90, y: 60 };
    const block = (config.blocks ?? []).find(
      (b) => b.date === date && b.tableIds.includes(table.id) && b.startMin <= nowMin && nowMin < b.endMin,
    );

    // Someone physically at the table wins over anything the clock says.
    const seated = mine.find((b) => b.status === "confirmed" && b.service?.seatedAt && !b.service?.leftAt);
    const waiting = mine.find((b) => b.status === "confirmed" && b.service?.arrivedAt && !b.service?.seatedAt);
    const now = mine.find((b) => b.status === "confirmed" && !b.service?.arrivedAt && b.startMin <= nowMin && nowMin < b.endMin);
    const upcoming = mine.find((b) => b.status === "confirmed" && b.startMin > nowMin);

    let status: TableStatus = "free";
    let label = "Free";
    let current: Booking | undefined;
    if (seated) {
      status = "seated";
      current = seated;
      label = `Seated · until ${clock(seated.endMin)}`;
    } else if (waiting) {
      status = "arrived";
      current = waiting;
      label = "Arrived — waiting to be seated";
    } else if (now) {
      current = now;
      const late = nowMin - now.startMin;
      status = late > GRACE_MIN ? "late" : "due";
      label = late > GRACE_MIN ? `${late} min late` : `Due at ${clock(now.startMin)}`;
    } else if (block) {
      status = "blocked";
      label = block.reason || "Blocked";
    } else if (upcoming && upcoming.startMin - nowMin <= SOON_MIN) {
      status = "soon";
      label = `Booked at ${clock(upcoming.startMin)}`;
    } else if (upcoming) {
      label = `Free until ${clock(upcoming.startMin)}`;
    }

    const next = mine.find((b) => b.status === "confirmed" && b.startMin > nowMin && b.id !== current?.id);
    return {
      id: table.id,
      name: table.name,
      section: table.section,
      minSeats: table.minSeats,
      maxSeats: table.maxSeats,
      x: table.layout?.x ?? fallback.x,
      y: table.layout?.y ?? fallback.y,
      shape: table.layout?.shape ?? (table.maxSeats <= 2 ? "round" : "square"),
      placed: Boolean(table.layout),
      status,
      label,
      current: current ? lite(current) : null,
      next: next ? lite(next) : null,
      blockReason: block?.reason,
    };
  });
}

/** Apply dragged positions to the room's tables. Unknown ids are ignored. */
export function applyLayout(
  location: Location,
  positions: { id: string; x: number; y: number; shape?: "round" | "square" }[],
): Location {
  if (!location.restaurant) return location;
  const byId = new Map(positions.map((p) => [p.id, p]));
  const clamp = (v: number, max: number) => Math.round(Math.max(0, Math.min(max, Number(v) || 0)));
  return {
    ...location,
    restaurant: {
      ...location.restaurant,
      tables: location.restaurant.tables.map((t) => {
        const p = byId.get(t.id);
        return p ? { ...t, layout: { x: clamp(p.x, PLAN_WIDTH), y: clamp(p.y, 4000), shape: p.shape ?? t.layout?.shape } } : t;
      }),
    },
  };
}

function clock(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

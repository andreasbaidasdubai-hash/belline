import type { Booking, Location } from "../types";
import { saveBooking } from "../store";
import { checkShape } from "../leads/email";
import { createBooking, describeBookingShort, modifyBooking } from "./index";

/**
 * Taking and changing bookings at the desk.
 *
 * Every change still goes through the booking engine — the same rules the
 * phone line obeys, lifted only where they exist to stop the agent
 * over-promising (see `staffOverride`). What this adds is the part a
 * receptionist needs and the engine never did: several services on one
 * booking, the guest's email, and editing the guest's own details without
 * moving the appointment.
 */

export interface DeskInput {
  date?: string;
  startMin?: number;
  staffId?: string | null;
  serviceIds?: string[];
  partySize?: number;
  notes?: string;
  guestName?: string;
  guestPhone?: string;
  guestEmail?: string;
  overbook?: boolean;
}

export type DeskResult =
  | { ok: true; booking: Booking; summary: string; duplicate?: boolean }
  | { ok: false; error: string; alternatives: number[] };

function email(raw: string | undefined): { ok: true; value?: string } | { ok: false; error: string } {
  const value = (raw ?? "").trim();
  if (!value) return { ok: true, value: undefined };
  const shape = checkShape(value);
  return shape.valid && shape.email ? { ok: true, value: shape.email } : { ok: false, error: shape.reason ?? "That email does not look right." };
}

export function createFromDesk(location: Location, input: DeskInput): DeskResult {
  const name = (input.guestName ?? "").trim();
  if (!name) return { ok: false, error: "A name, at least.", alternatives: [] };
  if (!input.date || typeof input.startMin !== "number") return { ok: false, error: "When?", alternatives: [] };
  const mail = email(input.guestEmail);
  if (!mail.ok) return { ok: false, error: mail.error, alternatives: [] };
  const restaurant = location.vertical === "restaurant";
  if (!restaurant && !(input.serviceIds ?? []).length) return { ok: false, error: "Choose at least one service.", alternatives: [] };

  const result = createBooking(location, {
    date: input.date,
    startMin: Math.round(input.startMin),
    guestName: name,
    guestPhone: (input.guestPhone ?? "").trim(),
    guestEmail: mail.value,
    notes: (input.notes ?? "").trim(),
    partySize: restaurant ? Math.max(1, Math.round(input.partySize ?? 2)) : undefined,
    serviceIds: restaurant ? undefined : input.serviceIds,
    staffId: restaurant ? undefined : input.staffId || undefined,
    source: "manual",
    overbook: input.overbook === true,
    staffOverride: true,
  });

  if (!result.ok) {
    return { ok: false, error: result.detail, alternatives: result.alternatives.slice(0, 4).map((s) => s.startMin) };
  }
  // The engine takes an email only where the venue requires one; at the desk
  // it is simply more contact detail, so it is kept either way.
  const booking = mail.value && !result.booking.guestEmail ? saveBooking({ ...result.booking, guestEmail: mail.value }) : result.booking;
  return { ok: true, booking, summary: describeBookingShort(location, booking), duplicate: result.duplicate };
}

export function updateFromDesk(location: Location, booking: Booking, input: DeskInput): DeskResult {
  if (booking.locationId !== location.id) return { ok: false, error: "Unknown booking.", alternatives: [] };
  if (booking.status !== "confirmed") return { ok: false, error: "That booking is no longer on, so it cannot be changed.", alternatives: [] };

  const restaurant = location.vertical === "restaurant";
  const mail = email(input.guestEmail);
  if (!mail.ok) return { ok: false, error: mail.error, alternatives: [] };
  if (input.guestName !== undefined && !input.guestName.trim()) return { ok: false, error: "The booking needs a name.", alternatives: [] };
  if (!restaurant && input.serviceIds !== undefined && input.serviceIds.length === 0) {
    return { ok: false, error: "A booking needs at least one service.", alternatives: [] };
  }

  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const scheduleChanged =
    (input.date !== undefined && input.date !== booking.date) ||
    (input.startMin !== undefined && Math.round(input.startMin) !== booking.startMin) ||
    (!restaurant && input.staffId !== undefined && (input.staffId || undefined) !== booking.staffId) ||
    (!restaurant && input.serviceIds !== undefined && !same(input.serviceIds, booking.serviceIds ?? [])) ||
    (restaurant && input.partySize !== undefined && input.partySize !== booking.partySize);

  let current = booking;
  if (scheduleChanged || (input.notes !== undefined && input.notes.trim() !== booking.notes)) {
    const result = modifyBooking(location, booking, {
      date: input.date,
      startMin: input.startMin === undefined ? undefined : Math.round(input.startMin),
      staffId: restaurant ? undefined : input.staffId || undefined,
      serviceIds: restaurant ? undefined : input.serviceIds,
      partySize: restaurant ? input.partySize : undefined,
      notes: input.notes === undefined ? undefined : input.notes.trim(),
      staffOverride: true,
    });
    if (!result.ok) {
      return { ok: false, error: result.detail, alternatives: result.alternatives.slice(0, 4).map((s) => s.startMin) };
    }
    current = result.booking;
  }

  const guest = {
    guestName: input.guestName === undefined ? current.guestName : input.guestName.trim(),
    guestPhone: input.guestPhone === undefined ? current.guestPhone : input.guestPhone.trim(),
    guestEmail: input.guestEmail === undefined ? current.guestEmail : mail.value,
  };
  if (guest.guestName !== current.guestName || guest.guestPhone !== current.guestPhone || guest.guestEmail !== current.guestEmail) {
    current = saveBooking({ ...current, ...guest, updatedAt: new Date().toISOString() });
  }
  return { ok: true, booking: current, summary: describeBookingShort(location, current) };
}

import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { canSeeLocation } from "@/lib/auth";
import { getLocation } from "@/lib/store";
import { createBooking, describeBookingShort } from "@/lib/booking";
import { isRestaurant } from "@/lib/verticals";

export const dynamic = "force-dynamic";

/**
 * Take a booking from the calendar.
 *
 * A receptionist with somebody at the desk works forwards from a gap: they
 * see three o'clock is free and put the person in it. That is the opposite of
 * how a form works, and it is why every booking system worth using lets you
 * click the hole.
 *
 * Straight through the same engine as the phone line, so a walk-in cannot be
 * put somewhere a caller could not. If the slot has gone in the seconds since
 * the page rendered, this says so and offers the alternatives.
 */
export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const body = (await request.json()) as {
    locationId?: string;
    date?: string;
    startMin?: number;
    columnId?: string;
    guestName?: string;
    guestPhone?: string;
    partySize?: number;
    serviceIds?: string[];
    notes?: string;
  };

  const location = body.locationId ? getLocation(body.locationId) : undefined;
  if (!location) return NextResponse.json({ error: "Unknown venue" }, { status: 404 });
  if (!canSeeLocation(auth.user, location.id)) {
    return NextResponse.json({ error: "Not your venue" }, { status: 403 });
  }

  if (!body.date || typeof body.startMin !== "number") {
    return NextResponse.json({ error: "When?" }, { status: 400 });
  }
  if (!body.guestName?.trim()) {
    return NextResponse.json({ error: "A name, at least." }, { status: 400 });
  }

  const result = createBooking(location, {
    date: body.date,
    startMin: Math.round(body.startMin),
    guestName: body.guestName.trim(),
    // Taken at the desk, so a number is not always available. The booking
    // engine treats an empty one as unknown rather than inventing one.
    guestPhone: (body.guestPhone ?? "").trim(),
    notes: body.notes?.trim() || "",
    partySize: isRestaurant(location) ? (body.partySize ?? 2) : undefined,
    serviceIds: isRestaurant(location) ? undefined : body.serviceIds,
    // A diary column is the person; a restaurant's tables are the engine's to
    // assign, as with a move.
    staffId: isRestaurant(location) ? undefined : body.columnId,
    source: "manual",
  });

  if (!result.ok) {
    return NextResponse.json(
      {
        error: result.detail,
        reason: result.reason,
        alternatives: result.alternatives.slice(0, 4).map((slot) => slot.startMin),
      },
      { status: 409 },
    );
  }

  return NextResponse.json({
    ok: true,
    duplicate: result.duplicate ?? false,
    booking: {
      id: result.booking.id,
      ref: result.booking.ref,
      summary: describeBookingShort(location, result.booking),
    },
  });
}

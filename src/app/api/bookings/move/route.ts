import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { canSeeLocation } from "@/lib/auth";
import { getBooking, getLocation } from "@/lib/store";
import { modifyBooking, describeBookingShort } from "@/lib/booking";
import { isRestaurant } from "@/lib/verticals";

export const dynamic = "force-dynamic";

/**
 * Move a booking on the calendar.
 *
 * Dragging looks like direct manipulation, and that is the point — but the
 * drop is still a request, not an instruction. Every constraint the agent
 * obeys applies here too: turn times, pacing, qualified staff, buffers,
 * opening hours. A receptionist dragging an appointment onto a stylist who
 * cannot do that service gets the same refusal a caller would, and the block
 * springs back.
 *
 * The engine is the single source of truth about what is possible. Letting
 * the calendar write directly would mean two implementations of the rules,
 * and the second one would be wrong within a month.
 */
export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const { bookingId, startMin, columnId } = (await request.json()) as {
    bookingId?: string;
    startMin?: number;
    columnId?: string;
  };

  if (!bookingId || typeof startMin !== "number") {
    return NextResponse.json({ error: "Which booking, and to when?" }, { status: 400 });
  }

  const booking = getBooking(bookingId);
  if (!booking) return NextResponse.json({ error: "Unknown booking" }, { status: 404 });

  const location = getLocation(booking.locationId);
  if (!location) return NextResponse.json({ error: "Unknown venue" }, { status: 404 });
  if (!canSeeLocation(auth.user, location.id)) {
    return NextResponse.json({ error: "Not your venue" }, { status: 403 });
  }
  if (booking.status !== "confirmed") {
    return NextResponse.json({ error: "That booking is already cancelled." }, { status: 409 });
  }

  // On a diary, the column is a person and moving sideways reassigns them.
  // A restaurant's columns are tables, and which table a party gets is the
  // engine's decision — it picks the tightest fit and combines within a
  // section. Honouring a dragged table would mean overriding that, so the
  // move is vertical only and says so rather than silently ignoring it.
  const changes: Parameters<typeof modifyBooking>[2] = { startMin: Math.round(startMin) };
  let note: string | undefined;

  if (columnId && !isRestaurant(location)) {
    changes.staffId = columnId;
  } else if (columnId && isRestaurant(location) && !(booking.tableIds ?? []).includes(columnId)) {
    note = "Time moved. The table is chosen by the engine — the tightest fit that is free.";
  }

  const result = modifyBooking(location, booking, changes);

  if (!result.ok) {
    return NextResponse.json(
      {
        error: result.detail,
        reason: result.reason,
        // The same alternatives the agent would offer a caller.
        alternatives: result.alternatives.slice(0, 4).map((slot) => slot.startMin),
      },
      { status: 409 },
    );
  }

  return NextResponse.json({
    ok: true,
    note,
    booking: {
      id: result.booking.id,
      startMin: result.booking.startMin,
      endMin: result.booking.endMin,
      staffId: result.booking.staffId,
      tableIds: result.booking.tableIds,
      summary: describeBookingShort(location, result.booking),
    },
  });
}

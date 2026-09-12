import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { canSeeLocation } from "@/lib/auth";
import { getBooking, getLocation } from "@/lib/store";
import { cancelBooking } from "@/lib/booking";

export const dynamic = "force-dynamic";

/**
 * Cancel a booking from the desk.
 *
 * Until now only the agent could cancel — a guest had to ring the line. A
 * receptionist who takes a cancellation in person, or reads one off an email,
 * had no way to record it, and the table stayed held in a diary everybody
 * could see was wrong. `cancelBooking` existed the whole time; this is the
 * door to it.
 *
 * Goes through the same function the agent uses, so a late cancellation is
 * judged by the same house rule whichever way it arrives.
 */
export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const body = (await request.json().catch(() => ({}))) as { bookingId?: string; reason?: string };
  const booking = body.bookingId ? getBooking(body.bookingId) : undefined;
  if (!booking) return NextResponse.json({ error: "Unknown booking" }, { status: 404 });

  const location = getLocation(booking.locationId);
  if (!location) return NextResponse.json({ error: "Unknown venue" }, { status: 404 });
  if (!canSeeLocation(auth.user, location.id)) {
    return NextResponse.json({ error: "Not your venue" }, { status: 403 });
  }
  if (booking.status !== "confirmed") {
    return NextResponse.json({ error: "That booking is already settled." }, { status: 409 });
  }

  const cancelled = cancelBooking(
    booking,
    location,
    body.reason?.trim() || `Cancelled at the desk by ${auth.user.name}`,
  );
  return NextResponse.json({ ok: true, lateCancel: Boolean(cancelled.lateCancel) });
}

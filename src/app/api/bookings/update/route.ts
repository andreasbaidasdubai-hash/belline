import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { canSeeLocation } from "@/lib/auth";
import { getBooking, getLocation } from "@/lib/store";
import { updateFromDesk, type DeskInput } from "@/lib/booking/desk";
import { requireE164 } from "@/lib/phone";

export const dynamic = "force-dynamic";

/**
 * Change a booking from the calendar's booking panel: the time, the person,
 * the services, the notes, or the guest's own details. Through the engine,
 * like every other change — see booking/desk.ts.
 */
export async function PATCH(req: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const body = (await req.json().catch(() => ({}))) as DeskInput & { bookingId?: string };
  const booking = body.bookingId ? getBooking(body.bookingId) : undefined;
  const location = booking ? getLocation(booking.locationId) : undefined;
  if (!booking || !location || !canSeeLocation(auth.user, location.id)) {
    return NextResponse.json({ error: "Unknown booking." }, { status: 404 });
  }

  // A changed guest number is stored with its country code; one left as it was stays.
  const typed = String(body.guestPhone ?? "").trim();
  if (body.guestPhone !== undefined && typed && typed !== (booking.guestPhone ?? "").trim()) {
    const phone = requireE164(typed);
    if (!phone.ok) return NextResponse.json({ error: phone.reason, field: "guestPhone" }, { status: 422 });
    body.guestPhone = phone.e164;
  }

  const result = updateFromDesk(location, booking, body);
  if (!result.ok) return NextResponse.json({ error: result.error, alternatives: result.alternatives }, { status: 409 });
  return NextResponse.json({ ok: true, summary: result.summary, booking: result.booking });
}

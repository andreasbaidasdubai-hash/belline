import { verifyBookingToken } from "@/lib/auth";
import { getBooking, getLocation } from "@/lib/store";
import { bookingIcs } from "@/lib/booking/manage";

export const dynamic = "force-dynamic";

/** The booking as a calendar file, for "Add to calendar". */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const bookingId = verifyBookingToken(token);
  const booking = bookingId ? getBooking(bookingId) : undefined;
  const location = booking ? getLocation(booking.locationId) : undefined;
  if (!booking || !location) return new Response("Not found", { status: 404 });

  return new Response(bookingIcs(location, booking), {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="booking-${booking.ref}.ics"`,
      "Cache-Control": "no-store",
    },
  });
}

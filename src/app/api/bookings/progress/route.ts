import { NextResponse } from "next/server";
import { getBooking, getLocation } from "@/lib/store";
import { canSeeLocation } from "@/lib/auth";
import { requireApiUser } from "@/lib/auth-server";
import { markProgress, type Progress } from "@/lib/booking";

export const dynamic = "force-dynamic";

const ALLOWED: Progress[] = ["arrived", "seated", "left", "no_show", "reopen"];

/**
 * What actually happened to a booking.
 *
 * Open to floor staff on purpose: this is the host stand and the reception
 * desk, ticking people off as they walk in. A product where only a manager can
 * record an arrival is one where arrivals never get recorded, and then the
 * no-show count — which the house rules depend on — is quietly always zero.
 */
export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const body = (await request.json()) as {
    locationId?: string;
    bookingId?: string;
    event?: string;
  };

  const location = body.locationId ? getLocation(body.locationId) : undefined;
  if (!location) return NextResponse.json({ error: "Unknown venue" }, { status: 404 });
  if (!canSeeLocation(auth.user, location.id)) {
    return NextResponse.json({ error: "Not your venue" }, { status: 403 });
  }

  const booking = body.bookingId ? getBooking(body.bookingId) : undefined;
  // An id is not an entitlement: a booking belonging to another venue is not
  // this one's to write to, however it was reached.
  if (!booking || booking.locationId !== location.id) {
    return NextResponse.json({ error: "Unknown booking" }, { status: 404 });
  }

  const event = body.event as Progress;
  if (!ALLOWED.includes(event)) {
    return NextResponse.json({ error: "Unknown event" }, { status: 400 });
  }

  // A cancelled booking is not a no-show. Somebody who rang to cancel did the
  // right thing, and recording them as absent would count that against them in
  // a rule that decides whether the agent may book them again.
  if (booking.status === "cancelled" && event !== "reopen") {
    return NextResponse.json(
      { error: "That booking was cancelled — it cannot be marked as a no-show." },
      { status: 409 },
    );
  }

  const saved = markProgress(booking, event);

  return NextResponse.json({
    ok: true,
    status: saved.status,
    service: saved.service ?? null,
  });
}

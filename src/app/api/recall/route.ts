import { NextResponse } from "next/server";
import { getBooking, getLocation } from "@/lib/store";
import { canSeeLocation } from "@/lib/auth";
import { requireApiUser } from "@/lib/auth-server";
import { markRecall } from "@/lib/booking/recall";
import { addDays, isValidDate, todayIn } from "@/lib/time";

export const dynamic = "force-dynamic";

/**
 * Working the recall list.
 *
 * Three verbs, and between them they are the whole of what a receptionist does
 * with a list like this: rang them, they asked me to try again later, ignore
 * what I did last time.
 *
 * Deliberately open to floor staff. Recall is a phone job done between
 * patients by whoever is on the desk, and a list only a manager may tick off
 * is a list nobody ticks off.
 */
export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const body = (await request.json()) as {
    locationId?: string;
    bookingId?: string;
    action?: string;
    /** For a snooze: an explicit date, or a number of days from today. */
    until?: string;
    days?: number;
  };

  const location = body.locationId ? getLocation(body.locationId) : undefined;
  if (!location) return NextResponse.json({ error: "Unknown venue" }, { status: 404 });
  if (!canSeeLocation(auth.user, location.id)) {
    return NextResponse.json({ error: "Not your venue" }, { status: 403 });
  }

  const booking = body.bookingId ? getBooking(body.bookingId) : undefined;
  // An id is not an entitlement: a booking from another venue is not this
  // venue's to write to, however it was reached.
  if (!booking || booking.locationId !== location.id) {
    return NextResponse.json({ error: "Unknown booking" }, { status: 404 });
  }

  const action = body.action;
  if (action !== "contacted" && action !== "snooze" && action !== "clear") {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  let until: string | undefined;
  if (action === "snooze") {
    const today = todayIn(location.timezone);
    if (body.until && isValidDate(body.until)) until = body.until;
    else if (Number(body.days) > 0) until = addDays(today, Math.round(Number(body.days)));
    else until = addDays(today, 30);

    if (until <= today) {
      return NextResponse.json(
        { error: "A snooze has to be to a date in the future." },
        { status: 400 },
      );
    }
  }

  const saved = markRecall(booking, action, until);

  return NextResponse.json({
    ok: true,
    contactedAt: saved.recallContactedAt ?? null,
    snoozedUntil: saved.recallSnoozedUntil ?? null,
  });
}

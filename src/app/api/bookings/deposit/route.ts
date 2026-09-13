import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { canSeeLocation } from "@/lib/auth";
import { getBooking, getLocation } from "@/lib/store";
import { depositsReady, requestDeposit, settleDeposit } from "@/lib/billing/deposits";

export const dynamic = "force-dynamic";

/**
 * The deposit on one booking, worked from the diary.
 *
 * Paid at the desk and let off work today, with or without card payments —
 * the team was already doing both by hand and had nowhere to write it down.
 * Sending a link needs the venue's Stripe account to be connected.
 */
export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const body = (await request.json().catch(() => ({}))) as { bookingId?: string; action?: string };
  const booking = getBooking(String(body.bookingId ?? ""));
  if (!booking || !canSeeLocation(auth.user, booking.locationId)) {
    return NextResponse.json({ error: "No such booking." }, { status: 404 });
  }
  if (!booking.deposit) {
    return NextResponse.json({ error: "There is no deposit on this booking." }, { status: 422 });
  }

  if (body.action === "paid" || body.action === "waived") {
    settleDeposit(booking.id, body.action);
    return NextResponse.json({ ok: true });
  }

  if (body.action === "send") {
    const location = getLocation(booking.locationId)!;
    if (!depositsReady(location)) {
      return NextResponse.json(
        { error: "Card payments are not set up for this venue yet — see Integrations." },
        { status: 422 },
      );
    }
    const result = await requestDeposit(location, booking.id);
    if (!result.link) return NextResponse.json({ error: result.detail ?? "No link." }, { status: 502 });
    return NextResponse.json({ ok: true, link: result.link, texted: result.texted });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}

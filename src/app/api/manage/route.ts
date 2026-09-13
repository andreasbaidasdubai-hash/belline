import { NextResponse } from "next/server";
import { verifyBookingToken } from "@/lib/auth";
import { getBooking, getLocation } from "@/lib/store";
import { cancelBooking, modifyBooking } from "@/lib/booking";
import { alternativeTimes, manageable, sendBookingEmail } from "@/lib/booking/manage";
import { lateCancelNotice } from "@/lib/booking/policy";
import { serviceState } from "@/lib/billing/entitlement";
import { todayIn } from "@/lib/time";

export const dynamic = "force-dynamic";

/**
 * A guest acting on their own booking, from the link in their confirmation.
 *
 * Unauthenticated by design; the signed token is the entitlement and it names
 * one booking. Everything is judged by the same engine and house rules as the
 * phone, and nothing here lets a guest do what a caller could not.
 */

const attempts = new Map<string, number[]>();
function limited(key: string): boolean {
  const now = Date.now();
  const recent = (attempts.get(key) ?? []).filter((t) => now - t < 10 * 60 * 1000);
  recent.push(now);
  attempts.set(key, recent);
  return recent.length > 20;
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    token?: string;
    action?: string;
    date?: string;
    startMin?: number;
  };
  const bookingId = verifyBookingToken(body.token);
  const booking = bookingId ? getBooking(bookingId) : undefined;
  const location = booking ? getLocation(booking.locationId) : undefined;
  if (!booking || !location) return NextResponse.json({ error: "This link is not valid." }, { status: 404 });
  if (limited(booking.id)) return NextResponse.json({ error: "Too many attempts. Try again shortly." }, { status: 429 });

  const state = manageable(location, booking);
  if (!state.ok) return NextResponse.json({ error: state.why }, { status: 409 });

  if (body.action === "times") {
    return NextResponse.json({ ok: true, slots: alternativeTimes(location, booking) });
  }

  if (body.action === "cancel") {
    const cancelled = cancelBooking(booking, location, "Cancelled by the guest from their confirmation link");
    await sendBookingEmail(location, cancelled, "cancelled");
    return NextResponse.json({
      ok: true,
      lateCancel: Boolean(cancelled.lateCancel),
      notice: cancelled.lateCancel ? lateCancelNotice(location) : null,
    });
  }

  if (body.action === "reschedule") {
    if (!serviceState(location, todayIn(location.timezone)).answering) {
      return NextResponse.json({ error: `Please call ${location.name} to change this booking.` }, { status: 409 });
    }
    if (typeof body.date !== "string" || typeof body.startMin !== "number") {
      return NextResponse.json({ error: "Choose a new time." }, { status: 422 });
    }
    const result = modifyBooking(location, booking, { date: body.date, startMin: body.startMin });
    if (!result.ok) {
      return NextResponse.json({ error: result.detail ?? "That time is no longer free." }, { status: 409 });
    }
    await sendBookingEmail(location, result.booking, "changed");
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}

import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import { getLocation, listLocations, upsertLocation } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * Give a venue the number its calls are forwarded to.
 *
 * The Twilio webhook routes by the number dialled, and nothing in the product
 * could set a venue's number — so a self-serve signup could finish setup and
 * never receive a single call. Staff only: the number has to be bought in
 * Twilio and pointed at /api/twilio/voice first, which is not a customer's job.
 *
 * Refuses a number another venue already holds. Two venues on one number
 * means the webhook answers the first as both, which is the exact failure
 * that once answered our own line as a customer's restaurant.
 */
export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!isBellineStaff(auth.user)) {
    return NextResponse.json({ error: "Staff only." }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as { venueId?: unknown; phone?: unknown };
  const venue = getLocation(String(body.venueId ?? ""));
  if (!venue) return NextResponse.json({ error: "No such venue." }, { status: 404 });

  const raw = String(body.phone ?? "").trim();
  const digits = raw.replace(/\D/g, "");

  if (raw && (!raw.startsWith("+") || digits.length < 8 || digits.length > 15)) {
    return NextResponse.json(
      { error: "Write it in international form, starting with +, as Twilio shows it." },
      { status: 422 },
    );
  }

  if (digits) {
    const holder = listLocations({ includeInternal: true }).find(
      (l) => l.id !== venue.id && l.phone.replace(/\D/g, "") === digits,
    );
    if (holder) {
      return NextResponse.json({ error: `${holder.name} already has that number.` }, { status: 409 });
    }
  }

  upsertLocation({ ...venue, phone: digits ? `+${digits}` : "" });
  return NextResponse.json({ ok: true, phone: digits ? `+${digits}` : "" });
}

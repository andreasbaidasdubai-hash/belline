import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { canSeeLocation } from "@/lib/auth";
import { getLocation } from "@/lib/store";
import { createFromDesk, type DeskInput } from "@/lib/booking/desk";
import { requireE164 } from "@/lib/phone";

export const dynamic = "force-dynamic";

/**
 * A booking taken at the desk: any time, any person or anyone free, several
 * services, the guest's email. Through the engine — see booking/desk.ts.
 */
export async function POST(req: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const body = (await req.json().catch(() => ({}))) as DeskInput & { locationId?: string };
  const location = body.locationId ? getLocation(body.locationId) : undefined;
  if (!location || !canSeeLocation(auth.user, location.id)) {
    return NextResponse.json({ error: "Unknown venue." }, { status: 404 });
  }

  // A guest's number typed at the desk is stored with its country code (lib/phone.ts).
  if (String(body.guestPhone ?? "").trim()) {
    const phone = requireE164(body.guestPhone);
    if (!phone.ok) return NextResponse.json({ error: phone.reason, field: "guestPhone" }, { status: 422 });
    body.guestPhone = phone.e164;
  }

  const result = createFromDesk(location, body);
  if (!result.ok) return NextResponse.json({ error: result.error, alternatives: result.alternatives }, { status: 409 });
  return NextResponse.json({
    ok: true,
    duplicate: result.duplicate ?? false,
    booking: { id: result.booking.id, ref: result.booking.ref, summary: result.summary },
  });
}

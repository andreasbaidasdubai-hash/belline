import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import { getLocation } from "@/lib/store";
import { connectVenueNumber, disconnectVenueNumber } from "@/lib/whatsapp";

export const dynamic = "force-dynamic";

/**
 * Connect or pause a venue's WhatsApp number. Belline staff only — the
 * number is registered in our Meta account by hand first, and this records
 * which venue it books into.
 */
export async function POST(req: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!isBellineStaff(auth.user)) return NextResponse.json({ error: "Owner only." }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as {
    venueId?: string;
    number?: string;
    phoneNumberId?: string;
  };
  const location = body.venueId ? getLocation(body.venueId) : undefined;
  if (!location) return NextResponse.json({ error: "Unknown venue." }, { status: 404 });

  const result = await connectVenueNumber({
    location,
    number: String(body.number ?? ""),
    phoneNumberId: String(body.phoneNumberId ?? ""),
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true, number: result.account.phoneE164 });
}

export async function DELETE(req: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!isBellineStaff(auth.user)) return NextResponse.json({ error: "Owner only." }, { status: 403 });

  const venueId = new URL(req.url).searchParams.get("venueId") ?? "";
  const location = getLocation(venueId);
  if (!location) return NextResponse.json({ error: "Unknown venue." }, { status: 404 });

  const paused = await disconnectVenueNumber(location);
  return NextResponse.json({ ok: true, paused });
}

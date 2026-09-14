import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { canSeeLocation } from "@/lib/auth";
import { getLocation } from "@/lib/store";
import { updateGuest } from "@/lib/guest-profile";

export const dynamic = "force-dynamic";

/** Correct a customer's name or email across all their bookings. */
export async function POST(req: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const body = (await req.json().catch(() => ({}))) as { locationId?: string; key?: string; name?: string; email?: string };
  const location = body.locationId ? getLocation(body.locationId) : undefined;
  if (!location || !canSeeLocation(auth.user, location.id)) {
    return NextResponse.json({ error: "Unknown venue." }, { status: 404 });
  }
  const result = updateGuest(location, String(body.key ?? ""), { name: body.name, email: body.email });
  return result.ok ? NextResponse.json(result) : NextResponse.json({ error: result.error }, { status: 422 });
}

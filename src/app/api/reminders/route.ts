import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { canEditAgent } from "@/lib/auth";
import { getLocation, upsertLocation } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Switch reminder texts on or off for a venue, and choose how far ahead. */
export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const body = (await request.json().catch(() => ({}))) as {
    locationId?: string;
    enabled?: unknown;
    hoursBefore?: unknown;
  };
  const location = getLocation(String(body.locationId ?? ""));
  if (!location || !canEditAgent(auth.user, location.id)) {
    return NextResponse.json({ error: "Not your venue." }, { status: 403 });
  }

  const hours = Number(body.hoursBefore);
  if (!Number.isFinite(hours) || hours < 2 || hours > 72) {
    return NextResponse.json({ error: "Between 2 and 72 hours before." }, { status: 422 });
  }

  upsertLocation({ ...location, reminders: { enabled: body.enabled === true, hoursBefore: Math.round(hours) } });
  return NextResponse.json({ ok: true });
}

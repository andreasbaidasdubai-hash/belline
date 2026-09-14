import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { canEditAgent } from "@/lib/auth";
import { getLocation, upsertLocation } from "@/lib/store";
import { publish } from "@/lib/brain";
import { isBlocking, validateVenue } from "@/lib/booking/config";
import { applyLayout } from "@/lib/floor";

export const dynamic = "force-dynamic";

/** Save where the tables sit on the floor plan. Managers and owners. */
export async function POST(req: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const body = (await req.json().catch(() => ({}))) as {
    locationId?: string;
    positions?: { id: string; x: number; y: number; shape?: "round" | "square" }[];
  };
  const location = body.locationId ? getLocation(body.locationId) : undefined;
  if (!location?.restaurant || !canEditAgent(auth.user, location.id)) {
    return NextResponse.json({ error: "Not your restaurant." }, { status: 403 });
  }
  const next = applyLayout(location, Array.isArray(body.positions) ? body.positions : []);
  const findings = validateVenue(next);
  if (isBlocking(findings)) return NextResponse.json({ error: "That layout could not be saved.", findings }, { status: 422 });
  upsertLocation(next);
  publish(location.id, { id: auth.user.id, name: auth.user.name }, "Arranged the floor plan");
  return NextResponse.json({ ok: true });
}

import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { canEditAgent } from "@/lib/auth";
import { getLocation, upsertLocation } from "@/lib/store";
import { publish } from "@/lib/brain";
import { isBlocking, validateVenue } from "@/lib/booking/config";
import { applyRotaChange, strandedBookings, type RotaChange } from "@/lib/rota";
import { minutesToClock } from "@/lib/time";

export const dynamic = "force-dynamic";

/**
 * Change one day of somebody's rota. Saved if the venue stays valid; the
 * bookings the change leaves outside their hours come back so the manager can
 * move them — nothing is moved or cancelled automatically.
 */
export async function POST(req: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const body = (await req.json().catch(() => ({}))) as RotaChange & { locationId?: string };
  const location = body.locationId ? getLocation(body.locationId) : undefined;
  if (!location || !canEditAgent(auth.user, location.id)) {
    return NextResponse.json({ error: "Not your venue." }, { status: 403 });
  }
  const result = applyRotaChange(location, body);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 });
  const findings = validateVenue(result.location);
  if (isBlocking(findings)) return NextResponse.json({ error: findings.filter((f) => f.level === "error").map((f) => f.message).join(" ") }, { status: 422 });

  upsertLocation(result.location);
  const what = body.kind === "shift" ? "hours" : body.kind === "usual" ? "back to usual hours" : body.kind === "time_off" ? "time off" : "removed time off";
  publish(location.id, { id: auth.user.id, name: auth.user.name }, `Rota: ${result.person.name} ${body.date} ${what}`);

  const stranded = strandedBookings(result.location, result.person, body.date).map((b) => ({
    id: b.id,
    guestName: b.guestName,
    time: minutesToClock(b.startMin),
    ref: b.ref,
  }));
  return NextResponse.json({ ok: true, stranded });
}

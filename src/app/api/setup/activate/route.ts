import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { canEditAgent } from "@/lib/auth";
import { getLocation, listLocationsFor } from "@/lib/store";
import { activateVenue } from "@/lib/onboarding/activate";

export const dynamic = "force-dynamic";

/**
 * Go live.
 *
 *   POST /api/setup/activate { locationId? }
 *
 * 409 with every blocker until the journey allows it, however the request is
 * made. The Go live button is only rendered when it would succeed; this is
 * the gate, the button is not.
 */
export async function POST(req: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const user = auth.user;

  const body = (await req.json().catch(() => ({}))) as { locationId?: unknown };
  const locationId = String(body.locationId ?? "") || listLocationsFor(user.tenantId)[0]?.id || "";
  const location = getLocation(locationId);
  if (!location || !canEditAgent(user, location.id)) {
    return NextResponse.json({ error: "Not your venue." }, { status: 403 });
  }

  const out = await activateVenue(location.id, user);
  if (!out.ok) {
    return NextResponse.json({ error: out.error, fix: out.fix, blockers: out.blockers }, { status: out.status });
  }
  return NextResponse.json({ ok: true, next: out.next });
}

import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { canEditAgent } from "@/lib/auth";
import { getLocation, listLocationsFor } from "@/lib/store";
import { assignNumber } from "@/lib/telephony/pool";

export const dynamic = "force-dynamic";

/**
 * "Get my number": the owner's Belline number, from the pool.
 *
 *   POST /api/phone/number { locationId? }
 *
 * Idempotent — a venue that already has a number gets the same one back. With
 * the pool off or empty, it answers "preparing" with the ticket the team is
 * working, never a made-up number.
 */
export async function POST(req: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const body = (await req.json().catch(() => ({}))) as { locationId?: string };
  const locationId = String(body.locationId ?? "") || listLocationsFor(auth.user.tenantId)[0]?.id || "";
  const location = getLocation(locationId);
  if (!location || !canEditAgent(auth.user, location.id)) {
    return NextResponse.json({ error: "Not your venue." }, { status: 403 });
  }
  if (location.demo?.enabled) return NextResponse.json({ error: "That is a demo venue." }, { status: 400 });

  const out = assignNumber(location);
  if (out.state === "assigned") return NextResponse.json({ ok: true, state: "assigned", number: out.number });
  return NextResponse.json({
    ok: true,
    state: "preparing",
    ticket: out.ticket,
    message: "Your number is being prepared, usually within one working day. It appears here as soon as it is ready.",
  });
}

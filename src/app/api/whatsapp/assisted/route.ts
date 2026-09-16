import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { canEditAgent } from "@/lib/auth";
import { getLocation, listLocationsFor } from "@/lib/store";
import { openException } from "@/lib/exceptions";

export const dynamic = "force-dynamic";

/**
 * "Set it up with us": WhatsApp, assisted.
 *
 *   POST /api/whatsapp/assisted { locationId? }
 *
 * WhatsApp works today on a second number that Belline registers with the
 * owner; doing it alone waits on Meta's verification. So the card offers a
 * person, not a dead "Coming soon", and this opens the ticket the team works
 * from. One open ticket per venue: pressing it again counts it, nothing more.
 * Nothing is sent to anybody from here.
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

  const opened = openException({
    tenantId: location.tenantId,
    locationId: location.id,
    kind: "whatsapp_assisted_setup",
    reason: `${location.name} wants Belline to set up WhatsApp on a second number with them.`,
    context: { userId: user.id },
    source: "owner",
  });
  return NextResponse.json({ ok: true, ticket: opened.exception.ticket });
}

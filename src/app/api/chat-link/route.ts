import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { canEditAgent } from "@/lib/auth";
import { getLocation, listLocationsFor } from "@/lib/store";
import { chatLinkUrl, ensureChatLink } from "@/lib/chat-link";

export const dynamic = "force-dynamic";

/**
 * Create the venue's Belline chat link.
 *
 *   POST /api/chat-link { locationId? }  → { url }
 *
 * Idempotent: a venue has one link, and asking again returns it. Creating it
 * switches nothing on for strangers — the link answers only once the venue is
 * live (chat-link.ts).
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

  const saved = ensureChatLink(location, user.id);
  return NextResponse.json({ ok: true, url: chatLinkUrl(saved) });
}

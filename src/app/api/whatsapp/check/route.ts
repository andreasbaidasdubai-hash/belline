import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { canEditAgent } from "@/lib/auth";
import { getLocation } from "@/lib/store";
import { flag } from "@/lib/flags";
import { whatsappStatus } from "@/lib/whatsapp";
import { graphClient } from "@/lib/whatsapp-provision";
import { checkWhatsApp, whatsappCard } from "@/lib/whatsapp-selfserve";

export const dynamic = "force-dynamic";

/**
 * "Try again" on the WhatsApp card.
 *
 *   POST /api/whatsapp/check { locationId }
 *
 * Looks the venue's WhatsApp up again — the answer to "Couldn't check just
 * now" — and, while Meta is reviewing the name, asks Meta straight away rather
 * than waiting for the scheduled check. Returns the card's new state.
 */
export async function POST(req: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const body = (await req.json().catch(() => ({}))) as { locationId?: string };
  const location = body.locationId ? getLocation(body.locationId) : undefined;
  if (!location || !canEditAgent(auth.user, location.id)) {
    return NextResponse.json({ error: "Not your venue." }, { status: 403 });
  }

  if (flag("channel.whatsapp.selfserve") && location.onboarding?.channels.whatsapp?.status === "pending_name") {
    const graph = flag("stubs") ? (await import("@/lib/testing/stubs")).stubGraph().graph : graphClient();
    await checkWhatsApp(location, graph);
  }
  const fresh = getLocation(location.id)!;
  return NextResponse.json({ ok: true, card: whatsappCard(fresh, await whatsappStatus(fresh)) });
}

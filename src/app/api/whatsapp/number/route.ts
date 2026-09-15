import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { canEditAgent } from "@/lib/auth";
import { getLocation } from "@/lib/store";
import { publish } from "@/lib/brain";
import { flag } from "@/lib/flags";
import { isConfigured } from "@/lib/db/client";
import { connectVenueNumber, whatsappConfigured } from "@/lib/whatsapp";
import { graphClient, provisioningReady, resendCode } from "@/lib/whatsapp-provision";
import { finishWhatsApp, resetWhatsApp, startWhatsApp, type Connect, type Provisioning } from "@/lib/whatsapp-selfserve";
import { raiseException } from "@/lib/errors/customer";

export const dynamic = "force-dynamic";

/**
 * A venue owner putting a number on WhatsApp, in two steps.
 *
 *   POST   { locationId, number, displayName }  → Meta texts the SIM a code
 *   PUT    { locationId, code }                  → verified, registered; Meta reviews the name
 *   PATCH  { locationId, method? }               → send the code again (SMS or a call)
 *   DELETE ?locationId=                          → give up on the pending number, or try again
 *
 * Nothing here needs the owner to have a Meta account. The number lives in
 * Belline's own WhatsApp business account. Behind `channel.whatsapp.selfserve`:
 * with it off, the card says "Coming soon" and this refuses plainly.
 */

async function venueFor(body: { locationId?: string }) {
  const auth = await requireApiUser();
  if (auth.response) return { response: auth.response } as const;
  const location = body.locationId ? getLocation(body.locationId) : undefined;
  if (!location || !canEditAgent(auth.user, location.id)) {
    return { response: NextResponse.json({ error: "Not your venue." }, { status: 403 }) } as const;
  }
  return { user: auth.user, location } as const;
}

/** The Graph and account to use, or null when self-serve is not on here. */
async function provisioning(): Promise<(Provisioning & { connect: Connect }) | null> {
  if (!flag("channel.whatsapp.selfserve")) return null;
  if (flag("stubs")) {
    // Local stubbed runs: the fake Graph, and no account row without a database.
    const { stubGraph } = await import("@/lib/testing/stubs");
    return { graph: stubGraph().graph, wabaId: "stub_waba", connect: async () => ({ ok: true }) };
  }
  if (!whatsappConfigured() || !provisioningReady()) {
    raiseException("whatsapp:selfserve:unconfigured", "channel.whatsapp.selfserve is on but Belline's own WhatsApp line is not fully configured");
    return null;
  }
  return {
    graph: graphClient(),
    wabaId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID!.trim(),
    connect: async ({ location, number, phoneNumberId, pin }) => {
      if (!isConfigured()) return { ok: false, error: "no database" };
      const out = await connectVenueNumber({ location, number, phoneNumberId, pin });
      return out.ok ? { ok: true } : out;
    },
  };
}

const COMING_SOON = { error: "Connecting WhatsApp yourself is coming soon. Everything else works without it." };

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { locationId?: string; number?: string; displayName?: string };
  const v = await venueFor(body);
  if ("response" in v) return v.response;
  const p = await provisioning();
  if (!p) return NextResponse.json(COMING_SOON, { status: 503 });
  if (v.location.demo?.enabled) return NextResponse.json({ error: "That is a demo venue." }, { status: 400 });

  const out = await startWhatsApp(v.location, { number: String(body.number ?? ""), displayName: String(body.displayName ?? v.location.name) }, p);
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: 400 });
  return NextResponse.json({ ok: true, pending: true, number: out.location.onboarding?.channels.whatsapp?.number });
}

export async function PATCH(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { locationId?: string; method?: string };
  const v = await venueFor(body);
  if ("response" in v) return v.response;
  const p = await provisioning();
  if (!p) return NextResponse.json(COMING_SOON, { status: 503 });
  const pending = v.location.whatsappPending;
  if (!pending) return NextResponse.json({ error: "Nothing waiting for a code." }, { status: 400 });
  const sent = await resendCode(pending.phoneNumberId, p.graph, body.method === "VOICE" ? "VOICE" : "SMS");
  if (!sent.ok) return NextResponse.json({ error: sent.error }, { status: 400 });
  return NextResponse.json({ ok: true });
}

export async function PUT(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { locationId?: string; code?: string };
  const v = await venueFor(body);
  if ("response" in v) return v.response;
  const p = await provisioning();
  if (!p) return NextResponse.json(COMING_SOON, { status: 503 });

  const number = v.location.whatsappPending?.number;
  const out = await finishWhatsApp(v.location, String(body.code ?? ""), p);
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: 400 });
  publish(v.location.id, v.user, `WhatsApp number connected: ${number}`);
  return NextResponse.json({ ok: true, number, state: "pending_name" });
}

export async function DELETE(req: Request) {
  const locationId = new URL(req.url).searchParams.get("locationId") ?? "";
  const v = await venueFor({ locationId });
  if ("response" in v) return v.response;
  resetWhatsApp(v.location);
  return NextResponse.json({ ok: true });
}

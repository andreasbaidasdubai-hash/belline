import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { canEditAgent } from "@/lib/auth";
import { getLocation, upsertLocation } from "@/lib/store";
import { publish } from "@/lib/brain";
import { connectVenueNumber, whatsappConfigured, whatsappMissing } from "@/lib/whatsapp";
import {
  finishNumber,
  graphClient,
  provisioningMissing,
  provisioningReady,
  resendCode,
  startNumber,
} from "@/lib/whatsapp-provision";

export const dynamic = "force-dynamic";

/**
 * A venue owner putting their own number on WhatsApp, in two steps.
 *
 *   POST   { locationId, number, displayName }  → Meta texts the SIM a code
 *   PUT    { locationId, code }                  → verified, registered, Belle answers it
 *   PATCH  { locationId, method? }               → send the code again (SMS or a call)
 *   DELETE ?locationId=                          → give up on the pending number
 *
 * Nothing here needs the owner to have a Meta account. The number lives in
 * Belline's own WhatsApp business account, which is why our own line has to
 * be connected first — and why this says so rather than failing later.
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

function notReady() {
  const missing = [...new Set([...whatsappMissing(), ...provisioningMissing()])];
  return NextResponse.json(
    {
      error:
        "WhatsApp numbers can't be set up just yet — Belline's own line is still being connected. Email hello@belline.ai and we'll do it with you.",
      missing,
    },
    { status: 503 },
  );
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { locationId?: string; number?: string; displayName?: string };
  const v = await venueFor(body);
  if ("response" in v) return v.response;
  if (!whatsappConfigured() || !provisioningReady()) return notReady();
  if (v.location.demo?.enabled) return NextResponse.json({ error: "That is a demo venue." }, { status: 400 });

  const started = await startNumber({
    wabaId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID!.trim(),
    number: String(body.number ?? ""),
    displayName: String(body.displayName ?? v.location.name),
    graph: graphClient(),
  });
  if (!started.ok) return NextResponse.json({ error: started.error }, { status: 400 });

  const number = String(body.number ?? "").replace(/[^\d+]/g, "");
  upsertLocation({
    ...v.location,
    whatsappPending: {
      number,
      phoneNumberId: started.phoneNumberId,
      displayName: String(body.displayName ?? v.location.name),
      startedAt: new Date().toISOString(),
    },
  });
  return NextResponse.json({ ok: true, pending: true, number });
}

export async function PATCH(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { locationId?: string; method?: string };
  const v = await venueFor(body);
  if ("response" in v) return v.response;
  const pending = v.location.whatsappPending;
  if (!pending) return NextResponse.json({ error: "Nothing waiting for a code." }, { status: 400 });
  const sent = await resendCode(pending.phoneNumberId, graphClient(), body.method === "VOICE" ? "VOICE" : "SMS");
  if (!sent.ok) return NextResponse.json({ error: sent.error }, { status: 400 });
  return NextResponse.json({ ok: true });
}

export async function PUT(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { locationId?: string; code?: string };
  const v = await venueFor(body);
  if ("response" in v) return v.response;
  const pending = v.location.whatsappPending;
  if (!pending) return NextResponse.json({ error: "Nothing waiting for a code." }, { status: 400 });

  const finished = await finishNumber({ phoneNumberId: pending.phoneNumberId, code: String(body.code ?? ""), graph: graphClient() });
  if (!finished.ok) return NextResponse.json({ error: finished.error }, { status: 400 });

  const connected = await connectVenueNumber({
    location: v.location,
    number: pending.number,
    phoneNumberId: pending.phoneNumberId,
    pin: finished.pin,
  });
  if (!connected.ok) return NextResponse.json({ error: connected.error }, { status: 400 });

  const cleared = { ...v.location };
  delete cleared.whatsappPending;
  upsertLocation(cleared);
  publish(v.location.id, v.user, `WhatsApp number connected: ${pending.number}`);

  return NextResponse.json({ ok: true, number: pending.number });
}

export async function DELETE(req: Request) {
  const locationId = new URL(req.url).searchParams.get("locationId") ?? "";
  const v = await venueFor({ locationId });
  if ("response" in v) return v.response;
  const cleared = { ...v.location };
  delete cleared.whatsappPending;
  upsertLocation(cleared);
  return NextResponse.json({ ok: true });
}

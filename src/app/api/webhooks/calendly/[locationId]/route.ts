import { NextResponse } from "next/server";
import { getLocation } from "@/lib/store";
import { flag } from "@/lib/flags";
import {
  applyCalendlyWebhook,
  calendlySigningKey,
  verifyCalendlySignature,
  type CalendlyWebhookPayload,
} from "@/lib/integrations/calendly";

export const dynamic = "force-dynamic";

/**
 * What Calendly tells Belline about bookings changed outside it.
 *
 * Belline subscribes one webhook per connected venue, at connect time, to
 * `invitee.created` and `invitee.canceled` (integrations/calendly.ts). The one
 * that matters is the cancellation: a customer who cancels from Calendly's own
 * email, or an owner who cancels in Calendly, must not still be expected in
 * Belline — the team would hold a chair for somebody who is not coming, and the
 * agent would tell them on the phone that they are booked.
 *
 * **What Belline cannot see, and says so rather than pretending.** Calendly has
 * no `invitee.rescheduled` event. A booking moved on Calendly's side arrives as
 * a cancellation and then a creation carrying `rescheduled: true` and the old
 * invitee's URI. Belline cannot follow that move — the new time is one its own
 * rules never approved, and may be one the venue is closed for — so it records
 * what happened on the booking, leaves it cancelled, and the dashboard says
 * exactly that. The customer holds Calendly's own confirmation for the new
 * time, which is true and is not Belline's to contradict.
 *
 * Nothing here is trusted without the signature. Calendly signs each delivery —
 * `Calendly-Webhook-Signature: t=<unix>,v1=<hex>`, HMAC-SHA256 of `<t>.<body>` —
 * with the signing key issued to Belline's OAuth application
 * (`CALENDLY_WEBHOOK_SIGNING_KEY`, shown once in Calendly's developer portal),
 * or with a subscription's own key where Calendly hands one back. The timestamp
 * is checked too, so a copy of a payload cannot be replayed later. A venue
 * whose key Belline does not hold is refused outright: an unsigned cancellation
 * is a request from anybody who can guess a URL, and the Calendars page says
 * plainly what Belline then cannot see.
 *
 * The venue is in the path rather than worked out from the payload, so a
 * delivery for one venue can never touch another's bookings.
 */
export async function POST(request: Request, { params }: { params: Promise<{ locationId: string }> }) {
  const { locationId } = await params;
  // Read once, as text: the signature is over the exact bytes Calendly sent.
  const raw = await request.text();

  if (!flag("booking.calendly")) return NextResponse.json({ ok: true, ignored: "off" });
  const location = getLocation(locationId);
  // Never say whether the venue exists: this address is public.
  if (!location?.calendly) return NextResponse.json({ error: "not accepted" }, { status: 404 });

  const key = calendlySigningKey(location);
  if (!key) {
    console.warn(`[calendly] ${location.name}: a webhook arrived but Belline holds no signing key for it; refused`);
    return NextResponse.json({ error: "not accepted" }, { status: 401 });
  }
  if (!verifyCalendlySignature(request.headers.get("calendly-webhook-signature"), raw, key)) {
    console.warn(`[calendly] ${location.name}: a webhook arrived with a signature Belline could not verify; refused`);
    return NextResponse.json({ error: "not accepted" }, { status: 401 });
  }

  let body: CalendlyWebhookPayload;
  try {
    body = JSON.parse(raw) as CalendlyWebhookPayload;
  } catch {
    return NextResponse.json({ error: "not accepted" }, { status: 400 });
  }

  const outcome = applyCalendlyWebhook(location, body);
  // Always 200 once the delivery is genuine: Calendly retries a failure, and a
  // retry of something Belline has already applied is not worth the noise.
  // `applyCalendlyWebhook` is idempotent, so a repeat changes nothing.
  return NextResponse.json({ ok: true, ...outcome });
}

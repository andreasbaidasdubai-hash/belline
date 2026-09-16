import { findCallBySid, listLocations } from "@/lib/store";
import { TEST_SCRIPT, isVerificationCall, recordVerificationCall } from "@/lib/telephony/verify";
import { publicRequestUrl, twilioSignatureValid } from "@/lib/voice/twilio-signature";
import { signStreamToken } from "@/lib/auth";
import { checkDemoGate, clearOldDemoBookings, isDemo } from "@/lib/demo";
import { seedIfEmpty } from "@/lib/seed";
import { serviceState } from "@/lib/billing/entitlement";
import { todayIn } from "@/lib/time";
import { answersRealCustomers } from "@/lib/onboarding/journey";
import { venueForDialledNumber } from "@/lib/telephony/number";
import { sayTwiml, voicemailTwiml } from "@/lib/telephony/voicemail";
import { answersIn } from "@/lib/language";
import { copy } from "@/lib/customer-copy";

export const dynamic = "force-dynamic";

/**
 * Twilio's incoming-call webhook.
 *
 * Returns TwiML that hands the call straight to our websocket bridge. From
 * that point Twilio is just a pipe: 8 kHz µ-law in, 8 kHz µ-law out.
 *
 * Point a Twilio number's Voice webhook at:
 *   POST https://<your-host>/api/twilio/voice
 *
 * In development, expose the local server with a tunnel and set
 * PUBLIC_WS_ORIGIN to its wss:// origin — Twilio dials in from the internet
 * and cannot reach localhost.
 */

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

/**
 * Twilio signs every webhook. Without this check the endpoint is an open door
 * to anyone who guesses the URL — and each forged request starts a call that
 * bills real money to three vendors. See lib/voice/twilio-signature.ts for what
 * happens when the token is missing, which is the case that matters.
 */
function signatureValid(url: string, params: Record<string, string>, signature: string | null): boolean {
  return twilioSignatureValid(url, params, signature, {
    token: process.env.TWILIO_AUTH_TOKEN,
    production: process.env.NODE_ENV === "production",
  });
}

export async function POST(request: Request) {
  seedIfEmpty();

  const raw = await request.text();
  const params = Object.fromEntries(new URLSearchParams(raw)) as Record<string, string>;
  const url = new URL(request.url);

  // The https:// URL Twilio signed, not the http:// one the edge forwarded.
  const signedUrl = publicRequestUrl(request);

  if (!signatureValid(signedUrl, params, request.headers.get("x-twilio-signature"))) {
    // A rejected call is silent from the caller's side — Twilio just plays its
    // own failure message — so say why here or the next misconfigured host
    // costs an afternoon. Never log the signature itself.
    console.warn(
      "[twilio] signature rejected. signed-url=%s raw-url=%s proto=%s fwd-host=%s host=%s params=%s",
      signedUrl,
      request.url,
      request.headers.get("x-forwarded-proto"),
      request.headers.get("x-forwarded-host"),
      request.headers.get("host"),
      Object.keys(params).sort().join(","),
    );
    return new Response("Invalid signature", { status: 403 });
  }

  // Internal venues included, and this is load-bearing.
  //
  // `listLocations()` hides Belline's own venue everywhere else, which is
  // right: it has no business in a customer's switcher or their bookings. Here
  // it meant our own number could never match the venue that holds it, so
  // dialling Belline reached whichever customer happened to sort first and
  // answered as their restaurant. Matching is by the number actually dialled,
  // and a number nobody else can be given is not a leak.
  const locations = listLocations({ includeInternal: true });
  const to = params.To ?? "";

  // By the Belline number, never the business's own phone: the owner's line
  // forwards here, and a venue whose own number happened to be dialled is not
  // one this webhook answers for.
  const dialled = venueForDialledNumber(locations, to);
  const asked = locations.find((l) => l.id === url.searchParams.get("loc"));

  // The last resort is a single-venue convenience, not a default.
  //
  // It used to be `locations[0]` unconditionally, which turns an unrecognised
  // number into somebody else's phone line — a stranger hears a venue they did
  // not ring, and that venue pays for the minutes. Where there is exactly one
  // venue there is nothing to get wrong; beyond that, say so.
  const only = locations.length === 1 ? locations[0] : undefined;
  const location = dialled ?? asked ?? only;

  if (!location) {
    console.warn(
      "[twilio] no venue for the dialled number. to=%s known=%s",
      digitsOnly(to).slice(-4),
      locations.length,
    );
    return xml(
      `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Sorry, this number is not set up to take calls yet.</Say>
  <Hangup/>
</Response>`,
    );
  }

  // A customer past their trial, or on a plan without the phone, checked
  // before any stream opens for the same reason as the demo cap: a refused
  // call costs one TwiML response. Lapsing is only enforced once card
  // payments are on; a missing channel always is — see billing/entitlement.ts.
  const service = serviceState(location, todayIn(location.timezone), { channel: "phone" });
  if (!service.answering) {
    console.warn("[twilio] not answering for %s: %s", location.id, service.refused);
    const language = answersIn(location);
    return xml(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${sayTwiml(language, service.callerMessage ?? copy(language, "phone.not_answering_short"))}
  <Hangup/>
</Response>`);
  }

  // The owner's forwarding test, inside the ten minutes they opened for it.
  // Answered with a script and hung up: no stream, no agent, no minutes. A
  // retried webhook for the same CallSid gets the same answer and no second row.
  if (isVerificationCall(location, params) || (params.CallSid && findCallBySid(params.CallSid)?.isTest)) {
    recordVerificationCall(location, params);
    return xml(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">${escapeXml(TEST_SCRIPT)}</Say>
  <Hangup/>
</Response>`);
  }

  // Not live yet: the owner has not pressed Go live, which needs the eight
  // checks passed first. Their forwarding test above is still answered; a real
  // customer is not, and no stream, agent or minute is spent on them. Their
  // line may already forward here, though, so the caller can leave a
  // voicemail for the owner rather than be turned away: Twilio's own <Say>
  // and <Record>, nothing else (telephony/voicemail.ts).
  if (!answersRealCustomers(location)) {
    console.warn("[twilio] not live yet for %s: offering voicemail", location.id);
    return xml(voicemailTwiml(location));
  }

  if (isDemo(location)) {
    // Refuse before opening any stream — a rejected call costs one TwiML
    // response rather than three metered vendor connections.
    const gate = checkDemoGate(location);
    if (!gate.allowed) {
      return xml(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">${escapeXml(gate.message ?? "This demonstration line is closed for today.")}</Say>
  <Hangup/>
</Response>`);
    }
    // Yesterday's demo bookings would otherwise make the diary look full.
    clearOldDemoBookings(location);
  }

  const origin =
    process.env.PUBLIC_WS_ORIGIN?.replace(/\/$/, "") ??
    `wss://${request.headers.get("host") ?? url.host}`;

  return xml(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${origin}/ws/twilio">
      <Parameter name="token" value="${signStreamToken(location.id)}" />
      <Parameter name="from" value="${escapeXml(params.From ?? "unknown")}" />
      <Parameter name="callSid" value="${escapeXml(params.CallSid ?? "")}" />
    </Stream>
  </Connect>
</Response>`);
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!,
  );
}

function xml(body: string): Response {
  return new Response(body, {
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

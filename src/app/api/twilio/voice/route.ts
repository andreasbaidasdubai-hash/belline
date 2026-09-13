import { listLocations } from "@/lib/store";
import { twilioSignatureValid } from "@/lib/voice/twilio-signature";
import { signStreamToken } from "@/lib/auth";
import { checkDemoGate, clearOldDemoBookings, isDemo } from "@/lib/demo";
import { seedIfEmpty } from "@/lib/seed";
import { serviceState } from "@/lib/billing/entitlement";
import { todayIn } from "@/lib/time";

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

  // Railway (like every managed host) terminates TLS at the edge and forwards
  // plain HTTP, so request.url says http:// while Twilio signed the https://
  // URL the caller actually hit. Rebuild the public URL from the forwarded
  // headers or the signature never matches.
  const signedUrl = new URL(url.toString());
  signedUrl.protocol = (request.headers.get("x-forwarded-proto") ?? "https").split(",")[0].trim() + ":";
  // Clear the port before setting the host: the URL host setter leaves the
  // existing port in place unless the new value carries one of its own, which
  // would otherwise leave the internal :3000 glued to the public hostname.
  signedUrl.port = "";
  signedUrl.host = (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host)
    .split(",")[0]
    .trim();

  if (!signatureValid(signedUrl.toString(), params, request.headers.get("x-twilio-signature"))) {
    // A rejected call is silent from the caller's side — Twilio just plays its
    // own failure message — so say why here or the next misconfigured host
    // costs an afternoon. Never log the signature itself.
    console.warn(
      "[twilio] signature rejected. signed-url=%s raw-url=%s proto=%s fwd-host=%s host=%s params=%s",
      signedUrl.toString(),
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

  const dialled = locations.find((l) => digitsOnly(l.phone) === digitsOnly(to));
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

  // A customer past their trial, checked before any stream opens for the
  // same reason as the demo cap: a refused call costs one TwiML response.
  // Only enforced once card payments are on — see billing/entitlement.ts.
  const service = serviceState(location, todayIn(location.timezone));
  if (!service.answering) {
    console.warn("[twilio] not answering for %s: %s", location.id, service.lapsed);
    return xml(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">${escapeXml(service.callerMessage ?? "Nobody is able to take your call just now.")}</Say>
  <Hangup/>
</Response>`);
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

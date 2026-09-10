import crypto from "node:crypto";
import { listLocations } from "@/lib/store";
import { signStreamToken } from "@/lib/auth";
import { checkDemoGate, clearOldDemoBookings, isDemo } from "@/lib/demo";
import { seedIfEmpty } from "@/lib/seed";

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
 * bills real money to three vendors.
 */
function signatureValid(url: string, params: Record<string, string>, signature: string | null): boolean {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return true; // Unconfigured: development only.
  if (!signature) return false;

  const payload =
    url +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join("");
  const expected = crypto.createHmac("sha1", token).update(payload, "utf8").digest("base64");

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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

  const locations = listLocations();
  const to = params.To ?? "";
  // Match the dialled number to a venue; fall back to an explicit query
  // parameter, then to the only venue configured.
  const location =
    locations.find((l) => digitsOnly(l.phone) === digitsOnly(to)) ??
    locations.find((l) => l.id === url.searchParams.get("loc")) ??
    locations[0];

  if (!location) {
    return xml(`<Response><Say>This number is not configured.</Say><Hangup/></Response>`);
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

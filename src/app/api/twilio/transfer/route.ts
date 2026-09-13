import { twilioSignatureValid } from "@/lib/voice/twilio-signature";

export const dynamic = "force-dynamic";

/**
 * What happens after a live transfer rings.
 *
 * Twilio calls this when the `<Dial>` finishes. Answered and talked: hang up
 * quietly, the conversation is over. Not answered, busy, failed: tell the
 * caller plainly that the team will call back — which is true, because the
 * call is already on the venue's Needs-you list with the number and the
 * reason — rather than leave them in silence.
 */
export async function POST(request: Request) {
  const raw = await request.text();
  const params = Object.fromEntries(new URLSearchParams(raw)) as Record<string, string>;

  const url = new URL(request.url);
  const signed = new URL(url.toString());
  signed.protocol = (request.headers.get("x-forwarded-proto") ?? "https").split(",")[0].trim() + ":";
  signed.port = "";
  signed.host = (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host)
    .split(",")[0]
    .trim();

  const valid = twilioSignatureValid(signed.toString(), params, request.headers.get("x-twilio-signature"), {
    token: process.env.TWILIO_AUTH_TOKEN,
    production: process.env.NODE_ENV === "production",
  });
  if (!valid) return new Response("Invalid signature", { status: 403 });

  const answered = params.DialCallStatus === "completed";
  const body = answered
    ? `<Response><Hangup/></Response>`
    : `<Response><Say voice="Polly.Joanna">I'm sorry, nobody could get to the phone just now. The team has your number and what you told me, and they will call you back as soon as they can.</Say><Hangup/></Response>`;

  return new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, {
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

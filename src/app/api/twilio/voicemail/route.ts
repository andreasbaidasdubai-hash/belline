import { getLocation } from "@/lib/store";
import { seedIfEmpty } from "@/lib/seed";
import { publicRequestUrl, twilioSignatureValid } from "@/lib/voice/twilio-signature";
import { VOICEMAIL_THANKS, recordVoicemail } from "@/lib/telephony/voicemail";

export const dynamic = "force-dynamic";

/**
 * Twilio's callbacks for a voicemail left on a venue that is not live yet: the
 * `<Record action>` when the caller finishes, and the recording status
 * callback when the audio is ready. See telephony/voicemail.ts.
 *
 * Signed like the voice webhook and refused the same way when the signature is
 * wrong: an unsigned request could otherwise put items in an owner's list. The
 * venue comes from `loc` in the URL we gave Twilio, which the signature covers.
 * Each recording becomes one item in that venue's "Needs you", and only there.
 */
export async function POST(request: Request) {
  seedIfEmpty();
  const raw = await request.text();
  const params = Object.fromEntries(new URLSearchParams(raw)) as Record<string, string>;
  const url = new URL(request.url);

  const valid = twilioSignatureValid(publicRequestUrl(request), params, request.headers.get("x-twilio-signature"), {
    token: process.env.TWILIO_AUTH_TOKEN,
    production: process.env.NODE_ENV === "production",
  });
  if (!valid) {
    console.warn("[twilio] voicemail callback signature rejected. params=%s", Object.keys(params).sort().join(","));
    return new Response("Invalid signature", { status: 403 });
  }

  const action = url.searchParams.get("via") === "action";
  const location = getLocation(url.searchParams.get("loc") ?? "");
  if (!location) {
    console.warn("[twilio] voicemail callback for an unknown venue");
  } else {
    const out = recordVoicemail(location, params);
    if (!out.ok) console.warn("[twilio] voicemail for %s not recorded: %s", location.id, out.reason);
  }

  // The action request's answer is what the caller hears last; the status
  // callback's answer is ignored by Twilio.
  return new Response(
    action
      ? `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">${VOICEMAIL_THANKS}</Say>
  <Hangup/>
</Response>`
      : `<?xml version="1.0" encoding="UTF-8"?>
<Response/>`,
    { headers: { "Content-Type": "text/xml; charset=utf-8" } },
  );
}

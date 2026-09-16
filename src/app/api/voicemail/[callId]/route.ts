import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { canSeeLocation } from "@/lib/auth";
import { getCall } from "@/lib/store";
import { twilioRecordingUrl } from "@/lib/telephony/voicemail";

export const dynamic = "force-dynamic";

/**
 * Play a voicemail to the owner.
 *
 * The recording stays with Twilio and needs our Twilio credentials to fetch,
 * so the owner's "Listen" goes through here: signed in, and allowed to see the
 * venue the message was left for — a voicemail is personal data and only that
 * business's own people hear it. Nothing is cached or copied on the way.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ callId: string }> }) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const { callId } = await params;
  const call = getCall(callId);
  if (!call?.voicemail) return NextResponse.json({ error: "No such voicemail." }, { status: 404 });
  if (!canSeeLocation(auth.user, call.locationId)) {
    return NextResponse.json({ error: "Not your venue" }, { status: 403 });
  }

  const url = twilioRecordingUrl(call.voicemail.recordingUrl);
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!url || !sid || !token) return NextResponse.json({ error: "The recording can't be played right now." }, { status: 503 });

  const res = await fetch(`${url}.mp3`, {
    headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}` },
    cache: "no-store",
  }).catch(() => null);
  if (!res?.ok || !res.body) {
    return NextResponse.json({ error: "The recording can't be played right now. Try again in a minute." }, { status: 502 });
  }
  return new Response(res.body, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "private, no-store",
      "Content-Disposition": "inline",
    },
  });
}

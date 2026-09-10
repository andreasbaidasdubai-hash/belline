import { NextResponse } from "next/server";
import { getLocation } from "@/lib/store";
import { requireApiUser } from "@/lib/auth-server";
import { speak, ttsEnabled } from "@/lib/providers/tts";

export const dynamic = "force-dynamic";

/**
 * Speak a sample line in a candidate voice.
 *
 * The sample defaults to the venue's own greeting rather than a generic
 * pangram — the only question that matters is whether *this* voice can say
 * *this* venue's name without sounding wrong.
 */
export async function POST(request: Request) {
  // Each preview is a billed ElevenLabs call, so this needs a session even
  // though it only returns audio.
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  if (!ttsEnabled()) {
    return NextResponse.json(
      { error: "Set ELEVENLABS_API_KEY to preview voices." },
      { status: 503 },
    );
  }

  const body = (await request.json()) as { voiceId?: string; locationId?: string; text?: string };
  const voiceId = body.voiceId?.trim();
  if (!voiceId) {
    return NextResponse.json({ error: "No voice selected." }, { status: 400 });
  }

  const location = body.locationId ? getLocation(body.locationId) : undefined;
  const text =
    body.text?.trim() ||
    location?.agent.greeting ||
    "Good evening, thank you for calling. How can I help you?";

  try {
    const chunks: Buffer[] = [];
    for await (const chunk of speak(text.slice(0, 400), {
      voiceId,
      format: "mp3_44100_128",
    })) {
      chunks.push(chunk);
    }
    const audio = Buffer.concat(chunks);
    if (audio.length === 0) {
      return NextResponse.json({ error: "No audio returned." }, { status: 502 });
    }
    return new Response(new Uint8Array(audio), {
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}

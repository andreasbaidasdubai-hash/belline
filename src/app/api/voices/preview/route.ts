import { NextResponse } from "next/server";
import { getLocation } from "@/lib/store";
import { requireApiUser } from "@/lib/auth-server";
import { speak, ttsEnabled, ttsLanguageCodeOf } from "@/lib/providers/tts";
import { languageUsable, parseLanguage } from "@/lib/language";
import { verifyRefusal } from "@/lib/abuse/gate";

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
  const held = verifyRefusal(auth.user);
  if (held) return NextResponse.json({ error: held.error, fix: held.fix, code: held.code }, { status: held.status });

  if (!ttsEnabled()) {
    return NextResponse.json(
      { error: "Set ELEVENLABS_API_KEY to preview voices." },
      { status: 503 },
    );
  }

  const body = (await request.json()) as {
    voiceId?: string;
    voiceModel?: string;
    voiceSpeed?: number;
    locationId?: string;
    text?: string;
    /** The business's main language, so the preview is pinned the way a call is. */
    language?: string;
  };
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
      // Preview what the caller will actually hear, not a house default.
      modelId: body.voiceModel?.trim() || location?.agent.voiceModel,
      speed: body.voiceSpeed ?? location?.agent.voiceSpeed,
      format: "mp3_44100_128",
      ...(previewLanguageCode(body.language) ? { languageCode: previewLanguageCode(body.language) } : {}),
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

/** The ElevenLabs language code for a usable language other than English, or nothing. */
function previewLanguageCode(raw: unknown): string | undefined {
  const code = parseLanguage(raw);
  return code && code !== "en" && languageUsable(code) ? ttsLanguageCodeOf(code) : undefined;
}

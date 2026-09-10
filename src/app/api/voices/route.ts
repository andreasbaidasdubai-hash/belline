import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";

export const dynamic = "force-dynamic";

/**
 * The voices this venue can choose from.
 *
 * Read live from the ElevenLabs account when a key is configured, so the list
 * includes any voice the venue has cloned or bought — which is the point, if
 * a group wants every location to sound like the same person. The fallback
 * below is only there so the picker is not an empty box before setup; those
 * ids are ElevenLabs stock voices and are worth confirming in the account.
 */

interface VoiceOption {
  id: string;
  name: string;
  description: string;
  cloned?: boolean;
}

const FALLBACK: VoiceOption[] = [
  { id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel", description: "American, calm and even" },
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah", description: "American, soft and warm" },
  { id: "Xb7hH8MSUJpSbSDYk0k2", name: "Alice", description: "British, clear and confident" },
  { id: "pFZP5JQG7iQjIQuC4Bku", name: "Lily", description: "British, warm and friendly" },
  { id: "onwK4e9ZLuTAKqWW03F9", name: "Daniel", description: "British, measured and formal" },
  { id: "JBFqnCBsd6RMkjVDRZzb", name: "George", description: "British, warm and mature" },
  { id: "pNInz6obpgDQGcFmaJgB", name: "Adam", description: "American, deep and steady" },
  { id: "IKne3meq5aSn9XLyUdCD", name: "Charlie", description: "Australian, casual" },
];

export async function GET() {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    return NextResponse.json({
      source: "fallback",
      note: "Set ELEVENLABS_API_KEY to load the voices on your own account, including cloned ones.",
      voices: FALLBACK,
    });
  }

  try {
    const response = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": key },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`ElevenLabs ${response.status}`);

    const data = (await response.json()) as {
      voices?: {
        voice_id: string;
        name: string;
        category?: string;
        labels?: Record<string, string>;
      }[];
    };

    const voices: VoiceOption[] = (data.voices ?? []).map((v) => ({
      id: v.voice_id,
      name: v.name,
      description:
        [v.labels?.accent, v.labels?.description, v.labels?.use_case]
          .filter(Boolean)
          .join(", ") || (v.category ?? ""),
      cloned: v.category === "cloned" || v.category === "professional",
    }));

    // Cloned and professional voices first — if a venue went to the trouble
    // of making one, that is the one they want to pick.
    voices.sort((a, b) => Number(b.cloned) - Number(a.cloned) || a.name.localeCompare(b.name));

    return NextResponse.json({ source: "elevenlabs", voices });
  } catch (err) {
    return NextResponse.json({
      source: "fallback",
      note: `Could not reach ElevenLabs (${err instanceof Error ? err.message : String(err)}).`,
      voices: FALLBACK,
    });
  }
}

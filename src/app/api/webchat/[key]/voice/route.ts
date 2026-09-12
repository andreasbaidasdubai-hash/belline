import { NextResponse } from "next/server";
import { cleanClientId, resolveVisitor, visitorTurn } from "@/lib/webchat-turn";
import { VOICE_NOTE_MAX_BYTES, VOICE_NOTE_MAX_SECONDS, voiceNoteToText } from "@/lib/webchat-voice";
import { speechKeyterms } from "@/lib/verticals";
import { transcribeClip } from "@/lib/providers/stt";

export const dynamic = "force-dynamic";

/**
 * Web chat, spoken.
 *
 * The body is the recording itself — the page posts the blob the browser
 * made, with its own content type — and the things that would be JSON fields
 * on the typed route travel as headers. It is transcribed, discarded, and the
 * words go through exactly the same turn a typed message would; see
 * webchat-voice.ts for why the audio is never kept.
 *
 * The transcript, not the audio, is what comes back, so the page can show
 * the visitor what Belline heard before the reply — a misheard "Thursday" is
 * far easier to forgive when you can see it was misheard.
 */
export async function POST(req: Request, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params;

  const visitor = await resolveVisitor(key, req.headers.get("x-visitor-token") ?? undefined);
  if (visitor instanceof NextResponse) return visitor;

  const clientId = cleanClientId(req.headers.get("x-client-id"));
  if (!clientId) return NextResponse.json({ error: "Missing message id." }, { status: 400 });

  // Refuse by the declared size before reading a body that would be thrown
  // away anyway; the real check is on the bytes.
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > VOICE_NOTE_MAX_BYTES) {
    return NextResponse.json({ error: "too-big" }, { status: 413 });
  }

  const mime = req.headers.get("content-type") ?? "";
  const bytes = Buffer.from(await req.arrayBuffer());
  const seconds = Math.min(
    VOICE_NOTE_MAX_SECONDS,
    Math.max(0, Math.round(Number(req.headers.get("x-note-seconds") ?? 0) || 0)),
  );

  const heard = await voiceNoteToText({ bytes, mime }, (audio, type) =>
    // The venue's own words — its name, its dishes, its treatments — so a
    // voice note about "the terrace" is not written down as something else.
    transcribeClip(audio, type, { keyterms: speechKeyterms(visitor.location) }),
  );

  if (!heard.ok) {
    const status = heard.reason === "too-big" ? 413 : heard.reason === "unsupported" ? 415 : 200;
    // "empty" and "failed" are 200 with ok:false: the request was fine, there
    // are just no words. The page says so and nothing is stored.
    return NextResponse.json({ ok: false, reason: heard.reason }, { status });
  }

  const turn = await visitorTurn(visitor, { text: heard.text, clientId, spoken: { seconds } });
  if (!turn.ok) return turn;

  // The turn's payload, plus what was heard, so the page can put the words in
  // the visitor's own bubble.
  const payload = (await turn.json()) as Record<string, unknown>;
  return NextResponse.json({ ...payload, heard: heard.text });
}

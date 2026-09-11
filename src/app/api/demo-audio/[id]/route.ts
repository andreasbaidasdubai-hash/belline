import fs from "node:fs";
import { clipPath, isClipId, loadClip } from "@/lib/sales/demos/render";

export const dynamic = "force-dynamic";

/**
 * Serves one demo clip.
 *
 * The clips deliberately do not live in `public/`: `npm run site` copies every
 * mp3 under it into the marketing build, which would publish a prospect's
 * personalised demo to belline.ai under their business's name.
 *
 * Disk first, database second. The disk copy is a cache and saves a round
 * trip; the database is the source of truth, and it is what makes a demo
 * generated on a laptop play from a container that has never seen the file.
 * Getting that the wrong way round is what produced a live demo page whose
 * transcript rendered and whose every clip 404'd.
 *
 * Public by necessity — the prospect has never signed in and never will — and
 * safe because the only thing this accepts is a 16-character hex clip id.
 * Anything else is refused before it reaches a filesystem or a query.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isClipId(id)) return new Response("Not found", { status: 404 });

  let audio: Buffer | null = null;

  const file = clipPath(id);
  if (file) {
    try {
      audio = fs.readFileSync(file);
    } catch {
      // A cache that cannot be read is not an error, it is a cache miss.
    }
  }

  audio ??= await loadClip(id);

  if (!audio) return new Response("Not found", { status: 404 });

  return new Response(new Uint8Array(audio), {
    headers: {
      "Content-Type": "audio/mpeg",
      "Content-Length": String(audio.length),
      // Content-addressed: these bytes never change, so cache them forever.
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

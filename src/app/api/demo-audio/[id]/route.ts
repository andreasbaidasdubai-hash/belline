import fs from "node:fs";
import { clipPath } from "@/lib/sales/demos/render";

export const dynamic = "force-dynamic";

/**
 * Serves one demo clip.
 *
 * The clips deliberately do not live in `public/`: `npm run site` copies every
 * mp3 under it into the marketing build, which would publish a prospect's
 * personalised demo to belline.ai under their business's name. They sit under
 * DATA_DIR and reach the browser through here instead.
 *
 * Public by necessity — the prospect has never signed in and never will — and
 * safe because the only thing this accepts is a 16-character hex clip id.
 * `clipPath` refuses anything else, so no path a caller supplies can escape
 * the directory.
 *
 * Content-addressed names mean a clip's bytes never change, so it can be
 * cached hard and forever.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const file = clipPath(id);

  if (!file) {
    return new Response("Not found", { status: 404 });
  }

  const audio = fs.readFileSync(file);
  return new Response(new Uint8Array(audio), {
    headers: {
      "Content-Type": "audio/mpeg",
      "Content-Length": String(audio.length),
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

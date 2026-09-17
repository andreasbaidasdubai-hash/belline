import fs from "node:fs/promises";
import path from "node:path";

/**
 * Belle's poster for the email thumbnail, as a data URI embedded in the PNG.
 *
 * The image renderer would otherwise fetch the address itself, with no
 * timeout or size limit, and a mail client fetching the thumbnail days later
 * must never get a broken picture. So the poster (the venue face's Tavus
 * `thumbnail_image_url`, or a deployment poster under public/) is read here,
 * with a timeout, a size cap and an image type check, and anything else
 * returns null: the route then draws the plain Belline-blue circle.
 */

const MAX_BYTES = 2_000_000;
const TIMEOUT_MS = 3500;
const TYPES: Record<string, string> = { "image/jpeg": "image/jpeg", "image/jpg": "image/jpeg", "image/png": "image/png" };

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

function sniff(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  return null;
}

export async function posterDataUri(
  url: string,
  opts: { fetchImpl?: Fetch; publicDir?: string } = {},
): Promise<string | null> {
  const value = (url ?? "").trim();
  if (!value) return null;
  try {
    let bytes: Uint8Array;
    let declared: string | null = null;
    if (/^\/[^\s"'<>]*$/.test(value) && !value.startsWith("//")) {
      // A path on this app: read it from public/, never outside it.
      const root = path.resolve(opts.publicDir ?? path.join(process.cwd(), "public"));
      const file = path.resolve(root, `.${decodeURIComponent(value.split(/[?#]/)[0])}`);
      if (!file.startsWith(root + path.sep)) return null;
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > MAX_BYTES) return null;
      bytes = new Uint8Array(await fs.readFile(file));
    } else if (/^https:\/\/[^\s"'<>]+$/.test(value)) {
      const res = await (opts.fetchImpl ?? ((i, init) => fetch(i, init)))(value, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "follow" });
      if (!res.ok) return null;
      declared = TYPES[(res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase()] ?? null;
      const length = Number(res.headers.get("content-length") ?? 0);
      if (length > MAX_BYTES) return null;
      bytes = new Uint8Array(await res.arrayBuffer());
    } else {
      return null;
    }
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) return null;
    // The bytes decide, not the header: the renderer takes JPEG and PNG only.
    const type = sniff(bytes);
    if (!type || (declared && declared !== type)) return null;
    return `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
  } catch {
    return null;
  }
}

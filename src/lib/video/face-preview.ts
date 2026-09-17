import type { VideoConfig } from "./config";

/**
 * The chosen face's own preview, for the greeting bubble.
 *
 * Tavus keeps a short silent thumbnail video and a still for every face
 * (`GET /v2/faces/{face_id}`: `thumbnail_video_url`, `thumbnail_image_url`).
 * Showing those in the bubble puts the real receptionist in the circle without
 * rendering a greeting clip, which costs credits. A venue or deployment clip,
 * when one is set, still wins.
 *
 * Fetched server-side with the key and cached: the visitor's browser only ever
 * sees the two CDN addresses, never the key. A failed lookup is cached briefly
 * so a Tavus outage costs one slow request per few minutes, not one per page.
 */

export interface FacePreview {
  clipUrl: string;
  posterUrl: string;
}

const OK_TTL_MS = 6 * 60 * 60 * 1000;
const FAIL_TTL_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 4000;

let cache: { key: string; at: number; value: FacePreview | null } | null = null;
let pending: Promise<FacePreview | null> | null = null;

/** Only an https address with nothing a page could be tricked into running. */
function safeHttps(raw: unknown): string {
  return typeof raw === "string" && /^https:\/\/[^\s"'<>]+$/.test(raw) ? raw : "";
}

export async function facePreview(
  config: VideoConfig,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  now: number = Date.now(),
): Promise<FacePreview | null> {
  if (config.provider !== "tavus" || !config.tavus.apiKey || !config.tavus.faceId) return null;
  const key = `${config.tavus.apiBase}|${config.tavus.faceId}`;
  if (cache && cache.key === key && now - cache.at < (cache.value ? OK_TTL_MS : FAIL_TTL_MS)) return cache.value;
  if (pending) return pending;

  pending = (async () => {
    let value: FacePreview | null = null;
    try {
      const res = await fetchImpl(`${config.tavus.apiBase}/v2/faces/${encodeURIComponent(config.tavus.faceId)}`, {
        headers: { "x-api-key": config.tavus.apiKey },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) {
        const body = (await res.json()) as { thumbnail_video_url?: unknown; thumbnail_image_url?: unknown };
        const clipUrl = safeHttps(body.thumbnail_video_url);
        const posterUrl = safeHttps(body.thumbnail_image_url);
        if (clipUrl || posterUrl) value = { clipUrl, posterUrl };
      } else {
        // Status only: the body could echo the request.
        console.warn(`[video] face preview lookup refused: HTTP ${res.status}`);
      }
    } catch (err) {
      console.warn(`[video] face preview lookup failed: ${err instanceof Error ? err.name : "error"}`);
    }
    cache = { key, at: now, value };
    return value;
  })();
  try {
    return await pending;
  } finally {
    pending = null;
  }
}

/** Tests only. */
export function resetFacePreviewCache(): void {
  cache = null;
  pending = null;
}

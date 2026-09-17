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

/** Per face: venues may each choose their own (faces.ts). A handful of entries at most. */
const cache = new Map<string, { at: number; value: FacePreview | null }>();
const pending = new Map<string, Promise<FacePreview | null>>();

/** Only an https address with nothing a page could be tricked into running. */
function safeHttps(raw: unknown): string {
  return typeof raw === "string" && /^https:\/\/[^\s"'<>]+$/.test(raw) ? raw : "";
}

export async function facePreview(
  config: VideoConfig,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  now: number = Date.now(),
  /** The venue's own face (faces.ts `venueLook`); the deployment's by default. */
  faceId: string = config.tavus.faceId,
): Promise<FacePreview | null> {
  if (config.provider !== "tavus" || !config.tavus.apiKey || !faceId) return null;
  const key = `${config.tavus.apiBase}|${faceId}`;
  const kept = cache.get(key);
  if (kept && now - kept.at < (kept.value ? OK_TTL_MS : FAIL_TTL_MS)) return kept.value;
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;

  const lookup = (async () => {
    let value: FacePreview | null = null;
    try {
      const res = await fetchImpl(`${config.tavus.apiBase}/v2/faces/${encodeURIComponent(faceId)}`, {
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
    cache.set(key, { at: now, value });
    return value;
  })();
  pending.set(key, lookup);
  try {
    return await lookup;
  } finally {
    pending.delete(key);
  }
}

/** Tests only. */
export function resetFacePreviewCache(): void {
  cache.clear();
  pending.clear();
}

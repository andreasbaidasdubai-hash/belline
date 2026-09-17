import type { VideoConfig } from "./config";
import { ORIGINAL_BACKGROUND_ID, DEFAULT_BACKGROUND_ID, videoBackground, type VideoBackground } from "./backgrounds";

/**
 * The stock faces an owner may choose for their receptionist.
 *
 * A short curated list, not Tavus's whole catalogue: office-appropriate looks
 * a business would put on its front desk. Ids and models are from Tavus's
 * stock face model map
 * (https://docs.tavus.io/sections/faces/stock-face-model-map), and every one is
 * confirmed against the account with `GET /v2/faces?face_type=system&face_ids=…`
 * (https://docs.tavus.io/api-reference/faces/list-faces) before it is shown
 * or saved: an id Tavus does not return is not offered.
 *
 * Why Phoenix-4 looks are here beside Phoenix-4.5: background replacement "is
 * not currently available with Phoenix-4.5 faces"
 * (https://docs.tavus.io/sections/conversational-video-interface/conversation/customizations/background-customizations).
 * An owner who wants the branded background picks a Phoenix-4 look; one who
 * wants Tavus's newest rendering keeps the face's own room.
 *
 * Fetched server-side with the key and cached; the browser sees names, ids and
 * CDN preview addresses only.
 */

export type PhoenixModel = "phoenix-4" | "phoenix-4.5";

export interface CuratedFace {
  id: string;
  name: string;
  model: PhoenixModel;
}

export const CURATED_FACES: readonly CuratedFace[] = [
  { id: "rf90eb925bd8", name: "Ruby · Office", model: "phoenix-4.5" },
  { id: "rcc28da86847", name: "Ruby · Office", model: "phoenix-4" },
  { id: "rc9cff32ceba", name: "Anna · Casual", model: "phoenix-4.5" },
  { id: "rf4e9d9790f0", name: "Anna · Professional", model: "phoenix-4" },
  { id: "rca764a6a197", name: "Olivia · Office", model: "phoenix-4.5" },
  { id: "r4dc9377a68e", name: "Priya · Office", model: "phoenix-4.5" },
  { id: "r6c7a6cb6d9b", name: "Rose · Business", model: "phoenix-4" },
  { id: "r12d3eb75ec2", name: "Helen · Casual", model: "phoenix-4" },
  { id: "rfb0463909e3", name: "James · Office", model: "phoenix-4" },
  { id: "re3fd4adeafd", name: "Victor · Office", model: "phoenix-4" },
  { id: "r3f4182ef554", name: "Lucas · Studio", model: "phoenix-4.5" },
  { id: "rb07f6f67b52", name: "Charlie", model: "phoenix-4" },
] as const;

export interface FaceOption {
  id: string;
  name: string;
  model: string;
  /** Whether a background can replace the face's own room. */
  backgrounds: boolean;
  clipUrl: string;
  posterUrl: string;
}

export function curatedFace(id: string | null | undefined): CuratedFace | undefined {
  return CURATED_FACES.find((f) => f.id === id);
}

/** Background replacement is documented as unavailable on Phoenix-4.5; anything unknown is treated the same. */
export function faceTakesBackground(model: string | undefined): boolean {
  return model === "phoenix-4" || model === "phoenix-3";
}

const OK_TTL_MS = 6 * 60 * 60 * 1000;
const FAIL_TTL_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 5000;

let cache: { key: string; at: number; value: FaceOption[] | null } | null = null;
let pending: Promise<FaceOption[] | null> | null = null;

function safeHttps(raw: unknown): string {
  return typeof raw === "string" && /^https:\/\/[^\s"'<>]+$/.test(raw) ? raw : "";
}

/**
 * What Tavus confirms of the curated list, in the list's order, or null when it
 * could not be asked (no key, the mock, an outage). Null is not "none": callers
 * decide whether an unconfirmed list may be shown (a note) or saved (never).
 */
export async function confirmedFaces(
  config: VideoConfig,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  now: number = Date.now(),
): Promise<FaceOption[] | null> {
  if (config.provider !== "tavus" || !config.tavus.apiKey) return null;
  const key = config.tavus.apiBase;
  if (cache && cache.key === key && now - cache.at < (cache.value ? OK_TTL_MS : FAIL_TTL_MS)) return cache.value;
  if (pending) return pending;

  pending = (async () => {
    let value: FaceOption[] | null = null;
    try {
      const query = new URLSearchParams({
        face_type: "system",
        verbose: "true",
        limit: String(CURATED_FACES.length),
        face_ids: CURATED_FACES.map((f) => f.id).join(","),
      });
      const res = await fetchImpl(`${config.tavus.apiBase}/v2/faces?${query}`, {
        headers: { "x-api-key": config.tavus.apiKey },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) {
        const body = (await res.json()) as { data?: unknown };
        const rows = Array.isArray(body.data) ? (body.data as Record<string, unknown>[]) : [];
        value = CURATED_FACES.flatMap((face) => {
          const row = rows.find((r) => r?.face_id === face.id);
          // Only stock faces Tavus returned, and only finished ones.
          if (!row || (typeof row.status === "string" && row.status !== "completed")) return [];
          const model = typeof row.model_name === "string" ? row.model_name : face.model;
          return [
            {
              id: face.id,
              name: face.name,
              model,
              backgrounds: faceTakesBackground(model),
              clipUrl: safeHttps(row.thumbnail_video_url),
              posterUrl: safeHttps(row.thumbnail_image_url),
            },
          ];
        });
      } else {
        console.warn(`[video] stock face lookup refused: HTTP ${res.status}`);
      }
    } catch (err) {
      console.warn(`[video] stock face lookup failed: ${err instanceof Error ? err.name : "error"}`);
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

/** The curated list as it stands without Tavus: for the mock and an outage. Never grounds for saving. */
export function unconfirmedFaces(): FaceOption[] {
  return CURATED_FACES.map((f) => ({ id: f.id, name: f.name, model: f.model, backgrounds: faceTakesBackground(f.model), clipUrl: "", posterUrl: "" }));
}

/** Tests only. */
export function resetFaceCache(): void {
  cache = null;
  pending = null;
}

/**
 * The face and background a venue's calls use.
 *
 * The owner's face if it is still on the curated list, else the deployment's
 * `TAVUS_FACE_ID`. The background only where that face can take one (by the
 * curated model — sessions never wait on Tavus to decide), else the face's own
 * room. An owner who has not chosen gets the Belline background where it can
 * show.
 */
export function venueLook(
  settings: { faceId?: string; backgroundId?: string } | undefined,
  config: Pick<VideoConfig, "tavus">,
): { faceId: string; background: VideoBackground; greenscreen: boolean } {
  const own = curatedFace(settings?.faceId);
  const faceId = own?.id ?? config.tavus.faceId;
  const model = own?.model ?? curatedFace(faceId)?.model;
  const chosen = videoBackground(settings?.backgroundId ?? DEFAULT_BACKGROUND_ID) ?? videoBackground(DEFAULT_BACKGROUND_ID)!;
  const greenscreen = chosen.id !== ORIGINAL_BACKGROUND_ID && faceTakesBackground(model);
  return { faceId, background: greenscreen ? chosen : videoBackground(ORIGINAL_BACKGROUND_ID)!, greenscreen };
}

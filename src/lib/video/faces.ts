import type { VideoConfig } from "./config";
import { ORIGINAL_BACKGROUND_ID, DEFAULT_BACKGROUND_ID, videoBackground, type VideoBackground } from "./backgrounds";

/**
 * The stock faces an owner may choose for their receptionist.
 *
 * Eight, chosen by the founder — not Tavus's hundred-and-forty-odd. A picker
 * that offers the whole catalogue is a picker nobody finishes; these are looks
 * a business would put on its own front desk, two of them (Dr. Adams, Dr. Lee)
 * for the clinics. The first is `DEFAULT_FACE_ID`, which is also what
 * `TAVUS_FACE_ID` ships as, so a venue that never opens the picker gets Ruby
 * and nothing changes under the venues already running.
 *
 * Ids and models are from Tavus's stock face model map
 * (https://docs.tavus.io/sections/faces/stock-face-model-map), and every one is
 * still confirmed against the account with `GET /v2/faces?face_type=system&face_ids=…`
 * (https://docs.tavus.io/api-reference/faces/list-faces) before it is shown
 * or saved: an id Tavus does not return is not offered.
 *
 * All eight are Phoenix-4.5, which has one visible consequence: background
 * replacement "is not currently available with Phoenix-4.5 faces"
 * (https://docs.tavus.io/sections/conversational-video-interface/conversation/customizations/background-customizations),
 * so every face here keeps its own room and the background picker has nothing
 * to do. The backgrounds are kept, and hidden while nothing offered can use
 * them, because the moment a Phoenix-4 look is added back to this list they
 * work again — and because an owner who chose one before today still has it
 * saved.
 *
 * Every face also has a still committed to this repo
 * (`scripts/build-face-stills.ts`, `faceStillPath`). The picker used to wait
 * on Tavus for its thumbnails and show a letter in a circle whenever the key
 * was missing, the mock was in use or the API was slow, which made choosing a
 * face something you could only do on a good day. Tavus's live
 * `thumbnail_image_url` still wins where it is available; the file is the floor.
 */

export type PhoenixModel = "phoenix-4" | "phoenix-4.5";

export interface CuratedFace {
  id: string;
  name: string;
  model: PhoenixModel;
}

/** Ruby: the founder's pick, what `TAVUS_FACE_ID` ships as, and the picker's default. */
export const DEFAULT_FACE_ID = "rf90eb925bd8";

export const CURATED_FACES: readonly CuratedFace[] = [
  { id: DEFAULT_FACE_ID, name: "Ruby · Office", model: "phoenix-4.5" },
  { id: "r4dc9377a68e", name: "Priya · Office", model: "phoenix-4.5" },
  { id: "r340d93adc9b", name: "Dr. Adams", model: "phoenix-4.5" },
  { id: "r51b323e761e", name: "Dr. Lee", model: "phoenix-4.5" },
  { id: "rca764a6a197", name: "Olivia · Office", model: "phoenix-4.5" },
  { id: "rbb3d627a705", name: "Mateo", model: "phoenix-4.5" },
  { id: "rf1bd7e252de", name: "Rose · Business", model: "phoenix-4.5" },
  { id: "rb1d65103218", name: "Victor · Office", model: "phoenix-4.5" },
] as const;

/** The committed still for a face, as the browser asks for it. */
export function faceStillPath(id: string): string {
  return `/video/faces/${id}.jpg`;
}

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
              // Tavus's still where it gave one, ours where it did not: a face
              // in the picker with no picture is a face nobody picks.
              posterUrl: safeHttps(row.thumbnail_image_url) || faceStillPath(face.id),
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

/**
 * The curated list as it stands without Tavus: for the mock and an outage.
 * Never grounds for saving — but it still shows the faces, from the committed
 * stills, because an owner deciding how their receptionist looks should not
 * have to do it from eight letters in eight circles.
 */
export function unconfirmedFaces(): FaceOption[] {
  return CURATED_FACES.map((f) => ({
    id: f.id,
    name: f.name,
    model: f.model,
    backgrounds: faceTakesBackground(f.model),
    clipUrl: "",
    posterUrl: faceStillPath(f.id),
  }));
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
  // Ruby last: a deployment may point TAVUS_FACE_ID at a face of its own, but
  // an unset one must not leave the picker's default empty.
  const faceId = own?.id ?? (config.tavus.faceId || DEFAULT_FACE_ID);
  const model = own?.model ?? curatedFace(faceId)?.model;
  const chosen = videoBackground(settings?.backgroundId ?? DEFAULT_BACKGROUND_ID) ?? videoBackground(DEFAULT_BACKGROUND_ID)!;
  const greenscreen = chosen.id !== ORIGINAL_BACKGROUND_ID && faceTakesBackground(model);
  return { faceId, background: greenscreen ? chosen : videoBackground(ORIGINAL_BACKGROUND_ID)!, greenscreen };
}

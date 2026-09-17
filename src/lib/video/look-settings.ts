import type { User } from "../types";
import { canEditAgent } from "../auth";
import { getLocation } from "../store";
import { videoConfig, type VideoConfig } from "./config";
import { setVenueLook, venueVideoSettings } from "./control";
import { DEFAULT_BACKGROUND_ID, VIDEO_BACKGROUNDS, isKnownBackground } from "./backgrounds";
import { confirmedFaces, curatedFace, unconfirmedFaces, venueLook, type FaceOption } from "./faces";
import { prewarmVideoVenueSoon } from "./prewarm";

/**
 * The video receptionist's face and background, for the venue's owner
 * (Your business → Agent; route: api/agent/video).
 *
 * The same door as the agent's own settings: signed in, and allowed to edit
 * this venue's agent (`canEditAgent`) — an owner sees and changes their own
 * venue and nobody else's. A face is only ever one of the curated stock faces
 * and, when Tavus can be asked, one Tavus confirms on this account; a
 * background is only ever one of the generated options. Nothing arbitrary is
 * stored, so nothing arbitrary reaches Tavus or a visitor's page.
 */

export interface LookReply {
  status: number;
  body: Record<string, unknown>;
}

interface Deps {
  config?: VideoConfig;
  faces?: (config: VideoConfig) => Promise<FaceOption[] | null>;
  prewarm?: (location: { id: string }) => void;
}

function door(user: User | null, locationId: unknown): { reply: LookReply } | { locationId: string } {
  if (!user) return { reply: { status: 401, body: { error: "Not signed in." } } };
  const location = typeof locationId === "string" ? getLocation(locationId) : undefined;
  if (!location) return { reply: { status: 404, body: { error: "Unknown location" } } };
  if (!canEditAgent(user, location.id)) return { reply: { status: 403, body: { error: "You cannot change the agent at this venue." } } };
  return { locationId: location.id };
}

export async function readLook(user: User | null, locationId: unknown, deps: Deps = {}): Promise<LookReply> {
  const opened = door(user, locationId);
  if ("reply" in opened) return opened.reply;
  const config = deps.config ?? videoConfig();
  const confirmed = await (deps.faces ?? confirmedFaces)(config);
  const settings = venueVideoSettings(opened.locationId);
  return {
    status: 200,
    body: {
      faces: confirmed ?? unconfirmedFaces(),
      // False: Tavus could not be asked (no key, the mock, an outage); previews are missing.
      confirmed: Boolean(confirmed),
      backgrounds: VIDEO_BACKGROUNDS,
      current: {
        faceId: curatedFace(settings?.faceId)?.id ?? venueLook(settings, config).faceId,
        backgroundId: settings?.backgroundId ?? DEFAULT_BACKGROUND_ID,
      },
    },
  };
}

export async function saveLook(
  user: User | null,
  body: { locationId?: unknown; faceId?: unknown; backgroundId?: unknown },
  deps: Deps = {},
): Promise<LookReply> {
  const opened = door(user, body.locationId);
  if ("reply" in opened) return opened.reply;

  const look: { faceId?: string; backgroundId?: string } = {};
  if (body.backgroundId !== undefined) {
    if (!isKnownBackground(body.backgroundId)) return { status: 422, body: { error: "Choose a background from the list.", field: "backgroundId" } };
    look.backgroundId = body.backgroundId;
  }
  if (body.faceId !== undefined) {
    const face = typeof body.faceId === "string" ? curatedFace(body.faceId) : undefined;
    if (!face) return { status: 422, body: { error: "Choose a face from the list.", field: "faceId" } };
    // Where Tavus can be asked, the face must also be one it confirms on this account.
    const confirmed = await (deps.faces ?? confirmedFaces)(deps.config ?? videoConfig());
    if (confirmed && !confirmed.some((f) => f.id === face.id)) {
      return { status: 422, body: { error: "That face isn't available right now.", field: "faceId" } };
    }
    look.faceId = face.id;
  }
  if (!look.faceId && !look.backgroundId) return { status: 400, body: { error: "Nothing to change." } };

  const saved = setVenueLook(opened.locationId, look, user!.name || user!.email);
  // The venue's shared PAL for a new face, made now rather than in the next visitor's call.
  if (look.faceId) (deps.prewarm ?? prewarmVideoVenueSoon)({ id: opened.locationId });
  return { status: 200, body: { ok: true, faceId: saved.faceId, backgroundId: saved.backgroundId } };
}

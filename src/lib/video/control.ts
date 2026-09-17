import fs from "node:fs";
import path from "node:path";
import { dataDir } from "../store";

/**
 * Who may see the video receptionist, decided by Belline staff without a deploy.
 *
 * Two switches, both in `DATA_DIR/video.json` beside the rest of the store:
 *
 *   **The kill switch.** One click in the sales console and no venue offers
 *   video, no new session starts, and every live one is ended. For the day a
 *   provider misbehaves in public, when a redeploy is twenty minutes too long.
 *
 *   **The venue list.** Video is a prototype and goes to named venues only. A
 *   venue's entry is also where its own face, PAL and greeting will live; one
 *   default avatar serves every venue today.
 *
 * Read from disk on every call rather than cached. The file is a few hundred
 * bytes, and a kill switch that one process has not noticed yet is not a kill
 * switch.
 */

export interface VenueVideoSettings {
  enabled: boolean;
  /** The owner's pick from the curated stock faces (faces.ts); unset means `TAVUS_FACE_ID`. */
  faceId?: string;
  /** One of `VIDEO_BACKGROUNDS` (backgrounds.ts); unset means the face's own. */
  backgroundId?: string;
  palId?: string;
  /** Reserved for a venue's own opening line; unset means the standard greeting. */
  greeting?: string;
  /** Reserved for a venue's own greeting clip and poster in the bubble. */
  greetingClipUrl?: string;
  greetingPosterUrl?: string;
  /** English today. Structured for the language registry. */
  language?: "en";
  updatedBy?: string;
  updatedAt?: string;
}

/** A venue's shared PAL at Tavus (pals.ts). The key is derived, never kept here. */
export interface VenuePalRecord {
  palId: string;
  faceId: string;
  /** Hash of the PAL body it was made from: a different hash means make a new one. */
  hash: string;
  createdAt: string;
}

export interface VideoControl {
  killSwitch: { on: boolean; by?: string; at?: string; note?: string };
  venues: Record<string, VenueVideoSettings>;
  /** Shared PALs by `venueId|faceId`. */
  pals: Record<string, VenuePalRecord>;
  /** Replaced PALs, deleted once no call can still be using them. */
  retiredPals: { palId: string; at: string }[];
}

const EMPTY: VideoControl = { killSwitch: { on: false }, venues: {}, pals: {}, retiredPals: [] };

function file(): string {
  return path.join(dataDir(), "video.json");
}

export function readVideoControl(): VideoControl {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), "utf8")) as Partial<VideoControl>;
    return {
      killSwitch: { on: Boolean(raw.killSwitch?.on), by: raw.killSwitch?.by, at: raw.killSwitch?.at, note: raw.killSwitch?.note },
      venues: raw.venues && typeof raw.venues === "object" ? raw.venues : {},
      pals: raw.pals && typeof raw.pals === "object" ? raw.pals : {},
      retiredPals: Array.isArray(raw.retiredPals) ? raw.retiredPals.filter((p) => p && typeof p.palId === "string") : [],
    };
  } catch {
    return structuredClone(EMPTY);
  }
}

function write(control: VideoControl): void {
  fs.mkdirSync(dataDir(), { recursive: true });
  const target = file();
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(control, null, 2));
  fs.renameSync(temp, target);
}

export function setKillSwitch(on: boolean, by: string, note?: string): VideoControl {
  const control = readVideoControl();
  control.killSwitch = { on, by, at: new Date().toISOString(), ...(note ? { note: note.slice(0, 200) } : {}) };
  write(control);
  return control;
}

export function setVenueVideo(locationId: string, enabled: boolean, by: string): VideoControl {
  const control = readVideoControl();
  const current = control.venues[locationId];
  control.venues[locationId] = { ...current, enabled, updatedBy: by, updatedAt: new Date().toISOString() };
  write(control);
  return control;
}

/**
 * The owner's face and background. Validation is the caller's (faces.ts,
 * backgrounds.ts): this only writes. `null` clears a choice back to the default.
 */
export function setVenueLook(
  locationId: string,
  look: { faceId?: string | null; backgroundId?: string | null },
  by: string,
): VenueVideoSettings {
  const control = readVideoControl();
  const current: VenueVideoSettings = control.venues[locationId] ?? { enabled: false };
  const next: VenueVideoSettings = { ...current, updatedBy: by, updatedAt: new Date().toISOString() };
  if (look.faceId !== undefined) {
    if (look.faceId) next.faceId = look.faceId;
    else delete next.faceId;
  }
  if (look.backgroundId !== undefined) {
    if (look.backgroundId) next.backgroundId = look.backgroundId;
    else delete next.backgroundId;
  }
  control.venues[locationId] = next;
  write(control);
  return next;
}

export function palKey(locationId: string, faceId: string): string {
  return `${locationId}|${faceId}`;
}

export function readVenuePal(locationId: string, faceId: string): VenuePalRecord | undefined {
  return readVideoControl().pals[palKey(locationId, faceId)];
}

/** Keep a new shared PAL; the one it replaces (if any) is retired, not deleted yet. */
export function recordVenuePal(locationId: string, record: VenuePalRecord): void {
  const control = readVideoControl();
  const key = palKey(locationId, record.faceId);
  const previous = control.pals[key];
  if (previous && previous.palId !== record.palId) {
    control.retiredPals.push({ palId: previous.palId, at: new Date().toISOString() });
  }
  control.pals[key] = record;
  write(control);
}

/** Forget a shared PAL Tavus no longer has. */
export function forgetVenuePal(locationId: string, faceId: string, palId: string): void {
  const control = readVideoControl();
  const key = palKey(locationId, faceId);
  if (control.pals[key]?.palId !== palId) return;
  delete control.pals[key];
  write(control);
}

/** For the checks: forget every shared PAL record (nothing is deleted at Tavus). */
export function clearVenuePalRecords(): void {
  const control = readVideoControl();
  control.pals = {};
  control.retiredPals = [];
  write(control);
}

export function dropRetiredPals(palIds: string[]): void {
  if (!palIds.length) return;
  const control = readVideoControl();
  control.retiredPals = control.retiredPals.filter((p) => !palIds.includes(p.palId));
  write(control);
}

export function venueVideoSettings(locationId: string): VenueVideoSettings | undefined {
  return readVideoControl().venues[locationId];
}

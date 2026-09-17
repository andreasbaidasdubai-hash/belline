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
  /** Reserved for a venue's own avatar; unset means the deployment default. */
  faceId?: string;
  palId?: string;
  /** Reserved for a venue's own opening line; unset means the standard greeting. */
  greeting?: string;
  /** English today. Structured for the language registry. */
  language?: "en";
  updatedBy?: string;
  updatedAt?: string;
}

export interface VideoControl {
  killSwitch: { on: boolean; by?: string; at?: string; note?: string };
  venues: Record<string, VenueVideoSettings>;
}

const EMPTY: VideoControl = { killSwitch: { on: false }, venues: {} };

function file(): string {
  return path.join(dataDir(), "video.json");
}

export function readVideoControl(): VideoControl {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), "utf8")) as Partial<VideoControl>;
    return {
      killSwitch: { on: Boolean(raw.killSwitch?.on), by: raw.killSwitch?.by, at: raw.killSwitch?.at, note: raw.killSwitch?.note },
      venues: raw.venues && typeof raw.venues === "object" ? raw.venues : {},
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

export function venueVideoSettings(locationId: string): VenueVideoSettings | undefined {
  return readVideoControl().venues[locationId];
}

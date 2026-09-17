import type { Location } from "../types";
import { flagState } from "../flags";
import { listLocations } from "../store";
import { videoConfig, missingVideoConfig } from "./config";
import { readVideoControl, venueVideoSettings } from "./control";
import { venueAllowlisted } from "./availability";
import { venueLook } from "./faces";
import { videoProvider } from "./provider";
import type { VideoAvatarProvider } from "./types";

/**
 * Have a venue's shared PAL ready before anybody taps "Talk".
 *
 * Called from three places and no others: server boot (every venue video is
 * allowed for), the sales console switching video on for a venue, and an owner
 * saving a new face. Never from a page load or the widget's config — a visitor
 * opening a website must not cause a call to Tavus.
 *
 * Quiet by design: a failure here costs the first visitor a slower start (the
 * PAL is then made in their session), never an error.
 */

type Env = Record<string, string | undefined>;

export type PrewarmResult = "warmed" | "skipped" | "failed";

export async function prewarmVideoVenue(
  location: Pick<Location, "id">,
  opts: { env?: Env; provider?: VideoAvatarProvider | null } = {},
): Promise<PrewarmResult> {
  const env = opts.env ?? process.env;
  if (!flagState("video.avatar", env).on) return "skipped";
  const config = videoConfig(env);
  if (config.provider !== "tavus" || config.tavus.palMode !== "shared" || missingVideoConfig(config).length) return "skipped";
  if (readVideoControl().killSwitch.on || !venueAllowlisted(location, config)) return "skipped";
  const provider = opts.provider === undefined ? videoProvider(env, config) : opts.provider;
  if (!provider?.prewarm) return "skipped";

  const settings = venueVideoSettings(location.id);
  const look = venueLook(settings, config);
  try {
    await provider.prewarm({
      locationId: location.id,
      faceId: look.faceId,
      languages: [settings?.language ?? "en"],
      llmBaseUrl: `${config.publicOrigin}/api/video/llm`,
      palId: settings?.palId,
    });
    return "warmed";
  } catch (err) {
    console.warn(`[video] ${location.id}: could not pre-warm the shared PAL: ${err instanceof Error ? err.message : String(err)}`);
    return "failed";
  }
}

/** Fire and forget, for request handlers: the answer never waits for Tavus. */
export function prewarmVideoVenueSoon(location: Pick<Location, "id">): void {
  void prewarmVideoVenue(location).catch(() => undefined);
}

/** Server boot: every venue video is allowed for, one at a time. */
export async function prewarmAllowlistedVenues(env: Env = process.env): Promise<Record<string, PrewarmResult>> {
  const out: Record<string, PrewarmResult> = {};
  if (!flagState("video.avatar", env).on) return out;
  const config = videoConfig(env);
  for (const location of listLocations({ includeInternal: true })) {
    if (!venueAllowlisted(location, config)) continue;
    out[location.id] = await prewarmVideoVenue(location, { env });
  }
  return out;
}

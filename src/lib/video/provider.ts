import { videoConfig, type VideoConfig } from "./config";
import { MockVideoProvider } from "./mock";
import { TavusProvider } from "./tavus";
import type { VideoAvatarProvider } from "./types";

export type { VideoAvatarProvider } from "./types";

/**
 * The provider this deployment runs, from `VIDEO_AVATAR_PROVIDER`.
 *
 * `tavus` unless `mock` was asked for by name — a typo must not quietly give a
 * staging server the stand-in. Returns null rather than throwing when the mock
 * is refused here (production, a real database), so a page asking "is video
 * available?" gets a no instead of a 500.
 */

const globalRef = globalThis as unknown as {
  __bellineVideoProvider?: { key: string; provider: VideoAvatarProvider };
};

type Env = Record<string, string | undefined>;

export function videoProvider(env: Env = process.env, config: VideoConfig = videoConfig(env)): VideoAvatarProvider | null {
  const key = `${config.provider}|${config.tavus.apiBase}|${config.tavus.palMode}|${config.tavus.faceId}|${config.tavus.palId}`;
  const cached = globalRef.__bellineVideoProvider;
  if (cached?.key === key && env === process.env) return cached.provider;

  let provider: VideoAvatarProvider;
  if (config.provider === "mock") {
    try {
      provider = new MockVideoProvider(env);
    } catch {
      return null;
    }
  } else {
    provider = new TavusProvider(config);
  }
  if (env === process.env) globalRef.__bellineVideoProvider = { key, provider };
  return provider;
}

/** For the checks: swap in a provider with a fake network, or clear it. */
export function setVideoProviderForTests(provider: VideoAvatarProvider | null, env: Env = process.env): void {
  if (!provider) {
    delete globalRef.__bellineVideoProvider;
    return;
  }
  const config = videoConfig(env);
  globalRef.__bellineVideoProvider = {
    key: `${config.provider}|${config.tavus.apiBase}|${config.tavus.palMode}|${config.tavus.faceId}|${config.tavus.palId}`,
    provider,
  };
}

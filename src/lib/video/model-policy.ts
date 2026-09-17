import type { Location } from "../types";

/**
 * Which models a video turn runs on.
 *
 * On a video call the gap between the visitor's last word and the face's first
 * is the product. Most turns are small talk and questions the prompt already
 * answers, where Haiku 4.5 speaks sooner than the venue's chosen model; the
 * turns that matter most — a booking, a lead, a message for the team, an
 * availability check — all go through a tool.
 *
 * So: the fast model answers first, and the moment it reaches for any tool its
 * stream is dropped unrun and the venue's own model runs that turn
 * (`AgentSession` `fastModel`, agent/runtime.ts). The guards do not change:
 * authority rules before any model, `guardVideoClause` on every clause from
 * either model, the honesty checks against the call's own tool results.
 *
 * `VIDEO_FAST_MODEL`: unset uses `claude-haiku-4-5`; `off` turns routing off;
 * any other value must look like an Anthropic model id. A venue already on
 * the fast model runs as it always did.
 */

type Env = Record<string, string | undefined>;

export const VIDEO_FAST_MODEL_DEFAULT = "claude-haiku-4-5";

export function videoFastModel(location: Pick<Location, "agent">, env: Env = process.env): string | undefined {
  const raw = (env.VIDEO_FAST_MODEL ?? "").trim();
  if (raw.toLowerCase() === "off") return undefined;
  const fast = raw || VIDEO_FAST_MODEL_DEFAULT;
  if (!/^claude-[a-z0-9-]{3,60}$/.test(fast)) return undefined;
  return fast === location.agent.model ? undefined : fast;
}

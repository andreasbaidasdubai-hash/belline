import type { Location } from "../types";
import { openException } from "../exceptions";
import { BELLINE_TENANT_ID } from "../tenancy";
import { classifyVideoEnd, type EndFacts, type VideoEndCause, type VideoEndedBy } from "./end-reason";
import { recordVideoMetric } from "./metrics";

/**
 * What our video calls actually deliver, as opposed to what we ask for.
 *
 * `VIDEO_MAX_CALL_SECONDS` is a request, not a fact. Tavus silently caps
 * `max_call_duration` at the account's plan maximum
 * (docs/video/tavus-notes.md), and there is no API that reports the plan, the
 * tier or the minutes left — the dashboard is the only place that knows. So
 * the only way to find out what a visitor really gets is to watch what they
 * really got.
 *
 * Every ending is recorded here with the provider's own words and the real
 * duration. Two things read it:
 *
 *   **The promise.** The intro says "Calls end after X". If the provider keeps
 *   cutting calls short of X, that sentence is a lie, so `deliveredCeiling`
 *   derives the number from what was delivered, and reports that no number can
 *   be promised when the endings are too inconsistent to stand behind one.
 *
 *   **Us.** A pattern of short calls opens a ticket on the Issues page with
 *   the provider's reason and the durations on it, so it is somebody's job
 *   rather than a thing the founder notices on a demo.
 *
 * In memory, like `metrics.ts`: a session cannot outlive the process anyway.
 * The durable half is the exception row and the `video.*` events.
 */

export interface VideoEnding {
  at: string;
  locationId: string;
  sessionId: string;
  provider: string;
  /** The provider's own words, or ours. Staff-only: never rendered to a visitor. */
  reason: string;
  endedBy: VideoEndedBy;
  cause: VideoEndCause;
  /** How long the call really ran. */
  seconds: number;
  /** What this call was created with. */
  maxCallSeconds: number;
}

const KEPT = 200;

/** Endings considered when deriving the promise and when looking for a pattern. */
const WINDOW = 20;

/** This many short endings in the window before we stop promising the ceiling. */
export const SHORTFALL_SAMPLES = 3;

/**
 * A delivered length only counts as a promise when the short calls agree with
 * each other: three calls cut at 85, 87 and 88 seconds are a ceiling somebody
 * else is enforcing, and can be promised. Three cut at 20, 140 and 240 are not
 * a ceiling at all, and the honest thing is to promise no number.
 */
const CONSISTENT_RATIO = 0.75;

/** Below this, a number is not worth saying — "a short call" is more honest. */
const MIN_PROMISABLE_SECONDS = 60;

const globalRef = globalThis as unknown as { __bellineVideoEndings?: VideoEnding[] };

export function recentVideoEndings(limit = WINDOW): VideoEnding[] {
  const all = globalRef.__bellineVideoEndings ?? [];
  return all.slice(-limit).reverse();
}

export function clearVideoEndings(): void {
  globalRef.__bellineVideoEndings = [];
}

/**
 * A call reached an end nobody in the room chose: our ceiling, or the
 * provider's. These are the only endings that say anything about how long a
 * call is allowed to be — a visitor hanging up at 20 seconds says nothing.
 */
function capped(e: VideoEnding): boolean {
  return e.cause === "time_limit" || (e.cause === "cut_short" && (e.endedBy === "provider" || e.endedBy === "timer"));
}

/** A capped call that stopped well short of what that call was allowed. */
function short(e: VideoEnding): boolean {
  return capped(e) && e.cause === "cut_short";
}

export interface DeliveredCeiling {
  /**
   * The number of seconds we can honestly tell a visitor a call runs to.
   * Null: the endings do not agree on one, so the page must promise no number.
   */
  seconds: number | null;
  /** Capped endings the answer is drawn from. */
  samples: number;
  /** The provider has been ending calls short of what we asked for. */
  shortfall: boolean;
}

/**
 * What we can promise, given what we have delivered.
 *
 * With nothing to go on, the configured ceiling: it is what we ask the
 * provider for and nothing yet says otherwise. Once enough calls have been cut
 * short of it, the ceiling is no longer ours to promise, and the answer is the
 * shortest length we have actually delivered — rounded down, so the promise is
 * one a call beats rather than misses. When those short calls do not agree
 * with each other, there is no number to give and `seconds` is null.
 */
export function deliveredCeiling(configured: number, endings: VideoEnding[] = recentVideoEndings()): DeliveredCeiling {
  const window = endings.filter(capped);
  const cut = window.filter(short);
  if (cut.length < SHORTFALL_SAMPLES) return { seconds: configured, samples: window.length, shortfall: false };

  const lengths = cut.map((e) => e.seconds).sort((a, b) => a - b);
  const low = lengths[0];
  const high = lengths[lengths.length - 1];
  // Too spread to be anybody's ceiling: we know it is not `configured`, and we
  // do not know what it is. Say so rather than invent a number.
  if (high <= 0 || low / high < CONSISTENT_RATIO) return { seconds: null, samples: window.length, shortfall: true };

  const rounded = Math.floor(low / 15) * 15;
  if (rounded < MIN_PROMISABLE_SECONDS) return { seconds: null, samples: window.length, shortfall: true };
  return { seconds: Math.min(configured, rounded), samples: window.length, shortfall: true };
}

/**
 * Record how a call ended, and raise a ticket once a pattern is there.
 *
 * The ticket is Belline's own, whichever venue the call was on: a provider
 * cutting calls short is our account, not the customer's problem, and it is
 * the Belline team who can look at the plan.
 */
export function recordVideoEnding(
  location: Pick<Location, "id" | "tenantId" | "businessId">,
  facts: EndFacts & { sessionId: string; provider: string },
): VideoEnding {
  const cause = classifyVideoEnd(facts);
  const ending: VideoEnding = {
    at: new Date().toISOString(),
    locationId: location.id,
    sessionId: facts.sessionId,
    provider: facts.provider,
    reason: facts.reason.slice(0, 120),
    endedBy: facts.endedBy,
    cause,
    seconds: Math.max(0, Math.round(facts.seconds)),
    maxCallSeconds: facts.maxCallSeconds,
  };
  const list = (globalRef.__bellineVideoEndings ??= []);
  list.push(ending);
  if (list.length > KEPT) list.splice(0, list.length - KEPT);

  // The cause and the real length, beside the reason `ended` already carried:
  // "why did this stop, and how long did the visitor actually get?".
  recordVideoMetric(location, { name: "ended_cause", sessionId: ending.sessionId, ms: ending.seconds * 1000, detail: `${cause}:${ending.reason}` });

  // One line per ending, with the provider's own words: the log is the first
  // place anybody looks, and the reason was missing from it entirely.
  console.log(
    `[video] ${ending.sessionId} ended after ${ending.seconds}s of ${ending.maxCallSeconds}s — ${cause} (${ending.provider}: ${ending.reason || "no reason given"}, by ${ending.endedBy})`,
  );

  if (short(ending)) raiseShortfall(location, ending);
  return ending;
}

/**
 * Tavus refused a call because the *account* is at capacity.
 *
 * Recorded and ticketed apart from our own `busy`, because it means something
 * different and needs a different fix. Our refusal is the venue being full, and
 * the ceilings are ours to raise. This one says `VIDEO_PROVIDER_MAX_CONCURRENT`
 * is set above what the plan really allows — we let a visitor all the way to a
 * room that was never going to open. Tavus publishes no plan endpoint, so this
 * refusal is the only place that number is ever checked against reality.
 *
 * Raised on the first occurrence rather than after a pattern: unlike a call cut
 * short, one of these is already a visitor turned away by a misconfiguration.
 * `openException` keeps one open row per venue and kind, so it cannot flood.
 */
export function recordProviderAtCapacity(
  location: Pick<Location, "id" | "tenantId" | "businessId">,
  facts: { sessionId: string; provider: string; reason: string; ourCeiling: number; live: number },
): void {
  console.warn(
    `[video] ${facts.sessionId} refused by ${facts.provider} for concurrency with ${facts.live} live here and a configured ceiling of ${facts.ourCeiling} — ${facts.reason || "no reason given"}`,
  );
  recordVideoMetric(location, { name: "provider_at_capacity", sessionId: facts.sessionId, detail: facts.provider });
  openException({
    tenantId: BELLINE_TENANT_ID,
    locationId: location.id,
    kind: "video_provider_at_capacity",
    reason: `${facts.provider} refused a video call for concurrency while ${facts.live} were live and VIDEO_PROVIDER_MAX_CONCURRENT is ${facts.ourCeiling}.`,
    context: {
      provider: facts.provider,
      providerReason: facts.reason.slice(0, 160),
      configuredCeiling: facts.ourCeiling,
      liveWhenRefused: facts.live,
    },
    source: "system",
  });
}

function raiseShortfall(location: Pick<Location, "id" | "tenantId">, latest: VideoEnding): void {
  const cut = recentVideoEndings().filter(short);
  if (cut.length < SHORTFALL_SAMPLES) return;
  const lengths = cut.map((e) => e.seconds);
  const reasons = [...new Set(cut.map((e) => e.reason))].slice(0, 3).join("; ");
  openException({
    tenantId: BELLINE_TENANT_ID,
    locationId: location.id,
    kind: "video_calls_cut_short",
    reason: `${cut.length} of the last ${WINDOW} video calls ended at ${Math.min(...lengths)}–${Math.max(...lengths)}s, short of the ${latest.maxCallSeconds}s we ask for.`,
    context: {
      provider: latest.provider,
      providerReason: reasons,
      shortest: Math.min(...lengths),
      longest: Math.max(...lengths),
      askedFor: latest.maxCallSeconds,
      calls: cut.length,
    },
    source: "system",
  });
}

/**
 * Why a video call ended, in words a visitor may read.
 *
 * A call can stop for a dozen reasons and the visitor only ever needs to know
 * three things: did it end because they said so, because the time we promised
 * ran out, or because something went wrong that was not their doing. This
 * module turns every raw reason in the system into one of those, and holds the
 * one copy of the sentences said about them.
 *
 * Two rules the checks pin:
 *
 *   **A visitor never reads a raw reason or a provider's name.** The strings
 *   below are the whole vocabulary. `max_call_duration reached`, `tavus`,
 *   `client_mic_denied` and the rest stay on our side of the line, in
 *   `delivery.ts` and the staff console.
 *
 *   **Nothing is blamed on the visitor.** A call cut short is ours to
 *   apologise for, so the wording says what happened and what they can do
 *   next, and never suggests they hung up or broke something.
 *
 * No imports: this file is bundled into the visitor's panel as well as read on
 * the server.
 */

/** Who or what ended the session, as `sessions.ts` records it. */
export type VideoEndedBy = "visitor" | "unload" | "provider" | "timer" | "kill_switch" | "agent" | "staff";

/**
 * What the visitor is told, and nothing finer. The raw reason behind each of
 * these is kept for us (see `shortfall.ts`), never shown.
 */
export type VideoEndCause =
  /** They pressed End, closed the panel, or moved to chat or the phone. */
  | "visitor"
  /** The receptionist finished the conversation, or a person at Belline stopped it. */
  | "wrapped_up"
  /** The time we told them about up front ran out. */
  | "time_limit"
  /** It stopped early and not because of anything they did. */
  | "cut_short"
  /** The connection went. */
  | "connection";

/**
 * How close to the promised ceiling still counts as "the time ran out".
 *
 * The provider's own maximum fires a little before ours does, and a room takes
 * a second or two to close, so a call that reaches within this of the ceiling
 * reached it.
 */
export const AT_LIMIT_SLACK_SECONDS = 15;

/** Reasons the provider sends that mean the visitor had already gone. */
const PROVIDER_VISITOR_LEFT = /participant_(left|absent)_timeout/i;

/** Reasons that mean the room or the network gave out rather than anybody deciding. */
const CONNECTION = /(daily_room_has_been_deleted|bot_could_not_join|internal error|exception_encountered|network|agent_left)/i;

export interface EndFacts {
  /** The raw reason, as recorded. Never shown to a visitor. */
  reason: string;
  endedBy: VideoEndedBy;
  /** How long the call actually ran. */
  seconds: number;
  /** The ceiling this call was created with. */
  maxCallSeconds: number;
}

/**
 * One raw ending, classified.
 *
 * The interesting case is the provider's `max_call_duration`: it means "the
 * time ran out" when the call actually reached the ceiling we promised, and
 * "cut short" when it did not — which is the whole difference between a limit
 * working and a limit being overruled by somebody else's account.
 */
export function classifyVideoEnd(facts: EndFacts): VideoEndCause {
  const reason = facts.reason.toLowerCase();
  const reachedCeiling = facts.seconds >= facts.maxCallSeconds - AT_LIMIT_SLACK_SECONDS;

  // The visitor's own doing, however it reached us.
  if (facts.endedBy === "visitor" || facts.endedBy === "unload") {
    return reason.includes("mic_denied") || reason.includes("error") ? "cut_short" : "visitor";
  }
  if (facts.endedBy === "provider" && PROVIDER_VISITOR_LEFT.test(reason)) return "visitor";

  // Ours, and announced: the ceiling we told them about.
  // Ours, and announced: our backstop timer, or the panel's own clock reaching
  // the limit the intro told them about.
  if (facts.endedBy === "timer" && /^(max_duration|client_duration)/.test(reason)) return "time_limit";
  if (reason.startsWith("never_joined")) return "visitor";

  // A person or the receptionist deciding the conversation was done.
  if (facts.endedBy === "agent" || facts.endedBy === "staff" || facts.endedBy === "kill_switch") {
    return reason.startsWith("agent_ended") ? "wrapped_up" : "cut_short";
  }

  if (CONNECTION.test(reason)) return "connection";

  // The provider's own shutdown. At the ceiling it is the limit doing its job;
  // short of it, somebody else ended our call and the visitor is owed better
  // than a shrug.
  if (facts.endedBy === "provider") return reachedCeiling ? "time_limit" : "cut_short";

  return reachedCeiling ? "time_limit" : "cut_short";
}

/** Did this call stop early, through no decision of the visitor's? */
export function endedUnexpectedly(cause: VideoEndCause): boolean {
  return cause === "time_limit" || cause === "cut_short" || cause === "connection";
}

// ---------------------------------------------------------------------------
// What the visitor reads

export interface EndCopy {
  /** The heading over the panel's end state. */
  title: string;
  /** One calm sentence: what happened, and never whose fault it was. */
  body: string;
}

/**
 * The end-of-call line.
 *
 * `promisedWords` is what the page actually promised this visitor — "5
 * minutes", or empty when the page made no promise (see `promise.ts`). It is
 * only spent on the one case where the promise came true, so a page that
 * cannot promise a number never has one put in its mouth here either.
 */
export function endCopy(cause: VideoEndCause, agentName: string, promisedWords = ""): EndCopy {
  switch (cause) {
    case "time_limit":
      return {
        title: "That's our time",
        body: promisedWords
          ? `Video calls here run up to ${promisedWords}, and we've reached it. You can start again, or carry on in chat — ${agentName} will still have the thread.`
          : `We've reached the length we keep these calls to. You can start again, or carry on in chat — ${agentName} will still have the thread.`,
      };
    case "cut_short":
      return {
        title: "The call ended early",
        body: `Sorry — that stopped sooner than it should have, and it wasn't anything you did. You can start again, or carry on in chat where ${agentName} will pick up where you left off.`,
      };
    case "connection":
      return {
        title: "The connection dropped",
        body: `We lost the call. You can start again, or carry on in chat with ${agentName} — chat copes better with a patchy connection.`,
      };
    case "wrapped_up":
      return {
        title: "Call ended",
        body: `Thanks for talking to ${agentName}. Start again any time, or carry on in chat.`,
      };
    case "visitor":
    default:
      return {
        title: "Call ended",
        body: `Thanks for talking to ${agentName}. Start again any time, or carry on in chat.`,
      };
  }
}

/** The two ways on from an ended call. Shown together, in this order, everywhere. */
export const END_ACTIONS = { again: "Start again", chat: "Continue in chat" } as const;

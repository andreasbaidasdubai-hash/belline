import crypto from "node:crypto";
import type { EmbedConfig, EmbedMode, Location } from "./types";
import { listCalls } from "./store";
import { todayIn } from "./time";
import type { ChannelAccount } from "./reception/types";
import { listAccounts, saveAccount } from "./reception/repo";

/**
 * Belline, typed rather than spoken, on a venue's own website.
 *
 * The argument for building this is not that a chat widget is exciting. It is
 * that the *channel* layer was already here: `webchat` has been in the Channel
 * union since the first reception migration, a conversation does not care what
 * wire it arrived on, and the handoff, the honesty check and the booking engine
 * are all channel-neutral already. What was missing was a transport, and our
 * own page is the easiest transport there is.
 *
 * The argument for it as a *product* is narrower and worth writing down, since
 * it decides how it is sold: the bell is the differentiated thing and the chat
 * bubble is the conventional one. A visitor on a train, in an open-plan office
 * or beside a sleeping child will not talk out loud to a website — and today
 * they leave. So this exists to catch the person who would otherwise bounce,
 * not to replace the thing that makes Belline worth looking at.
 *
 * Which is why it is not priced separately. Channels cost nothing at the
 * margin; minutes and messages cost, and the plan already meters those. Charging
 * per mouth would invite the only question a pricing page must never provoke:
 * what exactly do I get for the base plan, then?
 *
 * Three things keep a public, unauthenticated, model-backed endpoint from being
 * somebody's free Claude account:
 *
 *   **The origin allowlist**, shared with the voice widget and enforced by the
 *   browser through `frame-ancestors` rather than by us.
 *
 *   **A signed visitor id.** Anonymous, but not interchangeable — see
 *   `signVisitorToken`. Without it a visitor could ask for a stranger's thread.
 *
 *   **Two ceilings, both the venue's own.** Conversations a day, and messages
 *   in one conversation. The failure being designed against is not a botnet; it
 *   is a slow afternoon, an unattended tab, and a curious teenager.
 */

export const WEBCHAT_DEFAULTS = {
  /** A busy small business gets nowhere near this. A bot reaches it in a minute. */
  maxChatsPerDay: 60,
  /**
   * Long enough for a real booking with a change of mind in the middle; short
   * enough that nobody is running a conversation for sport.
   */
  maxMessagesPerChat: 40,
} as const;

// The mode predicates live in embed.ts, beside the rest of the widget, because
// the entitlement that guards the voice socket needs them and must not have to
// import a module that reaches for Postgres to ask a question about a config
// object. Re-exported here so a reader of this file is not sent hunting.
import { chatAllowed } from "./embed";
export { modeOf, voiceAllowed, chatAllowed } from "./embed";

// ---------------------------------------------------------------------------
// Who the visitor is
// ---------------------------------------------------------------------------

/**
 * The handle a website visitor is stored under.
 *
 * `web:` and then an opaque id. Deliberately not a fake phone number: a row
 * that looks like a number will eventually be dialled, texted or matched
 * against a real customer by something written next year.
 *
 * Kept to base64url so it survives being a URL segment, a JSON string and a
 * Postgres check constraint without anybody thinking about escaping.
 */
export function newVisitorId(): string {
  return crypto.randomBytes(12).toString("base64url");
}

export function visitorHandle(visitorId: string): string {
  return `web:${visitorId}`;
}

/** True for the handles that really are telephone numbers. */
export function isPhoneHandle(handle: string | undefined): boolean {
  return Boolean(handle && handle.startsWith("+"));
}

/**
 * What to show a member of staff instead of a phone number.
 *
 * The inbox shows the handle beside the name, and `web:AbCd…` is a database
 * row leaking into a colleague's afternoon.
 */
export function describeHandle(handle: string | undefined): string {
  if (!handle) return "Unknown";
  return isPhoneHandle(handle) ? handle : "Website visitor";
}

// ---------------------------------------------------------------------------
// The account
// ---------------------------------------------------------------------------

/**
 * The venue's web chat account, created the first time somebody types.
 *
 * A telephone number has to be connected by a person because it exists outside
 * this system and somebody has to prove they own it. A web chat account has no
 * such thing to verify — the origin allowlist already established that this is
 * the venue's own website — so making a business click a button to create a row
 * we could create ourselves is ceremony, not security.
 *
 * `phoneE164` is left null, which the unique index on (channel, phone_e164) is
 * already partial for: many venues, no numbers, no collisions.
 */
export async function ensureWebchatAccount(location: Location): Promise<ChannelAccount> {
  const found = async () =>
    (await listAccounts(location.tenantId)).find(
      (a) => a.channel === "webchat" && a.locationId === location.id,
    );

  const existing = await found();
  if (existing) return existing;

  try {
    return await saveAccount({
      tenantId: location.tenantId,
      businessId: location.businessId,
      locationId: location.id,
      channel: "webchat",
      provider: "webchat",
    });
  } catch (err) {
    // Two first-ever visitors in the same second. The unique index in
    // 003_webchat.sql is what decides, and the loser reads the winner's row
    // rather than failing a visitor's first message over a race.
    const raced = await found();
    if (raced) return raced;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// The ceilings
// ---------------------------------------------------------------------------

export interface ChatGate {
  allowed: boolean;
  used: number;
  limit: number;
  /** Shown in the widget instead of a reply. Never a technical message. */
  message?: string;
}

/**
 * Has this venue's chat had enough for one day?
 *
 * Counts conversations, not messages: a ceiling on messages would cut a real
 * customer off mid-booking on a busy day, which is the opposite of the point.
 * Counted off the venue's own episode records, so it agrees with what the
 * dashboard shows them.
 */
export function chatGate(location: Location): ChatGate {
  const config = location.embed;
  if (!chatAllowed(config)) return { allowed: false, used: 0, limit: 0 };

  const limit = config?.maxChatsPerDay ?? WEBCHAT_DEFAULTS.maxChatsPerDay;
  const today = todayIn(location.timezone);
  const used = listCalls(location.id).filter(
    (call) => call.channel === "webchat" && call.startedAt.slice(0, 10) === today,
  ).length;

  if (used < limit) return { allowed: true, used, limit };

  return {
    allowed: false,
    used,
    limit,
    message:
      "We've had a lot of messages through the website today. Please ring us instead — we'd rather not keep you waiting.",
  };
}

// ---------------------------------------------------------------------------
// One turn at a time
// ---------------------------------------------------------------------------

/**
 * Stop one visitor running two turns at once.
 *
 * Not a rate limit in the abuse sense — the ceilings above are that. This is
 * the double-submit: somebody presses send, nothing appears for two seconds
 * because a model is thinking, and they press it again. Two turns then answer
 * the same thread, each unaware of the other, and the second one's history is
 * missing the first one's reply.
 *
 * In memory and per process, which is the honest shape: it protects against a
 * person's own second click, and a person's second click arrives at the same
 * process as their first.
 */
/** When a visitor may next start a turn. Nothing before that time is accepted. */
const slots = new Map<string, number>();

/** The gap after a finished turn, so a double-click cannot become two messages. */
const TURN_GAP_MS = 900;
/**
 * How long a running turn holds the slot.
 *
 * A ceiling, not an expectation — a turn takes two or three seconds. It exists
 * because a process that dies mid-turn would otherwise lock that visitor out of
 * their own conversation until they cleared their browser.
 */
const TURN_LEASE_MS = 60_000;

export function takeTurnSlot(visitorId: string): boolean {
  const now = Date.now();
  const readyAt = slots.get(visitorId);
  if (readyAt !== undefined && now < readyAt) return false;
  slots.set(visitorId, now + TURN_LEASE_MS);
  return true;
}

export function releaseTurnSlot(visitorId: string): void {
  slots.set(visitorId, Date.now() + TURN_GAP_MS);
}

/** For the tests, and for nothing else. */
export function clearTurnSlots(): void {
  slots.clear();
}

export function messageCeiling(location: Location): number {
  return location.embed?.maxMessagesPerChat ?? WEBCHAT_DEFAULTS.maxMessagesPerChat;
}

/**
 * The line shown when one conversation has run long.
 *
 * Not a refusal dressed up as a technical limit. A conversation this long
 * either needs a person or is not a conversation, and both are better served by
 * a name and a number than by "rate limit exceeded".
 */
export function ceilingMessage(location: Location): string {
  const number = location.phone ? ` on ${location.phone}` : "";
  return `I've taken this as far as I can here. Please give us a ring${number} and someone will pick it up from where we left off.`;
}

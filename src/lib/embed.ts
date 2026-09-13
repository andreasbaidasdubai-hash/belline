import crypto from "node:crypto";
import type { EmbedAppearance, EmbedConfig, EmbedMode, Location } from "./types";
import { listCalls, upsertLocation } from "./store";
import { todayIn } from "./time";

/**
 * What a venue's widget offers a visitor: the bell, the chat, or both.
 *
 * Unset means `voice`. Every site already carrying this script switched the
 * widget on when a bell was the only thing it could be, and adding a chat
 * bubble to somebody's live website because we shipped a feature would be a
 * change they did not make.
 */
export function modeOf(config: EmbedConfig | undefined): EmbedMode | null {
  if (!config?.enabled) return null;
  return config.mode ?? "voice";
}

/**
 * A mode from whatever arrived over the wire.
 *
 * Returns undefined for anything it does not recognise, and the caller then
 * leaves the venue where it was. Storing an unrecognised string would be
 * worse than refusing it: every predicate above would return false, and the
 * dashboard would show a widget that is switched on and offers nothing —
 * which is the hardest of the available failures to diagnose from the outside.
 */
export function parseMode(raw: unknown): EmbedMode | undefined {
  return raw === "voice" || raw === "chat" || raw === "both" ? raw : undefined;
}

export function voiceAllowed(config: EmbedConfig | undefined): boolean {
  const mode = modeOf(config);
  return mode === "voice" || mode === "both";
}

export function chatAllowed(config: EmbedConfig | undefined): boolean {
  const mode = modeOf(config);
  return mode === "chat" || mode === "both";
}

/**
 * Belline on a venue's own website.
 *
 * The third channel. A customer's site gets a bell in the corner; a visitor
 * taps it and is talking to that venue's receptionist a second later — the
 * same agent, the same diary, the same refusals as the telephone. No form, no
 * chat transcript, no "how can I help you today?" bubble.
 *
 * Until now this existed only for us: `/call` resolves Belline's own venue by
 * a hard-coded id, and `mayStreamTo` refused anything that was not a demo of
 * ours. That refusal was right — it is the thing stopping a stranger spending
 * a customer's minutes — so making the widget real means adding a deliberate
 * entitlement rather than loosening the guard.
 *
 * Three things carry the security of a public widget, and none of them is the
 * key:
 *
 *   **The key is public.** It sits in the customer's page source, like a
 *   Stripe publishable key or an analytics id. Treating it as a secret would
 *   be pretending, and a design that depends on a visible string staying
 *   private is a design that fails the first time somebody views source.
 *
 *   **The origin allowlist is the real control.** The embed page refuses to
 *   be framed by anything the venue has not named, enforced by
 *   `frame-ancestors`, which the browser applies rather than us.
 *
 *   **The caps are the backstop.** An allowlisted page is still a public page,
 *   and a public page can be refreshed by somebody bored. A venue's widget has
 *   a daily ceiling and a per-call ceiling, both the venue's own, because the
 *   failure being designed against is not malice — it is a slow afternoon and
 *   an unattended tab.
 */

/** Public, and short enough to read over the phone if it comes to that. */
export function newEmbedKey(): string {
  return `be_${crypto.randomBytes(9).toString("base64url")}`;
}

export const EMBED_DEFAULTS = {
  /** Enough for a busy small business; low enough that a bad day is survivable. */
  maxCallsPerDay: 40,
  /** Shorter than a telephone call. Somebody on a website is deciding, not chatting. */
  maxCallSeconds: 300,
} as const;

/**
 * Turn the widget on for a venue, minting a key if it has none.
 *
 * Origins are required. An empty allowlist means the embed page can be framed
 * by nobody, which is a widget that does not work — so the caller must say
 * where it is going before it will go anywhere.
 */
export function enableEmbed(
  location: Location,
  origins: string[],
  limits?: Partial<
    Pick<EmbedConfig, "maxCallsPerDay" | "maxCallSeconds" | "maxChatsPerDay" | "maxMessagesPerChat">
  >,
  mode?: EmbedMode,
  appearance?: EmbedAppearance,
): Location {
  const cleaned = origins.map(normaliseOrigin).filter((o): o is string => Boolean(o));
  const embed: EmbedConfig = {
    key: location.embed?.key ?? newEmbedKey(),
    appearance: appearance ?? location.embed?.appearance,
    enabled: true,
    allowedOrigins: [...new Set(cleaned)],
    maxCallsPerDay: limits?.maxCallsPerDay ?? location.embed?.maxCallsPerDay ?? EMBED_DEFAULTS.maxCallsPerDay,
    maxCallSeconds: limits?.maxCallSeconds ?? location.embed?.maxCallSeconds ?? EMBED_DEFAULTS.maxCallSeconds,
    /**
     * What the widget offers. Switching the widget on without saying leaves a
     * venue where it already was — and a venue that has never had it gets both,
     * because a business turning this on today is choosing from what exists
     * today, not from what existed before web chat did.
     */
    mode: mode ?? location.embed?.mode ?? "both",
    maxChatsPerDay: limits?.maxChatsPerDay ?? location.embed?.maxChatsPerDay,
    maxMessagesPerChat: limits?.maxMessagesPerChat ?? location.embed?.maxMessagesPerChat,
  };
  return upsertLocation({ ...location, embed });
}

export function disableEmbed(location: Location): Location {
  if (!location.embed) return location;
  // The key is kept rather than destroyed: switching the widget off for an
  // afternoon should not mean re-editing the customer's website to switch it
  // back on.
  return upsertLocation({ ...location, embed: { ...location.embed, enabled: false } });
}

/**
 * `https://example.com` from whatever somebody typed.
 *
 * Scheme and host only — a path or a query in an allowlist entry never matches
 * anything, because a browser sends an origin and an origin has neither.
 * Returns null for anything unparseable rather than guessing, since a wrong
 * entry silently breaks the widget on the customer's live site.
 */
export function normaliseOrigin(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Is this page allowed to frame the widget?
 *
 * `www.` is treated as the same site as the bare domain in both directions.
 * Forcing a venue to list both is a support ticket dressed up as a security
 * control: they will list one, it will work on their staging site and fail on
 * their live one, and nobody will know why.
 */
export function originAllowed(config: EmbedConfig, origin: string | null): boolean {
  if (!config.enabled) return false;
  const asked = origin ? normaliseOrigin(origin) : null;
  if (!asked) return false;
  const strip = (o: string) => o.replace("://www.", "://");
  return config.allowedOrigins.some((allowed) => strip(allowed) === strip(asked));
}

export interface EmbedGate {
  allowed: boolean;
  used: number;
  limit: number;
  /** Shown in the widget instead of a call. Never a technical message. */
  message?: string;
}

/**
 * Has this venue's widget had enough for one day?
 *
 * Counts browser calls only. A venue whose telephone is busy should not find
 * its website widget switched off as a result — they are separate channels
 * with separate budgets, and conflating them would make a good day on the
 * phone look like an outage on the site.
 */
export function checkEmbedGate(location: Location): EmbedGate {
  const config = location.embed;
  if (!config?.enabled) return { allowed: false, used: 0, limit: 0 };
  // A venue that chose the chat and not the bell. The key is real and the
  // origin is allowed; the spoken channel is simply not one they switched on.
  if (!voiceAllowed(config)) {
    return {
      allowed: false,
      used: 0,
      limit: 0,
      message: "Calling isn't switched on for this website. Send a message instead and we'll reply.",
    };
  }

  const today = todayIn(location.timezone);
  // `embed`, not `browser`: the test console is `browser` too, and counting it
  // here meant a member of staff trying their agent forty times switched the
  // widget off for the day — while the widget screen reported their calls as
  // visitors'.
  const used = listCalls(location.id).filter(
    (call) => call.channel === "embed" && call.startedAt.slice(0, 10) === today,
  ).length;

  if (used < config.maxCallsPerDay) {
    return { allowed: true, used, limit: config.maxCallsPerDay };
  }

  return {
    allowed: false,
    used,
    limit: config.maxCallsPerDay,
    message:
      "We've had a lot of calls through the website today. Please ring us instead — we'd rather not keep you waiting.",
  };
}

/**
 * The snippet a venue pastes into their own site.
 *
 * One line, no build step, no npm package, nothing to configure. The most
 * common thing on the other end of this is a Squarespace footer box, and
 * anything that needs more than a paste will not get installed.
 */
export function embedSnippet(location: Location, origin = "https://app.belline.ai"): string {
  const key = location.embed?.key ?? "YOUR_KEY";
  const mode = location.embed?.mode ?? "voice";
  // The mode is written into the snippet rather than left to the default,
  // because the default has to stay "voice" for every site already carrying
  // this line — and a venue that chose chat should not have to discover an
  // attribute to get it.
  return `<script src="${origin}/embed.js" data-belline="${key}" data-mode="${mode}" async></script>`;
}

// ---------------------------------------------------------------------------
// How it looks

export {
  APPEARANCE_RULES,
  EMBED_PALETTE,
  accentHex,
  contrastRatio,
  parseAppearance,
  resolveAppearance,
  textOn,
  type AppearanceProblem,
} from "./embed-look";
import { resolveAppearance } from "./embed-look";

/**
 * What the widget fetches on load: the venue's choices and nothing else.
 *
 * Public by design — it is served to every visitor of the customer's site —
 * so it is built from a whitelist. The origins list, the ceilings and the
 * key's owner are not in it and must not be.
 */
export function widgetConfig(config: EmbedConfig, whatsappLink: string | null) {
  const look = resolveAppearance(config.appearance);
  return {
    mode: modeOf(config) ?? "voice",
    ...look,
    whatsappLink: look.whatsapp ? whatsappLink : null,
  };
}

import type {
  Channel,
  ChannelAccount,
  InboundMessage,
  Provider,
  StatusUpdate,
} from "../types";

/**
 * A way of reaching somebody.
 *
 * The whole feature turns on this file being boring. Everything above it —
 * the brain, the tools, the booking engine, the handoff — has no idea which
 * provider delivered a message, and an adapter's entire job is to stop
 * anything provider-shaped getting past it. A `messaging_product` field or a
 * `wamid.` prefix appearing anywhere else is a bug in the adapter, not a
 * detail to handle downstream.
 *
 * Two implementations from the start, on purpose. Meta's Cloud API is the
 * official platform and the cheaper one per conversation; Twilio is a reseller
 * whose credentials are already in production for voice and SMS, and whose
 * sandbox answers within the hour rather than after a Business verification
 * that takes days. Building both before either is in production is what makes
 * the interface honest — a second implementation written a month later gets
 * bent to fit the first one's assumptions.
 */

export interface OutboundText {
  type: "text";
  text: string;
}

export type SendResult =
  | { ok: true; providerMessageId: string }
  | {
      ok: false;
      /** For the log and the inbox, never shown to a customer. */
      detail: string;
      /** True when trying again might work: a timeout, a 5xx, a rate limit. */
      retryable: boolean;
    };

/**
 * What an adapter needs to talk to one account.
 *
 * Credentials arrive already decrypted, from the one caller allowed to open
 * them. The adapter never reads the database and never touches the key.
 */
export interface AdapterCredentials {
  [key: string]: string;
}

export interface ChannelAdapter {
  readonly provider: Provider;
  readonly channel: Channel;

  /**
   * Meta's one-time handshake, and nothing else's.
   *
   * Returns the string to echo, or null to refuse. It is a separate method
   * rather than part of `parse` because the provider that needs it sends it
   * as a GET with no body, and folding two shapes into one function is how the
   * refusal path stops being tested.
   */
  verifyChallenge?(params: URLSearchParams): string | null;

  /**
   * Is this really from the provider?
   *
   * Takes the raw body, not a parsed object: every signature scheme here is
   * over the exact bytes, and `JSON.parse` followed by `JSON.stringify` does
   * not reproduce them. Called before anything is parsed.
   */
  verifySignature(raw: string, headers: Headers, url: string): boolean;

  /** Provider envelope in, normalised messages out. Never throws on shape. */
  parse(raw: string): { messages: InboundMessage[]; statuses: StatusUpdate[] };

  send(
    account: ChannelAccount,
    credentials: AdapterCredentials,
    to: string,
    message: OutboundText,
  ): Promise<SendResult>;

  /** A voice note, fetched as bytes. Undefined where the provider has no media. */
  downloadMedia?(
    account: ChannelAccount,
    credentials: AdapterCredentials,
    mediaId: string,
  ): Promise<{ bytes: Buffer; mime: string } | null>;
}

/**
 * Normalise a number to E.164, or return it untouched.
 *
 * Deliberately narrow: it strips what providers decorate numbers with —
 * `whatsapp:` prefixes, spaces, brackets — and adds the leading `+` that Meta
 * omits. It does not guess a country code. A number stored twice in two
 * formats is two customers, and a number guessed wrong is somebody else's.
 */
export function toE164(raw: string): string {
  const cleaned = raw.replace(/^whatsapp:/i, "").replace(/[\s()\-.]/g, "");
  if (cleaned.startsWith("+")) return cleaned;

  // Meta sends `wa_id` as bare digits, always international. The leading digit
  // is what makes this safe to assume: no country calling code begins with a
  // zero, so `0501234567` is a national number whose country we do not know —
  // and `+0501234567` would be a customer filed under a number that does not
  // exist. Seven to fifteen digits is E.164's own range.
  if (/^[1-9]\d{6,14}$/.test(cleaned)) return `+${cleaned}`;

  // Anything else is returned as it arrived. It will not match an existing
  // customer, which is the correct outcome: failing to recognise somebody is
  // recoverable, filing them under somebody else's number is not.
  return cleaned;
}

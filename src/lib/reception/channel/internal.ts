import type { InboundMessage, StatusUpdate } from "../types";
import type { AdapterCredentials, ChannelAdapter, OutboundText, SendResult } from "./index";

/**
 * A channel with no wire.
 *
 * Messages in and out are real — the same pipeline, the same dedup, the same
 * agent, the same booking engine — but nothing leaves the process. What
 * Belline says is recorded rather than delivered.
 *
 * Two uses, and the second is why this is a real adapter rather than a test
 * fixture.
 *
 * **Showing the thing before there is a number.** Connecting a business's own
 * WhatsApp number takes a Meta Business verification that runs for days. This
 * lets the whole journey be driven and read now, against the real model and
 * the real diary, with the wire as the only missing piece.
 *
 * **Web chat, later.** A chat panel on a venue's own site is exactly this: a
 * conversation whose transport is our own page rather than somebody else's
 * network. When that ships it is this adapter plus a socket, not a new
 * channel.
 *
 * The outbox is in memory and per-process, which is the honest shape for what
 * it is. Anything that needed to survive a restart would be a message, and
 * messages already live in Postgres.
 */

export interface Delivered {
  to: string;
  text: string;
  at: string;
  providerMessageId: string;
}

const outbox: Delivered[] = [];

/** Everything Belline has said on this channel, oldest first. */
export function internalOutbox(): Delivered[] {
  return [...outbox];
}

export function clearInternalOutbox(): void {
  outbox.length = 0;
}

let counter = 0;

export const internalAdapter: ChannelAdapter = {
  provider: "internal",
  channel: "whatsapp",

  /**
   * Nothing to verify.
   *
   * Deliberately explicit rather than inherited: an adapter that returns true
   * from `verifySignature` must be one that is never reachable from the public
   * webhook, and `adapterFor` in the route only ever picks meta or twilio.
   * If that ever changes, this comment is the thing that should stop it.
   */
  verifySignature() {
    return false;
  },

  parse() {
    // Messages are handed to `acceptInbound` directly; there is no envelope.
    return { messages: [] as InboundMessage[], statuses: [] as StatusUpdate[] };
  },

  async send(_account, _credentials: AdapterCredentials, to, message: OutboundText): Promise<SendResult> {
    const providerMessageId = `internal_${Date.now()}_${++counter}`;
    outbox.push({ to, text: message.text, at: new Date().toISOString(), providerMessageId });
    return { ok: true, providerMessageId };
  },
};

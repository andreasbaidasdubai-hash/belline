import type { InboundMessage, StatusUpdate } from "../types";
import type { AdapterCredentials, ChannelAdapter, OutboundText, SendResult } from "./index";

/**
 * The channel whose network is this application.
 *
 * Every other adapter hands a reply to somebody else's infrastructure and hopes.
 * This one has nothing to hand it to: the visitor's page is already asking for
 * anything newer than the last thing it showed, and by the time `send` is
 * called the reply is a committed row. So delivery is recording, and the poll is
 * the wire.
 *
 * That is not a shortcut — it is the property that makes web chat the cheapest
 * channel to operate and the only one where a colleague typing in the inbox
 * reaches the customer with no extra machinery. It is also why there is no
 * `verifySignature` worth writing: nothing arrives here from outside. A web chat
 * message comes in through `/api/webchat/[key]`, which authenticates a signed
 * visitor token and an allowlisted origin, not a provider's HMAC.
 *
 * Marked `sent` rather than `delivered` on purpose. "Delivered" would be a claim
 * about a browser we cannot see; the poll that collects the message is what
 * would know, and a read receipt is not a thing this product promises anybody.
 */

let counter = 0;

export const webchatAdapter: ChannelAdapter = {
  provider: "webchat",
  channel: "webchat",

  /**
   * Nothing arrives from a provider, so nothing can be verified from one.
   *
   * Explicitly false rather than true, for the same reason as the internal
   * adapter: if this is ever reached from the public webhook route, that is a
   * routing bug, and refusing is how it shows up as one instead of as an open
   * door. `adapterFor` in the webhook route only ever picks meta or twilio.
   */
  verifySignature() {
    return false;
  },

  parse() {
    return { messages: [] as InboundMessage[], statuses: [] as StatusUpdate[] };
  },

  async send(
    _account,
    _credentials: AdapterCredentials,
    _to,
    _message: OutboundText,
  ): Promise<SendResult> {
    // The id exists so the message row has one, and so the visitor's page can
    // tell one reply from the next. It is ours, not a provider's, and the
    // unique index it lands in is per conversation.
    return { ok: true, providerMessageId: `web_${Date.now()}_${++counter}` };
  },
};

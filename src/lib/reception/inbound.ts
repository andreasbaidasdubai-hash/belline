import type { ChannelAccount, InboundMessage, StatusUpdate } from "./types";
import {
  accountForInbound,
  createConversation,
  markDelivery,
  openConversationFor,
  recordMessage,
  upsertCustomer,
} from "./repo";
import { track } from "./events";

/**
 * A message arriving, turned into rows.
 *
 * Everything that happens between "a webhook landed" and "Belline has
 * something to answer". Deliberately separate from the route, because the
 * route has one job that is measured in milliseconds — verify, store, return
 * 200 — and this is the part that can take its time.
 *
 * The order matters and is the same every time:
 *
 *   1. Which business owns the number it was sent to. Until this is known
 *      there is no tenant, and until there is a tenant nothing else may be
 *      written.
 *   2. Who sent it, created if we have never seen them.
 *   3. Which conversation it belongs to, opened if there is none.
 *   4. Record it — and stop here if we have already seen this provider id,
 *      because a retried webhook must change nothing.
 */

export interface Accepted {
  /** False when this exact message has already been handled. */
  fresh: boolean;
  tenantId: string;
  businessId: string;
  conversationId: number;
  customerId: number;
  /** Present on a text message; absent on audio and on anything unsupported. */
  text?: string;
  message: InboundMessage;
}

export type Rejected =
  | { reason: "unknown_number"; detail: string }
  | { reason: "ai_disabled"; detail: string };

export async function acceptInbound(
  inbound: InboundMessage,
  /**
   * The account, when the caller already knows it.
   *
   * Every channel with a wire is identified by the number it was sent to, which
   * is what `accountForInbound` looks up. Web chat has no number — the request
   * arrives at a URL carrying the venue's embed key, and that key has already
   * been resolved to a venue and checked against the origin allowlist before
   * anything gets here. So the caller passes the account rather than the lookup
   * inventing a number for it to find.
   *
   * Passed in rather than branching here, so that the order below — tenant,
   * customer, conversation, dedup — stays the single path every channel takes.
   */
  resolved?: ChannelAccount,
): Promise<{ ok: true; accepted: Accepted } | { ok: false; rejected: Rejected }> {
  const account =
    resolved ??
    (await accountForInbound(inbound.channel, {
      phoneE164: inbound.toE164,
      externalNumberId: inbound.externalNumberId,
    }));

  if (!account) {
    // A webhook for a number nobody has connected. Not an error worth
    // retrying, and not something to store — we have no tenant to store it
    // against, which is exactly the property that keeps tenancy honest.
    return {
      ok: false,
      rejected: {
        reason: "unknown_number",
        detail: `No ${inbound.channel} account for ${inbound.toE164 ?? inbound.externalNumberId ?? "unknown"}`,
      },
    };
  }

  const customer = await upsertCustomer(account.tenantId, inbound.fromE164, {
    // Only fills a blank — see the repository. A WhatsApp profile name is
    // what somebody chose to call themselves, not necessarily their booking
    // name, and it must never overwrite one a person typed.
    firstName: inbound.profileName?.trim() || undefined,
  });

  const existing = await openConversationFor(account.tenantId, customer.id, inbound.channel);
  const conversation =
    existing ??
    (await createConversation({
      tenantId: account.tenantId,
      businessId: account.businessId,
      locationId: account.locationId,
      channel: inbound.channel,
      channelAccountId: account.id,
      customerId: customer.id,
    }));

  if (!existing) {
    await track({
      tenantId: account.tenantId,
      businessId: account.businessId,
      locationId: account.locationId,
      channel: inbound.channel,
      conversationId: conversation.id,
      name: "conversation.started",
    });
  }

  const stored = await recordMessage({
    tenantId: account.tenantId,
    conversationId: conversation.id,
    sender: "customer",
    direction: "in",
    contentType: inbound.content.type === "text" ? "text" : inbound.content.type,
    body: inbound.content.type === "text" ? inbound.content.text : undefined,
    meta:
      inbound.content.type === "audio"
        ? { mediaId: inbound.content.mediaId, mime: inbound.content.mime }
        : inbound.content.type === "unsupported"
          ? { kind: inbound.content.kind }
          : {},
    providerMessageId: inbound.providerMessageId,
  });

  if (!stored.duplicate) {
    await track({
      tenantId: account.tenantId,
      businessId: account.businessId,
      channel: inbound.channel,
      conversationId: conversation.id,
      name: "message.received",
      payload: { contentType: inbound.content.type },
    });
  }

  return {
    ok: true,
    accepted: {
      fresh: !stored.duplicate,
      tenantId: account.tenantId,
      businessId: account.businessId,
      conversationId: conversation.id,
      customerId: customer.id,
      text: inbound.content.type === "text" ? inbound.content.text : undefined,
      message: inbound,
    },
  };
}

/**
 * A delivery receipt.
 *
 * Cheap and best-effort. A status for a message we never sent is not an error
 * — Twilio and Meta both send receipts for things that predate a redeploy —
 * so it updates nothing and says nothing.
 */
export async function acceptStatus(
  channel: InboundMessage["channel"],
  match: { phoneE164?: string; externalNumberId?: string },
  status: StatusUpdate,
): Promise<void> {
  const account = await accountForInbound(channel, match);
  if (!account) return;
  await markDelivery(account.tenantId, status.providerMessageId, status.status, status.error);
}

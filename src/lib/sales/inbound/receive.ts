/**
 * What happens when mail arrives.
 *
 * This is the file the whole piece exists for. Everything else parses, verifies
 * or classifies; this decides, and the decisions are the ones that cost money
 * when they are wrong:
 *
 *  - A **human reply** stops that lead's sequence everywhere — the state, the
 *    items already on this afternoon's clock, the follow-up planned for next
 *    week — and appears against the lead with what they wrote. Whatever it
 *    says. "Not interested" and "call me Thursday" are different for a person
 *    and identical for the machine: somebody is in the conversation now, so
 *    the machine gets out of it.
 *
 *  - An **out-of-office pauses, and never stops**. It is the difference
 *    between a working pipeline and one that silently dies: an auto-responder
 *    is proof the address is live and that nobody has read the message, and
 *    stopping on it loses the lead with no error anywhere for anybody to see.
 *    The sequence stands still until they are back and then resumes by itself.
 *
 *  - A **bounce** suppresses only when it is permanent. A 4.x.x is a mailbox
 *    that was full on Tuesday, not a person who asked to be left alone.
 *
 *  - An **opt-out written in prose** suppresses when it is unmistakable and
 *    goes to a person when it is not. There is no third option where we guess:
 *    both wrong guesses — suppressing a business that wanted a call, writing
 *    again to somebody who said stop — are worse than a line in a queue.
 *
 * Idempotent throughout, because SNS redelivers and says so. The provider's
 * message id is the key, the database holds the uniqueness, and every action
 * below is a no-op the second time: halting a halted sequence, suppressing a
 * suppressed address, pausing to a moment already passed.
 */

import { log } from "../db/repo/activity";
import { recordLeadEvent } from "../../staff/leads";
import { suppressCompany } from "../sending/replies";
import { blankState, halt, pause } from "../sending/sequence";
import {
  addressesIn,
  baseAddress,
  parseMessageId,
  tokenInAddress,
  verifyReplyToken,
} from "../sending/threading";
import {
  sendingStore,
  type InboundKind,
  type InboundReply,
  type MatchedBy,
  type SendItem,
  type SendingStore,
} from "../sending/store";
import { classify, type Classification } from "./classify";
import { parseMessage, type ParsedMessage } from "./mime";

export type Env = Record<string, string | undefined>;

/**
 * How long an out-of-office holds a sequence when it does not say.
 *
 * Most do not. A week is the shortest gap that reliably outlasts a holiday
 * somebody did not date, and short enough that a lead paused by a stale
 * auto-rule comes back quickly.
 */
export const DEFAULT_PAUSE_DAYS = 7;

// ---------------------------------------------------------------------------
// Which send, which lead
// ---------------------------------------------------------------------------

export interface Match {
  item: SendItem | null;
  leadId: number | null;
  companyId: number | null;
  mailboxId: number | null;
  matchedBy: MatchedBy;
}

export interface MatchInput {
  message: ParsedMessage;
  /** The envelope recipients, from the provider. More reliable than `To`. */
  recipients: readonly string[];
  store: SendingStore;
  env?: Env;
  /** A bounce names the address that failed, which is not the From. */
  failedRecipient?: string | null;
}

/**
 * Work out which send this answers, in descending order of certainty.
 *
 * The order is the point. Threading names one message; a plus-address names
 * one message; an address names at best a person, and at a shared mailbox not
 * even that. Which rule fired is recorded on the row, so a matching strategy
 * that starts going wrong is visible in the data rather than inferred from
 * somebody complaining that a sequence stopped.
 */
export async function matchMessage(input: MatchInput): Promise<Match> {
  const { message, store } = input;
  const env = input.env ?? process.env;

  // 1. Threading. In-Reply-To first, then References newest-last — the last
  //    entry is the message being replied to, the earlier ones are the thread.
  const threadIds = [message.inReplyTo, ...[...message.references].reverse()].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  for (const id of threadIds) {
    const byLookup = await store.itemByMessageId(id);
    if (byLookup) return withItem(byLookup, "thread");
    const itemId = parseMessageId(id, env);
    if (itemId === null) continue;
    const item = await store.getItem(itemId);
    if (item) return withItem(item, "thread");
  }

  // 2. The plus-address we sent as Reply-To.
  const candidates = [...input.recipients, ...message.to, ...addressesIn(message.headers.get("delivered-to"))];
  for (const address of candidates) {
    const token = tokenInAddress(address);
    if (!token) continue;
    const byToken = await store.itemByReplyToken(token);
    if (byToken) return withItem(byToken, "plus_address");
    const itemId = verifyReplyToken(token, env);
    if (itemId === null) continue;
    const item = await store.getItem(itemId);
    if (item) return withItem(item, "plus_address");
  }

  // 3. The address itself. A lead, never a particular send — and only the most
  //    recent one, because an address we wrote to twice has two items and the
  //    older one is not what they are answering.
  const from = input.failedRecipient ?? message.from;
  if (from) {
    const target = baseAddress(from);
    const items = await store.listItems({ limit: 2000 });
    const mine = items
      .filter((i) => baseAddress(i.toAddress) === target)
      .sort((a, b) => b.id - a.id)[0];
    if (mine) return withItem(mine, "address");
  }

  // Nothing matched. The message is still recorded — an unattributable reply is
  // a thing a person needs to see, not a thing to drop.
  const mailboxId = await mailboxFor(store, [...input.recipients, ...message.to]);
  return { item: null, leadId: null, companyId: null, mailboxId, matchedBy: "none" };

  function withItem(item: SendItem, matchedBy: MatchedBy): Match {
    return { item, leadId: item.leadId, companyId: item.companyId, mailboxId: item.mailboxId, matchedBy };
  }
}

/** Which of our mailboxes this was addressed to, ignoring any plus-suffix. */
async function mailboxFor(store: SendingStore, addresses: readonly string[]): Promise<number | null> {
  const mailboxes = await store.listMailboxes();
  for (const address of addresses) {
    const bare = baseAddress(address);
    const hit = mailboxes.find((m) => baseAddress(m.address) === bare || baseAddress(m.replyTo ?? "") === bare);
    if (hit) return hit.id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Taking it in
// ---------------------------------------------------------------------------

export type InboundAction =
  | "stopped"
  | "paused"
  | "suppressed"
  | "flagged"
  | "noted"
  | "ignored"
  | "duplicate";

export interface InboundOutcome {
  action: InboundAction;
  kind: InboundKind;
  reply: InboundReply | null;
  /** When a pause was applied, the moment the sequence resumes. */
  pausedUntil: string | null;
  matchedBy: MatchedBy;
  leadId: number | null;
  /** One sentence, for a log line and for the webhook's own response. */
  summary: string;
}

export interface ReceiveInput {
  provider: string;
  /** The provider's own id for this message. The idempotency key. */
  providerMessageId: string;
  raw: string;
  recipients?: readonly string[];
  receivedAt?: string;
  /** SES said this failed its spam or virus check. */
  spam?: boolean;
  virus?: boolean;
  store?: SendingStore;
  env?: Env;
  now?: Date;
}

export async function receiveInbound(input: ReceiveInput): Promise<InboundOutcome> {
  const store = input.store ?? sendingStore();
  const env = input.env ?? process.env;
  const now = input.now ?? new Date();

  // Idempotency, before anything is parsed or written.
  const seen = await store.findInbound(input.provider, input.providerMessageId);
  if (seen) {
    return {
      action: "duplicate",
      kind: seen.kind,
      reply: seen,
      pausedUntil: seen.pausedUntil,
      matchedBy: seen.matchedBy,
      leadId: seen.leadId,
      summary: "already taken in",
    };
  }

  if (input.virus) {
    return ignored("SES found a virus in it", "unknown");
  }

  const message = parseMessage(input.raw);
  const verdict = classify({ message, now });
  const match = await matchMessage({
    message,
    recipients: input.recipients ?? [],
    store,
    env,
    failedRecipient: verdict.failedRecipient,
  });

  if (input.spam && match.matchedBy === "none") {
    // Spam that answers nothing we sent is spam. Spam that threads back to one
    // of our own messages is a prospect whose mail server marked us, and
    // dropping that would be dropping a reply.
    return ignored("SES marked it as spam and it answers nothing we sent", "unknown");
  }

  const kind = verdict.kind;
  const optOutCertain = verdict.optOut === "certain" && (kind === "reply" || kind === "auto_reply");
  // A machine never suppresses a company on its own. An auto-reply that reads
  // like an opt-out — "no longer works here", most often — is a person's
  // decision to make, not a pattern's.
  const suppressNow = optOutCertain && kind === "reply";
  const needsReview =
    verdict.optOut === "likely" ||
    (optOutCertain && kind === "auto_reply") ||
    match.matchedBy === "none";

  const pausedUntil =
    kind === "auto_reply" && !suppressNow
      ? new Date(verdict.backAt?.getTime() ?? now.getTime() + DEFAULT_PAUSE_DAYS * 86_400_000)
      : null;

  const reply = await store.addReply({
    leadId: match.leadId,
    itemId: match.item?.id ?? null,
    mailboxId: match.mailboxId,
    fromAddress: message.from ?? "(no sender)",
    toAddress: (input.recipients ?? message.to)[0] ?? null,
    subject: message.subject,
    body: (message.text || message.fullText).slice(0, 20_000),
    kind,
    isOptOut: suppressNow,
    optOutConfidence: verdict.optOut,
    needsReview,
    matchedBy: match.matchedBy,
    provider: input.provider,
    providerMessageId: input.providerMessageId,
    rfcMessageId: message.messageId,
    inReplyTo: message.inReplyTo,
    pausedUntil: null,
    receivedAt: input.receivedAt ?? message.date ?? now.toISOString(),
  });

  // Nothing to act on: recorded, and a person will see it because nothing
  // matched.
  if (match.leadId === null) {
    return {
      action: needsReview ? "flagged" : "noted",
      kind,
      reply,
      pausedUntil: null,
      matchedBy: match.matchedBy,
      leadId: null,
      summary: `${describe(kind)} from ${message.from ?? "an unknown sender"}, matched to no lead`,
    };
  }

  const state = (await store.getSequence(match.leadId)) ?? blankState(match.leadId, match.companyId, match.item?.countryCode ?? null);

  // -- an out-of-office: stand still --------------------------------------
  if (kind === "auto_reply" && pausedUntil) {
    const paused = pause(state, pausedUntil, verdict.why, now);
    await store.upsertSequence(paused);
    // Anything already on today's clock moves with it. Cancelling would be the
    // easy thing and the wrong one: a cancelled item is a follow-up that never
    // happens, and this lead has not answered anything yet.
    if (paused.pausedUntil) {
      for (const item of await store.listItems({ leadId: match.leadId, status: ["planned", "queued"] })) {
        if (item.scheduledFor && item.scheduledFor < paused.pausedUntil) {
          await store.updateItem(item.id, { scheduledFor: paused.pausedUntil });
        }
      }
    }
    await store.markReplyPaused(reply.id, paused.pausedUntil ?? null);
    await store.addEvent({
      mailboxId: match.mailboxId,
      domainId: null,
      leadId: match.leadId,
      itemId: match.item?.id ?? null,
      kind: "reply",
      detail: { auto: true, pausedUntil: paused.pausedUntil, why: verdict.why },
    });
    await note(match, {
      type: "note",
      summary: `Out of office — sequence paused until ${(paused.pausedUntil ?? "").slice(0, 10)}, then it resumes by itself`,
    });
    return {
      action: "paused",
      kind,
      reply: { ...reply, pausedUntil: paused.pausedUntil },
      pausedUntil: paused.pausedUntil,
      matchedBy: match.matchedBy,
      leadId: match.leadId,
      summary: `out of office — paused until ${(paused.pausedUntil ?? "").slice(0, 10)}`,
    };
  }

  // -- a bounce ------------------------------------------------------------
  if (kind === "bounce") {
    await store.addEvent({
      mailboxId: match.mailboxId,
      domainId: null,
      leadId: match.leadId,
      itemId: match.item?.id ?? null,
      kind: "bounce",
      detail: { permanent: verdict.permanentFailure, why: verdict.why, recipient: verdict.failedRecipient },
    });
    if (!verdict.permanentFailure) {
      // Temporary. Nothing stops, nothing is suppressed — the next attempt is
      // allowed to find a mailbox that is no longer full.
      return {
        action: "noted",
        kind,
        reply,
        pausedUntil: null,
        matchedBy: match.matchedBy,
        leadId: match.leadId,
        summary: `a temporary delivery failure: ${verdict.why}`,
      };
    }
    await store.upsertSequence(halt(state, "bounced", now));
    await cancelQueued(store, match.leadId, "stopped: the address bounced");
    await store.suppress({
      matchType: "email",
      value: verdict.failedRecipient ?? match.item?.toAddress ?? message.from ?? "",
      reason: "bounce",
      source: "inbound-mail",
    });
    await note(match, { type: "note", summary: `Bounced permanently — ${verdict.why}` });
    return {
      action: "stopped",
      kind,
      reply,
      pausedUntil: null,
      matchedBy: match.matchedBy,
      leadId: match.leadId,
      summary: `a permanent bounce: ${verdict.why}`,
    };
  }

  // -- a complaint ---------------------------------------------------------
  if (kind === "complaint") {
    await store.upsertSequence(halt(state, "complaint", now));
    await cancelQueued(store, match.leadId, "stopped: they marked it as spam");
    await suppressCompany(
      { email: message.from, companyId: match.companyId, reason: "complaint", by: "inbound-mail" },
      store,
    );
    await store.addEvent({
      mailboxId: match.mailboxId,
      domainId: null,
      leadId: match.leadId,
      itemId: match.item?.id ?? null,
      kind: "complaint",
      detail: { why: verdict.why },
    });
    await note(match, { type: "suppressed", summary: "Marked as spam — company suppressed for good" });
    return {
      action: "suppressed",
      kind,
      reply,
      pausedUntil: null,
      matchedBy: match.matchedBy,
      leadId: match.leadId,
      summary: "a spam complaint — the company is suppressed",
    };
  }

  // -- a person wrote back -------------------------------------------------
  await store.upsertSequence(halt(state, suppressNow ? "unsubscribed" : "replied", now));
  await cancelQueued(store, match.leadId, `stopped: ${suppressNow ? "they asked to stop" : "they replied"}`);
  await store.addEvent({
    mailboxId: match.mailboxId,
    domainId: null,
    leadId: match.leadId,
    itemId: match.item?.id ?? null,
    kind: suppressNow ? "unsubscribe" : "reply",
    detail: { from: message.from, matchedBy: match.matchedBy, optOut: verdict.optOut },
  });

  if (suppressNow) {
    await suppressCompany(
      { email: message.from, companyId: match.companyId, reason: "opt_out", by: "inbound-mail" },
      store,
    );
    await note(match, { type: "suppressed", summary: "Asked to stop — sequence halted, company suppressed" });
    return {
      action: "suppressed",
      kind,
      reply,
      pausedUntil: null,
      matchedBy: match.matchedBy,
      leadId: match.leadId,
      summary: "they asked to be taken off — suppressed",
    };
  }

  await note(match, {
    type: "replied",
    summary: `Replied: ${message.subject ?? "(no subject)"}`,
  });
  return {
    action: needsReview ? "flagged" : "stopped",
    kind,
    reply,
    pausedUntil: null,
    matchedBy: match.matchedBy,
    leadId: match.leadId,
    summary: needsReview
      ? "they replied, and it may be an opt-out — flagged for a person"
      : "they replied — the sequence has stopped",
  };

  function ignored(why: string, k: InboundKind): InboundOutcome {
    return { action: "ignored", kind: k, reply: null, pausedUntil: null, matchedBy: "none", leadId: null, summary: why };
  }
}

async function cancelQueued(store: SendingStore, leadId: number, reason: string): Promise<void> {
  for (const item of await store.listItems({ leadId, status: ["planned", "queued"] })) {
    await store.updateItem(item.id, { status: "cancelled", blockedReason: reason });
  }
}

/**
 * The lead's timeline, best effort.
 *
 * Swallowed on failure, deliberately and for the same reason as in the
 * dispatcher: the timeline is what a person reads, and the stop above is what
 * protects the prospect. A timeline write that throws must not make us believe
 * the stop did not happen.
 */
async function note(
  match: Match,
  entry: { type: "replied" | "suppressed" | "note"; summary: string },
): Promise<void> {
  if (match.leadId === null) return;
  try {
    await log({
      leadId: match.leadId,
      companyId: match.companyId,
      actor: "inbound-mail",
      type: entry.type === "note" ? "replied" : entry.type,
      summary: entry.summary,
      data: { itemId: match.item?.id ?? null, matchedBy: match.matchedBy },
    });
    recordLeadEvent(`db:${match.leadId}`, {
      type: entry.type === "suppressed" ? "unsubscribed" : "replied",
      summary: entry.summary,
      actor: "inbound-mail",
    });
  } catch {
    // See above.
  }
}

function describe(kind: InboundKind): string {
  return kind === "auto_reply"
    ? "An automatic reply"
    : kind === "bounce"
      ? "A bounce"
      : kind === "complaint"
        ? "A spam complaint"
        : "A reply";
}

export type { Classification };

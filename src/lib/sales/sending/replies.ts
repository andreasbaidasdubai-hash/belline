/**
 * Replies, and the one thing they all do.
 *
 * Whatever a reply says, it stops the sequence. "Not interested", "send me
 * pricing", an out-of-office and a furious one-liner are different for a
 * person and identical for the machine: somebody is now in the conversation,
 * so the machine gets out of it. Classification can come later and is not
 * allowed to gate the stop, because a classifier that is wrong about an
 * out-of-office sends a follow-up to someone on holiday and a classifier that
 * is wrong about a complaint sends a follow-up to someone who is angry.
 *
 * An opt-out phrase in the reply does more: it suppresses the whole company,
 * permanently, on the same reasoning as the unsubscribe link.
 */

import { looksLikeOptOut } from "../compliance/suppression";
import { log } from "../db/repo/activity";
import { recordLeadEvent } from "../../staff/leads";
import { blankState, halt } from "./sequence";
import { sendingStore, type InboundReply, type SendingStore, type StopReason } from "./store";

export interface IncomingReply {
  fromAddress: string;
  subject?: string | null;
  body: string;
  /** The item this is a reply to, when the provider or headers tell us. */
  itemId?: number | null;
  leadId?: number | null;
  mailboxId?: number | null;
  receivedAt?: string;
}

export interface ReplyResult {
  reply: InboundReply;
  stopped: boolean;
  optOut: boolean;
}

/**
 * Take a reply in.
 *
 * Idempotent in the way that matters: stopping an already-stopped sequence is
 * a no-op, and suppressing an already-suppressed address is a no-op, so a
 * provider redelivering a webhook cannot do damage.
 */
export async function receiveReply(input: IncomingReply, store: SendingStore = sendingStore()): Promise<ReplyResult> {
  const optOut = looksLikeOptOut(input.body);

  let leadId = input.leadId ?? null;
  let companyId: number | null = null;
  let mailboxId = input.mailboxId ?? null;

  if (input.itemId) {
    const items = await store.listItems({ limit: 2000 });
    const item = items.find((i) => i.id === input.itemId);
    if (item) {
      leadId = leadId ?? item.leadId;
      companyId = item.companyId;
      mailboxId = mailboxId ?? item.mailboxId;
    }
  }

  const reply = await store.addReply({
    leadId,
    itemId: input.itemId ?? null,
    mailboxId,
    fromAddress: input.fromAddress,
    subject: input.subject ?? null,
    body: input.body.slice(0, 20_000),
    isOptOut: optOut,
    receivedAt: input.receivedAt,
  });

  let stopped = false;
  if (leadId !== null) {
    const state = (await store.getSequence(leadId)) ?? blankState(leadId, companyId, null);
    const reason: StopReason = optOut ? "unsubscribed" : "replied";
    const next = halt(state, reason, new Date(reply.receivedAt));
    await store.upsertSequence(next);
    stopped = next.status === "stopped";

    // Cancel anything still queued for this lead. The sequence state alone
    // would stop the next *plan*, but an item already on the clock for this
    // afternoon has to come off it too.
    for (const item of await store.listItems({ leadId, status: ["planned", "queued"] })) {
      await store.updateItem(item.id, { status: "cancelled", blockedReason: `stopped: ${reason}` });
    }

    await store.addEvent({
      mailboxId,
      domainId: null,
      leadId,
      itemId: input.itemId ?? null,
      kind: optOut ? "unsubscribe" : "reply",
      detail: { from: input.fromAddress },
    });

    try {
      await log({
        leadId,
        companyId,
        actor: `prospect:${input.fromAddress}`,
        type: optOut ? "suppressed" : "replied",
        summary: optOut ? "Asked to stop" : (input.subject ?? "Replied"),
        data: { itemId: input.itemId ?? null },
      });
      recordLeadEvent(`db:${leadId}`, {
        type: optOut ? "unsubscribed" : "replied",
        summary: optOut ? "Asked to stop — sequence halted" : `Replied: ${input.subject ?? "(no subject)"}`,
        actor: "outreach-engine",
      });
    } catch {
      // The timeline is a convenience; the stop above is the thing that matters.
    }
  }

  if (optOut) {
    await suppressCompany({ email: input.fromAddress, companyId, reason: "opt_out" }, store);
  }

  return { reply, stopped, optOut };
}

/**
 * Suppress an address and, when we know it, the company behind it.
 *
 * Company-wide is not an over-reach. A practice manager saying "stop" is
 * saying it for the practice, and writing to the owner next month because it
 * was a different mailbox is precisely the behaviour that earns a complaint —
 * and in DACH, a letter.
 */
export async function suppressCompany(
  input: {
    email?: string | null;
    domain?: string | null;
    companyId: number | null;
    reason: "opt_out" | "complaint" | "manual";
    by?: string;
  },
  store: SendingStore = sendingStore(),
): Promise<void> {
  const createdBy = input.by ?? "system";
  const add = (matchType: "email" | "domain" | "company_id", value: string) =>
    store.suppress({ matchType, value, reason: input.reason, source: "outreach-engine", createdBy });

  if (input.email) {
    await add("email", input.email);
    const at = input.email.indexOf("@");
    // The address's own domain as well. Someone who opts out at `info@` has
    // opted out for `manager@`, and treating those as two opinions is how a
    // business is written to after asking you to stop.
    if (at > -1) await add("domain", input.email.slice(at + 1));
  }
  if (input.domain) await add("domain", input.domain);
  if (input.companyId !== null) await add("company_id", String(input.companyId));
}

/**
 * Someone clicked into their demo.
 *
 * Also a stop. The email's whole job was that click; once it has happened a
 * follow-up asking whether they saw it is a machine talking over a person who
 * is already listening.
 */
export async function demoOpened(leadId: number, store: SendingStore = sendingStore()): Promise<void> {
  const state = await store.getSequence(leadId);
  if (!state || state.status !== "active") return;
  await store.upsertSequence(halt(state, "demo_clicked", new Date()));
  for (const item of await store.listItems({ leadId, status: ["planned", "queued"] })) {
    await store.updateItem(item.id, { status: "cancelled", blockedReason: "stopped: they opened the demo" });
  }
  await store.addEvent({
    mailboxId: null,
    domainId: null,
    leadId,
    itemId: null,
    kind: "demo_view",
    detail: {},
  });
}

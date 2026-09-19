/**
 * The send.
 *
 * Everything else in this module decides; this is the only file that acts. It
 * takes one item whose minute has arrived, re-runs the gate, and hands the
 * bytes to an adapter. Four properties are worth stating, because each one is
 * load-bearing and none is obvious from the code alone:
 *
 *  - **The adapter is an argument.** `dispatch` never calls `resolveAdapter`
 *    itself, so a test can prove that no code path here reaches a provider.
 *    `dispatchDue` is the wiring, and it is the single place that resolves one.
 *
 *  - **The gate runs again.** An approval can be hours old. Someone can
 *    unsubscribe between approval and 15:42, and the whole point of a
 *    suppression list is that it wins even then.
 *
 *  - **The batch must be approved, by a person.** `approvedBy` is read off the
 *    batch row and a null refuses the send. There is no autonomous mode.
 *
 *  - **Status is written before the provider call and after it.** A crash
 *    between the two leaves `sending`, which the recovery path treats as "may
 *    or may not have gone" and never silently retries — a duplicate cold email
 *    is worse than a missing one.
 */

import { legalIdentity } from "../../legal/identity";
import { log } from "../db/repo/activity";
import { effectiveRule, type CountryOverride } from "./countries";
import { screen } from "./compliance";
import { assertSendable, type OutboundEmail, type SendAdapter } from "./provider";
import { resolveAdapter } from "./adapters";
import { unsubscribeHeaders, unsubscribeUrl, unsubscribeSecretPresent } from "./unsubscribe";
import { mintMessageId, mintReplyToken, plusAddress } from "./threading";
import { advance, blankState, spacingFor } from "./sequence";
import {
  sendingStore,
  type SendItem,
  type SendingMailbox,
  type SendingStore,
} from "./store";

export interface DispatchDeps {
  store?: SendingStore;
  env?: Record<string, string | undefined>;
  now?: Date;
  origin: string;
}

export type DispatchOutcome =
  | { ok: true; item: SendItem; providerMessageId: string }
  | { ok: false; item: SendItem; reason: string; retryable: boolean };

/**
 * Send one item through the adapter it is given.
 *
 * Never throws for an expected refusal — a blocked item is a recorded outcome,
 * not an exception, because the caller is a loop over a day's worth of them.
 */
export async function dispatch(
  item: SendItem,
  mailbox: SendingMailbox,
  adapter: SendAdapter,
  deps: DispatchDeps,
): Promise<DispatchOutcome> {
  const store = deps.store ?? sendingStore();
  const env = deps.env ?? process.env;
  const now = deps.now ?? new Date();
  const identity = legalIdentity(env);

  const batch = item.batchId === null ? null : await store.getBatch(item.batchId);
  if (!batch || batch.status !== "approved" || !batch.approvedBy) {
    return refuse(store, item, "this batch has not been approved by anybody", false);
  }

  // The gate, a second time. Facts re-read now, not the ones from approval.
  const overrides = (await store.listCountryOverrides()) as CountryOverride[];
  const country = effectiveRule(item.countryCode, overrides);
  const suppressed = await store.suppressed({
    email: item.toAddress,
    companyId: item.companyId,
  });
  const sequence = await store.getSequence(item.leadId);

  const verdict = screen({
    companyName: item.toAddress,
    toAddress: item.toAddress,
    countryCode: item.countryCode,
    country,
    identity,
    suppressed,
    step: item.step,
    // Counted from this engine's own record, which is the one that matters at
    // send time; the drafting step already checked the wider 90-day history.
    touches90d: (await store.listItems({ leadId: item.leadId, status: ["sent"] })).length,
    lastTouchAt: sequence?.lastSentAt ?? null,
    hasDemoLink: true,
    hasResearch: true,
    sequenceStopped: sequence && sequence.status === "stopped" ? (sequence.stopReason ?? "stopped") : null,
    sequencePausedUntil: sequence?.pausedUntil ?? null,
    guardProblems: [],
    canSignUnsubscribe: unsubscribeSecretPresent(env),
    engineReady: true,
    now,
  });
  if (!verdict.ok) {
    return refuse(store, item, verdict.blocks[0].reason, false);
  }

  if (!item.unsubscribeToken) {
    return refuse(store, item, "no unsubscribe token on this item", false);
  }

  // The two identifiers a reply will come back with. Minted here and written
  // down in the same update that marks the item as sending, so the row an
  // inbound message looks for is already there before the bytes leave.
  let rfcMessageId: string;
  let replyToken: string;
  try {
    replyToken = item.replyToken ?? mintReplyToken(item.id, env);
    rfcMessageId = item.rfcMessageId ?? mintMessageId(item.id, mailbox.address.split("@")[1] ?? "", env);
  } catch (err) {
    return refuse(store, item, (err as Error).message, false);
  }

  const url = unsubscribeUrl(deps.origin, item.unsubscribeToken);
  const message: OutboundEmail = {
    from: mailbox.address,
    fromName: mailbox.displayName,
    to: item.toAddress,
    subject: item.subject,
    text: item.body,
    // The plus-address, not the bare mailbox: it is what identifies the send
    // when a mail client strips the threading headers, which some do.
    replyTo: plusAddress(mailbox.replyTo ?? mailbox.address, replyToken),
    messageId: rfcMessageId,
    headers: unsubscribeHeaders({ url, mailto: mailbox.replyTo ?? mailbox.address }),
    tags: { belline_step: String(item.step), belline_item: String(item.id) },
  };

  try {
    assertSendable(message, identity);
  } catch (err) {
    return refuse(store, item, (err as Error).message, false);
  }

  await store.updateItem(item.id, { status: "sending", rfcMessageId, replyToken });

  let receipt;
  try {
    receipt = await adapter.send(message);
  } catch (err) {
    const retryable = (err as { retryable?: boolean }).retryable === true;
    const updated = await store.updateItem(item.id, {
      status: retryable ? "planned" : "failed",
      error: (err as Error).message.slice(0, 500),
    });
    await store.addEvent({
      mailboxId: mailbox.id,
      domainId: mailbox.domainId,
      leadId: item.leadId,
      itemId: item.id,
      kind: "failed",
      detail: { error: (err as Error).message.slice(0, 300), retryable },
    });
    return { ok: false, item: updated ?? item, reason: (err as Error).message, retryable };
  }

  const sent =
    (await store.updateItem(item.id, {
      status: "sent",
      sentAt: now.toISOString(),
      provider: receipt.provider,
      providerMsgId: receipt.providerMessageId,
      error: null,
    })) ?? item;

  await store.addEvent({
    mailboxId: mailbox.id,
    domainId: mailbox.domainId,
    leadId: item.leadId,
    itemId: item.id,
    kind: "sent",
    detail: { step: item.step, country: item.countryCode, basis: item.countryRule, identity: item.identityFingerprint },
  });

  const state = sequence ?? blankState(item.leadId, item.companyId, item.countryCode);
  await store.upsertSequence(
    advance({ state: { ...state, step: item.step - 1 }, country, spacing: spacingFor(country), sentAt: now }),
  );

  // Best effort: the lead timeline should say a message went out, but a
  // timeline write failing must not make us believe the send failed.
  try {
    await log({
      leadId: item.leadId,
      companyId: item.companyId,
      actor: `outreach:${mailbox.address}`,
      type: "sent",
      summary: `${item.subject} (step ${item.step})`,
      data: {
        itemId: item.id,
        step: item.step,
        mailbox: mailbox.address,
        country: item.countryCode,
        basis: item.countryRule,
        identity: item.identityFingerprint,
        provider: receipt.provider,
        providerMessageId: receipt.providerMessageId,
      },
    });
  } catch {
    // Deliberately swallowed. See above.
  }

  return { ok: true, item: sent, providerMessageId: receipt.providerMessageId };
}

async function refuse(
  store: SendingStore,
  item: SendItem,
  reason: string,
  retryable: boolean,
): Promise<DispatchOutcome> {
  const updated = await store.updateItem(item.id, { status: "blocked", blockedReason: reason.slice(0, 500) });
  return { ok: false, item: updated ?? item, reason, retryable };
}

export interface RunResult {
  attempted: number;
  sent: number;
  blocked: number;
  failed: number;
  inert: string | null;
  outcomes: DispatchOutcome[];
}

/**
 * Everything whose minute has come.
 *
 * The one place an adapter is resolved. With no credentials it returns
 * immediately with `inert` set to the reason, having sent nothing and having
 * touched no item — which is the behaviour the whole engine promises when
 * nothing is configured.
 */
export async function dispatchDue(deps: DispatchDeps & { limit?: number }): Promise<RunResult> {
  const store = deps.store ?? sendingStore();
  const env = deps.env ?? process.env;
  const now = deps.now ?? new Date();
  const result: RunResult = { attempted: 0, sent: 0, blocked: 0, failed: 0, inert: null, outcomes: [] };

  const [domains, mailboxes] = await Promise.all([store.listDomains(), store.listMailboxes()]);
  const adapters = new Map<number, SendAdapter>();
  const refusals: string[] = [];
  for (const domain of domains.filter((d) => d.purpose === "cold" && d.status !== "paused" && d.status !== "retired")) {
    const resolution = resolveAdapter({ domain: domain.domain, provider: domain.provider, env });
    if (resolution.ok) adapters.set(domain.id, resolution.adapter);
    else refusals.push(`${domain.domain}: ${resolution.reason}`);
  }
  if (adapters.size === 0) {
    result.inert =
      refusals.length > 0
        ? refusals.join(" ")
        : "no cold sending domain is configured, so the engine is inert";
    return result;
  }

  const due = await store.dueItems(now.toISOString(), deps.limit ?? 50);
  for (const item of due) {
    const mailbox = mailboxes.find((m) => m.id === item.mailboxId);
    if (!mailbox) {
      result.blocked++;
      result.outcomes.push(await refuse(store, item, "the mailbox this was planned for no longer exists", false));
      continue;
    }
    const adapter = adapters.get(mailbox.domainId);
    if (!adapter) {
      result.blocked++;
      result.outcomes.push(await refuse(store, item, "no credentials for this mailbox's domain", false));
      continue;
    }
    result.attempted++;
    const outcome = await dispatch(item, mailbox, adapter, { ...deps, store, now });
    result.outcomes.push(outcome);
    if (outcome.ok) result.sent++;
    else if (outcome.item.status === "failed") result.failed++;
    else result.blocked++;
  }
  return result;
}

/**
 * A bounce or a complaint from the provider.
 *
 * A hard bounce suppresses the address; a complaint suppresses the whole
 * company, permanently, because somebody at that business pressed "this is
 * spam" and that is an answer for the business.
 */
export async function recordDeliveryEvent(input: {
  itemId: number;
  kind: "bounce" | "complaint" | "delivered";
  detail?: Record<string, unknown>;
  store?: SendingStore;
}): Promise<void> {
  const store = input.store ?? sendingStore();
  const items = await store.listItems({ limit: 1000 });
  const item = items.find((i) => i.id === input.itemId);
  if (!item) return;
  const mailboxes = await store.listMailboxes();
  const mailbox = mailboxes.find((m) => m.id === item.mailboxId);

  await store.addEvent({
    mailboxId: mailbox?.id ?? null,
    domainId: mailbox?.domainId ?? null,
    leadId: item.leadId,
    itemId: item.id,
    kind: input.kind,
    detail: input.detail ?? {},
  });

  if (input.kind === "delivered") return;

  const sequence = (await store.getSequence(item.leadId)) ?? blankState(item.leadId, item.companyId, item.countryCode);
  await store.upsertSequence({
    ...sequence,
    status: "stopped",
    stopReason: input.kind === "bounce" ? "bounced" : "complaint",
    stoppedAt: new Date().toISOString(),
    nextDueAt: null,
  });

  await store.suppress({
    matchType: "email",
    value: item.toAddress,
    reason: input.kind === "bounce" ? "bounce" : "complaint",
    source: "outreach-engine",
  });
  if (input.kind === "complaint" && item.companyId) {
    // Company-wide and permanent. See unsubscribe.ts for why an individual's
    // "stop" is read as the business's.
    await store.suppress({
      matchType: "company_id",
      value: String(item.companyId),
      reason: "complaint",
      source: "outreach-engine",
    });
  }
}

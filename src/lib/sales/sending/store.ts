/**
 * Where the engine's records live.
 *
 * The same two-implementation shape as `video-demo/store.ts`: Postgres when
 * `DATABASE_URL` is set, an in-memory store otherwise. That is not a testing
 * convenience bolted on — the staff console is expected to run without a sales
 * database, and an engine that throws in that state would take the whole
 * console down with it.
 *
 * Everything returned is a plain object with ISO date strings. Nothing here
 * decides anything; the deciding is in `schedule.ts`, `compliance.ts` and
 * `sequence.ts`, which take these records as arguments so they can be tested
 * without a database at all.
 */

import { isConfigured, query, tx } from "../db/client";
import { flag } from "../../flags";
import {
  isSuppressed,
  suppress as suppressInDb,
  type SuppressInput,
  type SuppressionCheck,
} from "../compliance/suppression";
import type { CountryOverride } from "./countries";

export type { SuppressInput, SuppressionCheck };

export type DomainStatus = "warming" | "active" | "paused" | "retired";
export type MailboxStatus = "warming" | "active" | "paused";

export interface SendingDomain {
  id: number;
  domain: string;
  provider: string;
  purpose: "cold" | "transactional";
  status: DomainStatus;
  pausedReason?: string | null;
  pausedAt?: string | null;
  dailyCap: number;
  dns: { spf?: boolean; dkim?: boolean; dmarc?: boolean; mx?: boolean; verifiedAt?: string };
  notes?: string | null;
  createdAt: string;
}

export interface SendingMailbox {
  id: number;
  domainId: number;
  address: string;
  displayName: string;
  replyTo?: string | null;
  dailyCap: number;
  warmupStartedOn?: string | null;
  status: MailboxStatus;
  pausedReason?: string | null;
  pausedAt?: string | null;
  createdAt: string;
}

export type BatchStatus = "draft" | "approved" | "cancelled";

export interface SendBatch {
  id: number;
  status: BatchStatus;
  createdBy: string;
  createdAt: string;
  approvedBy?: string | null;
  approvedAt?: string | null;
  cancelledBy?: string | null;
  cancelledAt?: string | null;
  planned: BatchPlan;
  notes?: string | null;
}

export interface BatchPlan {
  leads: number;
  /** Video-demo minutes this batch will consume if every recipient watches once. */
  demoMinutes: number;
  /** What those minutes cost us, in fils. The console never shows dollars. */
  demoCostFils: number;
  perMailbox: { mailbox: string; count: number; firstAt?: string; lastAt?: string }[];
  perCountry: { code: string; label: string; count: number; rule: string }[];
  blocked: { company: string; reason: string }[];
}

export type ItemStatus =
  | "planned"
  | "queued"
  | "sending"
  | "sent"
  | "failed"
  | "cancelled"
  | "blocked";

export interface SendItem {
  id: number;
  batchId: number | null;
  leadId: number;
  companyId: number | null;
  messageId: number | null;
  videoDemoId: string | null;
  step: number;
  mailboxId: number | null;
  toAddress: string;
  subject: string;
  body: string;
  language: string;
  scheduledFor: string | null;
  status: ItemStatus;
  countryCode: string | null;
  countryRule: string | null;
  identityFingerprint: string | null;
  identitySnapshot: Record<string, string> | null;
  unsubscribeToken: string | null;
  /**
   * The `Message-ID` header this message went out with, minus the angle
   * brackets. It is how a reply finds its way back: the recipient's client
   * quotes it in `In-Reply-To`, and that is the only identifier in the whole
   * exchange that both sides agree on.
   */
  rfcMessageId: string | null;
  /** The plus-address suffix on the Reply-To, for when threading headers are lost. */
  replyToken: string | null;
  provider: string | null;
  providerMsgId: string | null;
  blockedReason: string | null;
  error: string | null;
  sentAt: string | null;
  createdAt: string;
}

export type SequenceStatus = "active" | "stopped" | "completed";
export type StopReason =
  | "replied"
  | "demo_clicked"
  | "unsubscribed"
  | "bounced"
  | "complaint"
  | "suppressed"
  | "cap"
  | "staff";

export interface SequenceState {
  leadId: number;
  companyId: number | null;
  step: number;
  status: SequenceStatus;
  stopReason: StopReason | null;
  stoppedAt: string | null;
  nextDueAt: string | null;
  lastSentAt: string | null;
  countryCode: string | null;
  /**
   * Standing still, not stopped.
   *
   * An out-of-office means the person is not there, not that they answered.
   * Stopping on one is how a lead disappears for good because somebody was in
   * Greece; so the sequence keeps its status and its step and simply becomes
   * undue until this moment passes.
   */
  pausedUntil: string | null;
  pauseReason: string | null;
}

export type EventKind =
  | "sent"
  | "delivered"
  | "bounce"
  | "complaint"
  | "reply"
  | "unsubscribe"
  | "demo_view"
  | "failed";

export interface SendEvent {
  id: number;
  mailboxId: number | null;
  domainId: number | null;
  leadId: number | null;
  itemId: number | null;
  kind: EventKind;
  detail: Record<string, unknown>;
  at: string;
}

/** What an inbound message turned out to be. */
export type InboundKind = "reply" | "auto_reply" | "bounce" | "complaint" | "unknown";

/** How we worked out which send it answers. In descending order of certainty. */
export type MatchedBy = "thread" | "plus_address" | "address" | "none";

/**
 * How sure we are that somebody asked to be left alone.
 *
 * Three values rather than two because the middle one is the whole point: a
 * phrase that probably means "stop" is neither something to act on silently
 * nor something to ignore. It goes to a person.
 */
export type OptOutConfidence = "none" | "likely" | "certain";

export interface InboundReply {
  id: number;
  leadId: number | null;
  itemId: number | null;
  mailboxId: number | null;
  fromAddress: string;
  toAddress: string | null;
  subject: string | null;
  body: string;
  kind: InboundKind;
  isOptOut: boolean;
  optOutConfidence: OptOutConfidence;
  needsReview: boolean;
  matchedBy: MatchedBy;
  provider: string | null;
  providerMessageId: string | null;
  rfcMessageId: string | null;
  inReplyTo: string | null;
  /** Set when this message paused a sequence, so the screen can say until when. */
  pausedUntil: string | null;
  receivedAt: string;
  handledAt: string | null;
  handledBy: string | null;
}

/** Everything `addReply` may be given; the rest is filled in with defaults. */
export type NewInboundReply = Omit<
  InboundReply,
  | "id"
  | "receivedAt"
  | "handledAt"
  | "handledBy"
  | "toAddress"
  | "kind"
  | "optOutConfidence"
  | "needsReview"
  | "matchedBy"
  | "provider"
  | "providerMessageId"
  | "rfcMessageId"
  | "inReplyTo"
  | "pausedUntil"
> &
  Partial<
    Pick<
      InboundReply,
      | "receivedAt"
      | "toAddress"
      | "kind"
      | "optOutConfidence"
      | "needsReview"
      | "matchedBy"
      | "provider"
      | "providerMessageId"
      | "rfcMessageId"
      | "inReplyTo"
      | "pausedUntil"
    >
  >;

export interface SendingStore {
  readonly kind: "postgres" | "memory";

  listDomains(): Promise<SendingDomain[]>;
  addDomain(input: Omit<SendingDomain, "id" | "createdAt">): Promise<SendingDomain>;
  updateDomain(id: number, patch: Partial<SendingDomain>): Promise<SendingDomain | null>;

  listMailboxes(): Promise<SendingMailbox[]>;
  addMailbox(input: Omit<SendingMailbox, "id" | "createdAt">): Promise<SendingMailbox>;
  updateMailbox(id: number, patch: Partial<SendingMailbox>): Promise<SendingMailbox | null>;

  createBatch(input: { createdBy: string; planned: BatchPlan; notes?: string | null }): Promise<SendBatch>;
  getBatch(id: number): Promise<SendBatch | null>;
  listBatches(limit?: number): Promise<SendBatch[]>;
  approveBatch(id: number, approvedBy: string): Promise<SendBatch | null>;
  cancelBatch(id: number, cancelledBy: string): Promise<SendBatch | null>;

  addItems(items: Omit<SendItem, "id" | "createdAt">[]): Promise<SendItem[]>;
  listItems(filter?: { batchId?: number; leadId?: number; status?: ItemStatus[]; step?: number; limit?: number }): Promise<SendItem[]>;
  getItem(id: number): Promise<SendItem | null>;
  /**
   * The send a `Message-ID` belongs to.
   *
   * Given the bare id, without angle brackets. Inbound mail asks this of every
   * `In-Reply-To` and every entry in `References`, so it is a keyed lookup
   * rather than a scan of the items table.
   */
  itemByMessageId(rfcMessageId: string): Promise<SendItem | null>;
  /** The send a plus-address suffix belongs to, when threading headers are gone. */
  itemByReplyToken(token: string): Promise<SendItem | null>;
  updateItem(id: number, patch: Partial<SendItem>): Promise<SendItem | null>;
  /** Items whose scheduled minute has arrived. */
  dueItems(nowIso: string, limit: number): Promise<SendItem[]>;
  /** Sends already made today, per mailbox id. */
  sentToday(dayStartIso: string): Promise<Record<number, number>>;

  getSequence(leadId: number): Promise<SequenceState | null>;
  listSequences(filter?: { status?: SequenceStatus; step?: number; limit?: number }): Promise<SequenceState[]>;
  upsertSequence(state: SequenceState): Promise<SequenceState>;

  addEvent(event: Omit<SendEvent, "id" | "at"> & { at?: string }): Promise<SendEvent>;
  listEvents(filter?: { since?: string; mailboxId?: number; domainId?: number; limit?: number }): Promise<SendEvent[]>;

  addReply(reply: NewInboundReply): Promise<InboundReply>;
  listReplies(filter?: {
    handled?: boolean;
    leadId?: number;
    kind?: InboundKind[];
    needsReview?: boolean;
    limit?: number;
  }): Promise<InboundReply[]>;
  markReplyHandled(id: number, by: string): Promise<InboundReply | null>;
  /**
   * Has this provider message already been taken in?
   *
   * The idempotency question, asked before anything is written. A webhook that
   * is redelivered — and SNS promises redelivery — must not produce a second
   * row, a second stop, or a second line on the lead's timeline.
   */
  findInbound(provider: string, providerMessageId: string): Promise<InboundReply | null>;
  /** Record a staff decision on a message the classifier was unsure about. */
  resolveReview(id: number, patch: { isOptOut: boolean; needsReview: false; handledBy: string }): Promise<InboundReply | null>;

  listCountryOverrides(): Promise<CountryOverride[]>;
  setCountryOverride(override: CountryOverride): Promise<void>;

  /**
   * The suppression list, through the store rather than directly.
   *
   * `compliance/suppression.ts` talks to Postgres, and the console is expected
   * to run without it. Routing these two calls through the store is what lets
   * the whole engine — including the gate that must never be skipped — work
   * and be tested with no database at all.
   */
  suppressed(check: SuppressionCheck): Promise<string | null>;
  suppress(input: SuppressInput): Promise<void>;
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

interface MemoryTables {
  domains: SendingDomain[];
  mailboxes: SendingMailbox[];
  batches: SendBatch[];
  items: SendItem[];
  sequences: Map<number, SequenceState>;
  events: SendEvent[];
  replies: InboundReply[];
  overrides: Map<string, CountryOverride>;
  /** `${matchType}:${lowercased value}` → reason. Never removed, as in Postgres. */
  suppressions: Map<string, string>;
  seq: number;
}

/**
 * Pinned on the global, like the Postgres pool in `db/client.ts` and for the
 * same reason: Next bundles route handlers and server components separately
 * and re-evaluates modules on edit, so a module-level object is not one object
 * — it is one per bundle. Without this, a domain added through the API is
 * invisible to the page that lists domains, and the no-database mode looks
 * broken in exactly the way that would send somebody hunting for a bug in the
 * engine.
 */
const globalRef = globalThis as unknown as { __bellineSendingMemory?: MemoryTables };
const memory: MemoryTables = (globalRef.__bellineSendingMemory ??= blankTables());

function blankTables(): MemoryTables {
  return {
    domains: [],
    mailboxes: [],
    batches: [],
    items: [],
    sequences: new Map(),
    events: [],
    replies: [],
    overrides: new Map(),
    suppressions: new Map(),
    seq: 1,
  };
}

/** For checks and for a local run: start from nothing. */
export function resetMemoryStore(): void {
  Object.assign(memory, blankTables());
}

function nextId(): number {
  return memory.seq++;
}

function nowIso(): string {
  return new Date().toISOString();
}

function memoryStore(): SendingStore {
  return {
    kind: "memory",

    async listDomains() {
      return memory.domains.map((d) => ({ ...d }));
    },
    async addDomain(input) {
      const row: SendingDomain = { ...input, id: nextId(), createdAt: nowIso() };
      memory.domains.push(row);
      return { ...row };
    },
    async updateDomain(id, patch) {
      const row = memory.domains.find((d) => d.id === id);
      if (!row) return null;
      Object.assign(row, patch);
      return { ...row };
    },

    async listMailboxes() {
      return memory.mailboxes.map((m) => ({ ...m }));
    },
    async addMailbox(input) {
      const row: SendingMailbox = { ...input, id: nextId(), createdAt: nowIso() };
      memory.mailboxes.push(row);
      return { ...row };
    },
    async updateMailbox(id, patch) {
      const row = memory.mailboxes.find((m) => m.id === id);
      if (!row) return null;
      Object.assign(row, patch);
      return { ...row };
    },

    async createBatch(input) {
      const row: SendBatch = {
        id: nextId(),
        status: "draft",
        createdBy: input.createdBy,
        createdAt: nowIso(),
        planned: input.planned,
        notes: input.notes ?? null,
      };
      memory.batches.push(row);
      return { ...row };
    },
    async getBatch(id) {
      const row = memory.batches.find((b) => b.id === id);
      return row ? { ...row } : null;
    },
    async listBatches(limit = 50) {
      return memory.batches.slice(-limit).reverse().map((b) => ({ ...b }));
    },
    async approveBatch(id, approvedBy) {
      const row = memory.batches.find((b) => b.id === id);
      if (!row || row.status !== "draft") return null;
      row.status = "approved";
      row.approvedBy = approvedBy;
      row.approvedAt = nowIso();
      return { ...row };
    },
    async cancelBatch(id, cancelledBy) {
      const row = memory.batches.find((b) => b.id === id);
      if (!row || row.status === "cancelled") return null;
      row.status = "cancelled";
      row.cancelledBy = cancelledBy;
      row.cancelledAt = nowIso();
      for (const item of memory.items) {
        if (item.batchId === id && (item.status === "planned" || item.status === "queued")) {
          item.status = "cancelled";
        }
      }
      return { ...row };
    },

    async addItems(items) {
      const out: SendItem[] = [];
      for (const input of items) {
        // Mirrors send_item_step_uq: one live send per lead per step, ever.
        const clash = memory.items.find(
          (i) => i.leadId === input.leadId && i.step === input.step && i.status !== "cancelled",
        );
        if (clash) continue;
        const row: SendItem = { ...input, id: nextId(), createdAt: nowIso() };
        memory.items.push(row);
        out.push({ ...row });
      }
      return out;
    },
    async listItems(filter = {}) {
      let rows = memory.items;
      if (filter.batchId !== undefined) rows = rows.filter((i) => i.batchId === filter.batchId);
      if (filter.leadId !== undefined) rows = rows.filter((i) => i.leadId === filter.leadId);
      if (filter.step !== undefined) rows = rows.filter((i) => i.step === filter.step);
      if (filter.status) rows = rows.filter((i) => filter.status!.includes(i.status));
      return rows.slice(0, filter.limit ?? 500).map((i) => ({ ...i }));
    },
    async getItem(id) {
      const row = memory.items.find((i) => i.id === id);
      return row ? { ...row } : null;
    },
    async itemByMessageId(rfcMessageId) {
      const row = memory.items.find((i) => i.rfcMessageId === rfcMessageId);
      return row ? { ...row } : null;
    },
    async itemByReplyToken(token) {
      const row = memory.items.find((i) => i.replyToken === token);
      return row ? { ...row } : null;
    },
    async updateItem(id, patch) {
      const row = memory.items.find((i) => i.id === id);
      if (!row) return null;
      Object.assign(row, patch);
      return { ...row };
    },
    async dueItems(at, limit) {
      return memory.items
        .filter((i) => (i.status === "planned" || i.status === "queued") && i.scheduledFor !== null && i.scheduledFor <= at)
        .sort((a, b) => (a.scheduledFor! < b.scheduledFor! ? -1 : 1))
        .slice(0, limit)
        .map((i) => ({ ...i }));
    },
    async sentToday(dayStart) {
      const out: Record<number, number> = {};
      for (const item of memory.items) {
        if (item.status !== "sent" || !item.sentAt || item.sentAt < dayStart) continue;
        if (item.mailboxId === null) continue;
        out[item.mailboxId] = (out[item.mailboxId] ?? 0) + 1;
      }
      return out;
    },

    async getSequence(leadId) {
      const row = memory.sequences.get(leadId);
      return row ? { ...row } : null;
    },
    async listSequences(filter = {}) {
      let rows = [...memory.sequences.values()];
      if (filter.status) rows = rows.filter((s) => s.status === filter.status);
      if (filter.step !== undefined) rows = rows.filter((s) => s.step === filter.step);
      return rows.slice(0, filter.limit ?? 500).map((s) => ({ ...s }));
    },
    async upsertSequence(state) {
      memory.sequences.set(state.leadId, { ...state });
      return { ...state };
    },

    async addEvent(event) {
      const row: SendEvent = { ...event, id: nextId(), at: event.at ?? nowIso() };
      memory.events.push(row);
      return { ...row };
    },
    async listEvents(filter = {}) {
      let rows = memory.events;
      if (filter.since) rows = rows.filter((e) => e.at >= filter.since!);
      if (filter.mailboxId !== undefined) rows = rows.filter((e) => e.mailboxId === filter.mailboxId);
      if (filter.domainId !== undefined) rows = rows.filter((e) => e.domainId === filter.domainId);
      return rows.slice(-(filter.limit ?? 1000)).map((e) => ({ ...e }));
    },

    async addReply(reply) {
      // Mirrors inbound_reply_provider_msg_uq: a redelivered webhook is one row.
      if (reply.provider && reply.providerMessageId) {
        const seen = memory.replies.find(
          (r) => r.provider === reply.provider && r.providerMessageId === reply.providerMessageId,
        );
        if (seen) return { ...seen };
      }
      const row: InboundReply = {
        leadId: reply.leadId,
        itemId: reply.itemId,
        mailboxId: reply.mailboxId,
        fromAddress: reply.fromAddress,
        toAddress: reply.toAddress ?? null,
        subject: reply.subject,
        body: reply.body,
        kind: reply.kind ?? "reply",
        isOptOut: reply.isOptOut,
        optOutConfidence: reply.optOutConfidence ?? (reply.isOptOut ? "certain" : "none"),
        needsReview: reply.needsReview ?? false,
        matchedBy: reply.matchedBy ?? "none",
        provider: reply.provider ?? null,
        providerMessageId: reply.providerMessageId ?? null,
        rfcMessageId: reply.rfcMessageId ?? null,
        inReplyTo: reply.inReplyTo ?? null,
        pausedUntil: reply.pausedUntil ?? null,
        id: nextId(),
        receivedAt: reply.receivedAt ?? nowIso(),
        handledAt: null,
        handledBy: null,
      };
      memory.replies.push(row);
      return { ...row };
    },
    async listReplies(filter = {}) {
      let rows = memory.replies;
      if (filter.handled === true) rows = rows.filter((r) => r.handledAt !== null);
      if (filter.handled === false) rows = rows.filter((r) => r.handledAt === null);
      if (filter.leadId !== undefined) rows = rows.filter((r) => r.leadId === filter.leadId);
      if (filter.kind) rows = rows.filter((r) => filter.kind!.includes(r.kind));
      if (filter.needsReview !== undefined) rows = rows.filter((r) => r.needsReview === filter.needsReview);
      return rows.slice(-(filter.limit ?? 200)).reverse().map((r) => ({ ...r }));
    },
    async markReplyHandled(id, by) {
      const row = memory.replies.find((r) => r.id === id);
      if (!row) return null;
      row.handledAt = nowIso();
      row.handledBy = by;
      return { ...row };
    },
    async findInbound(provider, providerMessageId) {
      const row = memory.replies.find(
        (r) => r.provider === provider && r.providerMessageId === providerMessageId,
      );
      return row ? { ...row } : null;
    },
    async resolveReview(id, patch) {
      const row = memory.replies.find((r) => r.id === id);
      if (!row) return null;
      row.isOptOut = patch.isOptOut;
      row.optOutConfidence = patch.isOptOut ? "certain" : "none";
      row.needsReview = false;
      row.handledAt = nowIso();
      row.handledBy = patch.handledBy;
      return { ...row };
    },

    async listCountryOverrides() {
      return [...memory.overrides.values()].map((o) => ({ ...o }));
    },
    async setCountryOverride(override) {
      memory.overrides.set(override.code.toUpperCase(), { ...override, code: override.code.toUpperCase() });
    },

    async suppressed(check) {
      const keys: string[] = [];
      if (check.email) {
        keys.push(`email:${check.email.trim().toLowerCase()}`);
        const at = check.email.indexOf("@");
        if (at > -1) keys.push(`domain:${check.email.slice(at + 1).trim().toLowerCase()}`);
      }
      if (check.domain) keys.push(`domain:${check.domain.replace(/^www\./i, "").trim().toLowerCase()}`);
      if (check.phone) keys.push(`phone:${check.phone.trim().toLowerCase()}`);
      if (check.companyId) keys.push(`company_id:${check.companyId}`);
      for (const key of keys) {
        const reason = memory.suppressions.get(key);
        if (reason) return `${reason} (${key.replace(":", " ")})`;
      }
      return null;
    },
    async suppress(input) {
      const key = `${input.matchType}:${input.value.trim().toLowerCase()}`;
      // Never overwritten: the first reason recorded is the one that stands,
      // mirroring `on conflict do nothing` in Postgres.
      if (!memory.suppressions.has(key)) memory.suppressions.set(key, input.reason);
    },
  };
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */

const iso = (v: Date | string | null | undefined): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : String(v);

function toDomain(r: any): SendingDomain {
  return {
    id: Number(r.id),
    domain: r.domain,
    provider: r.provider,
    purpose: r.purpose,
    status: r.status,
    pausedReason: r.paused_reason,
    pausedAt: iso(r.paused_at),
    dailyCap: Number(r.daily_cap),
    dns: r.dns ?? {},
    notes: r.notes,
    createdAt: iso(r.created_at)!,
  };
}

function toMailbox(r: any): SendingMailbox {
  return {
    id: Number(r.id),
    domainId: Number(r.domain_id),
    address: r.address,
    displayName: r.display_name,
    replyTo: r.reply_to,
    dailyCap: Number(r.daily_cap),
    warmupStartedOn: r.warmup_started_on ? String(iso(r.warmup_started_on)).slice(0, 10) : null,
    status: r.status,
    pausedReason: r.paused_reason,
    pausedAt: iso(r.paused_at),
    createdAt: iso(r.created_at)!,
  };
}

function toBatch(r: any): SendBatch {
  return {
    id: Number(r.id),
    status: r.status,
    createdBy: r.created_by,
    createdAt: iso(r.created_at)!,
    approvedBy: r.approved_by,
    approvedAt: iso(r.approved_at),
    cancelledBy: r.cancelled_by,
    cancelledAt: iso(r.cancelled_at),
    planned: r.planned ?? {},
    notes: r.notes,
  };
}

function toItem(r: any): SendItem {
  return {
    id: Number(r.id),
    batchId: r.batch_id === null ? null : Number(r.batch_id),
    leadId: Number(r.lead_id),
    companyId: r.company_id === null ? null : Number(r.company_id),
    messageId: r.message_id === null ? null : Number(r.message_id),
    videoDemoId: r.video_demo_id,
    step: Number(r.step),
    mailboxId: r.mailbox_id === null ? null : Number(r.mailbox_id),
    toAddress: r.to_address,
    subject: r.subject,
    body: r.body,
    language: r.language,
    scheduledFor: iso(r.scheduled_for),
    status: r.status,
    countryCode: r.country_code,
    countryRule: r.country_rule,
    identityFingerprint: r.identity_fingerprint,
    identitySnapshot: r.identity_snapshot,
    unsubscribeToken: r.unsubscribe_token,
    rfcMessageId: r.rfc_message_id ?? null,
    replyToken: r.reply_token ?? null,
    provider: r.provider,
    providerMsgId: r.provider_msg_id,
    blockedReason: r.blocked_reason,
    error: r.error,
    sentAt: iso(r.sent_at),
    createdAt: iso(r.created_at)!,
  };
}

function toSequence(r: any): SequenceState {
  return {
    leadId: Number(r.lead_id),
    companyId: r.company_id === null ? null : Number(r.company_id),
    step: Number(r.step),
    status: r.status,
    stopReason: r.stop_reason,
    stoppedAt: iso(r.stopped_at),
    nextDueAt: iso(r.next_due_at),
    lastSentAt: iso(r.last_sent_at),
    countryCode: r.country_code,
    pausedUntil: iso(r.paused_until),
    pauseReason: r.pause_reason ?? null,
  };
}

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
function toReply(r: any): InboundReply {
  return {
    id: Number(r.id),
    leadId: r.lead_id === null ? null : Number(r.lead_id),
    itemId: r.item_id === null ? null : Number(r.item_id),
    mailboxId: r.mailbox_id === null ? null : Number(r.mailbox_id),
    fromAddress: r.from_address,
    toAddress: r.to_address ?? null,
    subject: r.subject,
    body: r.body,
    kind: (r.kind ?? "reply") as InboundKind,
    isOptOut: r.is_opt_out,
    optOutConfidence: (r.opt_out_confidence ?? "none") as OptOutConfidence,
    needsReview: r.needs_review === true,
    matchedBy: (r.matched_by ?? "none") as MatchedBy,
    provider: r.provider ?? null,
    providerMessageId: r.provider_message_id ?? null,
    rfcMessageId: r.rfc_message_id ?? null,
    inReplyTo: r.in_reply_to ?? null,
    pausedUntil: iso(r.paused_until),
    receivedAt: iso(r.received_at)!,
    handledAt: iso(r.handled_at),
    handledBy: r.handled_by,
  };
}

/** Column names a patch may set, to keep the update builders honest. */
const ITEM_COLUMNS: Record<keyof SendItem, string> = {
  id: "id",
  batchId: "batch_id",
  leadId: "lead_id",
  companyId: "company_id",
  messageId: "message_id",
  videoDemoId: "video_demo_id",
  step: "step",
  mailboxId: "mailbox_id",
  toAddress: "to_address",
  subject: "subject",
  body: "body",
  language: "language",
  scheduledFor: "scheduled_for",
  status: "status",
  countryCode: "country_code",
  countryRule: "country_rule",
  identityFingerprint: "identity_fingerprint",
  identitySnapshot: "identity_snapshot",
  unsubscribeToken: "unsubscribe_token",
  rfcMessageId: "rfc_message_id",
  replyToken: "reply_token",
  provider: "provider",
  providerMsgId: "provider_msg_id",
  blockedReason: "blocked_reason",
  error: "error",
  sentAt: "sent_at",
  createdAt: "created_at",
};

function postgresStore(): SendingStore {
  return {
    kind: "postgres",

    async listDomains() {
      return (await query(`select * from sales.sending_domain order by domain`)).map(toDomain);
    },
    async addDomain(input) {
      const rows = await query(
        `insert into sales.sending_domain (domain, provider, purpose, status, daily_cap, dns, notes)
         values ($1,$2,$3,$4,$5,$6,$7) returning *`,
        [input.domain, input.provider, input.purpose, input.status, input.dailyCap, JSON.stringify(input.dns ?? {}), input.notes ?? null],
      );
      return toDomain(rows[0]);
    },
    async updateDomain(id, patch) {
      const map: Record<string, string> = {
        status: "status",
        pausedReason: "paused_reason",
        pausedAt: "paused_at",
        dailyCap: "daily_cap",
        dns: "dns",
        notes: "notes",
        provider: "provider",
        purpose: "purpose",
      };
      const sets: string[] = [];
      const params: unknown[] = [];
      for (const [key, column] of Object.entries(map)) {
        if (!(key in patch)) continue;
        const value = (patch as Record<string, unknown>)[key];
        params.push(key === "dns" ? JSON.stringify(value ?? {}) : value);
        sets.push(`${column} = $${params.length}`);
      }
      if (sets.length === 0) return null;
      params.push(id);
      const rows = await query(
        `update sales.sending_domain set ${sets.join(", ")}, updated_at = now() where id = $${params.length} returning *`,
        params,
      );
      return rows[0] ? toDomain(rows[0]) : null;
    },

    async listMailboxes() {
      return (await query(`select * from sales.sending_mailbox order by address`)).map(toMailbox);
    },
    async addMailbox(input) {
      const rows = await query(
        `insert into sales.sending_mailbox
           (domain_id, address, display_name, reply_to, daily_cap, warmup_started_on, status)
         values ($1,$2,$3,$4,$5,$6,$7) returning *`,
        [input.domainId, input.address, input.displayName, input.replyTo ?? null, input.dailyCap, input.warmupStartedOn ?? null, input.status],
      );
      return toMailbox(rows[0]);
    },
    async updateMailbox(id, patch) {
      const map: Record<string, string> = {
        status: "status",
        pausedReason: "paused_reason",
        pausedAt: "paused_at",
        dailyCap: "daily_cap",
        warmupStartedOn: "warmup_started_on",
        displayName: "display_name",
        replyTo: "reply_to",
      };
      const sets: string[] = [];
      const params: unknown[] = [];
      for (const [key, column] of Object.entries(map)) {
        if (!(key in patch)) continue;
        params.push((patch as Record<string, unknown>)[key]);
        sets.push(`${column} = $${params.length}`);
      }
      if (sets.length === 0) return null;
      params.push(id);
      const rows = await query(
        `update sales.sending_mailbox set ${sets.join(", ")}, updated_at = now() where id = $${params.length} returning *`,
        params,
      );
      return rows[0] ? toMailbox(rows[0]) : null;
    },

    async createBatch(input) {
      const rows = await query(
        `insert into sales.send_batch (created_by, planned, notes) values ($1,$2,$3) returning *`,
        [input.createdBy, JSON.stringify(input.planned), input.notes ?? null],
      );
      return toBatch(rows[0]);
    },
    async getBatch(id) {
      const rows = await query(`select * from sales.send_batch where id = $1`, [id]);
      return rows[0] ? toBatch(rows[0]) : null;
    },
    async listBatches(limit = 50) {
      return (await query(`select * from sales.send_batch order by created_at desc limit $1`, [limit])).map(toBatch);
    },
    async approveBatch(id, approvedBy) {
      // Conditional on the current status, so two staff pressing approve at the
      // same moment produce one approval and one "already approved", not two.
      const rows = await query(
        `update sales.send_batch set status = 'approved', approved_by = $2, approved_at = now()
          where id = $1 and status = 'draft' returning *`,
        [id, approvedBy],
      );
      return rows[0] ? toBatch(rows[0]) : null;
    },
    async cancelBatch(id, cancelledBy) {
      return tx(async (c) => {
        const rows = await c.query(
          `update sales.send_batch set status = 'cancelled', cancelled_by = $2, cancelled_at = now()
            where id = $1 and status <> 'cancelled' returning *`,
          [id, cancelledBy],
        );
        if (!rows.rows[0]) return null;
        await c.query(
          `update sales.send_item set status = 'cancelled', updated_at = now()
            where batch_id = $1 and status in ('planned','queued')`,
          [id],
        );
        return toBatch(rows.rows[0]);
      });
    },

    async addItems(items) {
      const out: SendItem[] = [];
      for (const i of items) {
        const rows = await query(
          `insert into sales.send_item
             (batch_id, lead_id, company_id, message_id, video_demo_id, step, mailbox_id,
              to_address, subject, body, language, scheduled_for, status, country_code,
              country_rule, identity_fingerprint, identity_snapshot, unsubscribe_token, blocked_reason,
              rfc_message_id, reply_token)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
           on conflict do nothing
           returning *`,
          [
            i.batchId, i.leadId, i.companyId, i.messageId, i.videoDemoId, i.step, i.mailboxId,
            i.toAddress, i.subject, i.body, i.language, i.scheduledFor, i.status, i.countryCode,
            i.countryRule, i.identityFingerprint, i.identitySnapshot ? JSON.stringify(i.identitySnapshot) : null,
            i.unsubscribeToken, i.blockedReason, i.rfcMessageId ?? null, i.replyToken ?? null,
          ],
        );
        if (rows[0]) out.push(toItem(rows[0]));
      }
      return out;
    },
    async listItems(filter = {}) {
      const clauses: string[] = ["true"];
      const params: unknown[] = [];
      if (filter.batchId !== undefined) { params.push(filter.batchId); clauses.push(`batch_id = $${params.length}`); }
      if (filter.leadId !== undefined) { params.push(filter.leadId); clauses.push(`lead_id = $${params.length}`); }
      if (filter.step !== undefined) { params.push(filter.step); clauses.push(`step = $${params.length}`); }
      if (filter.status) { params.push(filter.status); clauses.push(`status = any($${params.length})`); }
      params.push(filter.limit ?? 500);
      return (
        await query(
          `select * from sales.send_item where ${clauses.join(" and ")} order by id desc limit $${params.length}`,
          params,
        )
      ).map(toItem);
    },
    async getItem(id) {
      const rows = await query(`select * from sales.send_item where id = $1`, [id]);
      return rows[0] ? toItem(rows[0]) : null;
    },
    async itemByMessageId(rfcMessageId) {
      const rows = await query(`select * from sales.send_item where rfc_message_id = $1`, [rfcMessageId]);
      return rows[0] ? toItem(rows[0]) : null;
    },
    async itemByReplyToken(token) {
      const rows = await query(`select * from sales.send_item where reply_token = $1`, [token]);
      return rows[0] ? toItem(rows[0]) : null;
    },
    async updateItem(id, patch) {
      const sets: string[] = [];
      const params: unknown[] = [];
      for (const key of Object.keys(patch) as (keyof SendItem)[]) {
        if (key === "id" || key === "createdAt") continue;
        const column = ITEM_COLUMNS[key];
        if (!column) continue;
        const value = patch[key];
        params.push(key === "identitySnapshot" && value ? JSON.stringify(value) : value);
        sets.push(`${column} = $${params.length}`);
      }
      if (sets.length === 0) return null;
      params.push(id);
      const rows = await query(
        `update sales.send_item set ${sets.join(", ")}, updated_at = now() where id = $${params.length} returning *`,
        params,
      );
      return rows[0] ? toItem(rows[0]) : null;
    },
    async dueItems(at, limit) {
      return (
        await query(
          `select * from sales.send_item
            where status in ('planned','queued') and scheduled_for is not null and scheduled_for <= $1
            order by scheduled_for limit $2`,
          [at, limit],
        )
      ).map(toItem);
    },
    async sentToday(dayStart) {
      const rows = await query<{ mailbox_id: string; n: string }>(
        `select mailbox_id, count(*)::text as n from sales.send_item
          where status = 'sent' and sent_at >= $1 and mailbox_id is not null
          group by mailbox_id`,
        [dayStart],
      );
      const out: Record<number, number> = {};
      for (const row of rows) out[Number(row.mailbox_id)] = Number(row.n);
      return out;
    },

    async getSequence(leadId) {
      const rows = await query(`select * from sales.sequence_state where lead_id = $1`, [leadId]);
      return rows[0] ? toSequence(rows[0]) : null;
    },
    async listSequences(filter = {}) {
      const clauses: string[] = ["true"];
      const params: unknown[] = [];
      if (filter.status) { params.push(filter.status); clauses.push(`status = $${params.length}`); }
      if (filter.step !== undefined) { params.push(filter.step); clauses.push(`step = $${params.length}`); }
      params.push(filter.limit ?? 500);
      return (
        await query(
          `select * from sales.sequence_state where ${clauses.join(" and ")} order by updated_at desc limit $${params.length}`,
          params,
        )
      ).map(toSequence);
    },
    async upsertSequence(state) {
      const rows = await query(
        `insert into sales.sequence_state
           (lead_id, company_id, step, status, stop_reason, stopped_at, next_due_at, last_sent_at, country_code,
            paused_until, pause_reason)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         on conflict (lead_id) do update set
           company_id = excluded.company_id, step = excluded.step, status = excluded.status,
           stop_reason = excluded.stop_reason, stopped_at = excluded.stopped_at,
           next_due_at = excluded.next_due_at, last_sent_at = excluded.last_sent_at,
           country_code = excluded.country_code, paused_until = excluded.paused_until,
           pause_reason = excluded.pause_reason, updated_at = now()
         returning *`,
        [state.leadId, state.companyId, state.step, state.status, state.stopReason, state.stoppedAt, state.nextDueAt, state.lastSentAt, state.countryCode, state.pausedUntil, state.pauseReason],
      );
      return toSequence(rows[0]);
    },

    async addEvent(event) {
      const rows = await query(
        `insert into sales.send_event (mailbox_id, domain_id, lead_id, item_id, kind, detail, at)
         values ($1,$2,$3,$4,$5,$6, coalesce($7::timestamptz, now())) returning *`,
        [event.mailboxId, event.domainId, event.leadId, event.itemId, event.kind, JSON.stringify(event.detail ?? {}), event.at ?? null],
      );
      const r = rows[0] as any;
      return { id: Number(r.id), mailboxId: r.mailbox_id === null ? null : Number(r.mailbox_id), domainId: r.domain_id === null ? null : Number(r.domain_id), leadId: r.lead_id === null ? null : Number(r.lead_id), itemId: r.item_id === null ? null : Number(r.item_id), kind: r.kind, detail: r.detail ?? {}, at: iso(r.at)! };
    },
    async listEvents(filter = {}) {
      const clauses: string[] = ["true"];
      const params: unknown[] = [];
      if (filter.since) { params.push(filter.since); clauses.push(`at >= $${params.length}`); }
      if (filter.mailboxId !== undefined) { params.push(filter.mailboxId); clauses.push(`mailbox_id = $${params.length}`); }
      if (filter.domainId !== undefined) { params.push(filter.domainId); clauses.push(`domain_id = $${params.length}`); }
      params.push(filter.limit ?? 1000);
      const rows = await query<any>(
        `select * from sales.send_event where ${clauses.join(" and ")} order by at desc limit $${params.length}`,
        params,
      );
      return rows.map((r) => ({ id: Number(r.id), mailboxId: r.mailbox_id === null ? null : Number(r.mailbox_id), domainId: r.domain_id === null ? null : Number(r.domain_id), leadId: r.lead_id === null ? null : Number(r.lead_id), itemId: r.item_id === null ? null : Number(r.item_id), kind: r.kind, detail: r.detail ?? {}, at: iso(r.at)! }));
    },

    async addReply(reply) {
      // `on conflict do nothing` plus a read-back, so two deliveries of one
      // provider message are one row even when they race. The unique index is
      // partial, so the conflict target has to be named with its predicate.
      const rows = await query<any>(
        `insert into sales.inbound_reply
           (lead_id, item_id, mailbox_id, from_address, to_address, subject, body, kind,
            is_opt_out, opt_out_confidence, needs_review, matched_by, provider,
            provider_message_id, rfc_message_id, in_reply_to, paused_until, received_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, coalesce($18::timestamptz, now()))
         on conflict (provider, provider_message_id) where provider_message_id is not null
           do nothing
         returning *`,
        [
          reply.leadId, reply.itemId, reply.mailboxId, reply.fromAddress, reply.toAddress ?? null,
          reply.subject, reply.body, reply.kind ?? "reply", reply.isOptOut,
          reply.optOutConfidence ?? (reply.isOptOut ? "certain" : "none"),
          reply.needsReview ?? false, reply.matchedBy ?? "none", reply.provider ?? null,
          reply.providerMessageId ?? null, reply.rfcMessageId ?? null, reply.inReplyTo ?? null,
          reply.pausedUntil ?? null, reply.receivedAt ?? null,
        ],
      );
      if (rows[0]) return toReply(rows[0]);
      const existing = await query<any>(
        `select * from sales.inbound_reply where provider = $1 and provider_message_id = $2`,
        [reply.provider ?? null, reply.providerMessageId ?? null],
      );
      return toReply(existing[0]);
    },
    async listReplies(filter = {}) {
      const clauses: string[] = ["true"];
      const params: unknown[] = [];
      if (filter.handled === true) clauses.push("handled_at is not null");
      if (filter.handled === false) clauses.push("handled_at is null");
      if (filter.leadId !== undefined) { params.push(filter.leadId); clauses.push(`lead_id = $${params.length}`); }
      if (filter.kind) { params.push(filter.kind); clauses.push(`kind = any($${params.length})`); }
      if (filter.needsReview !== undefined) { params.push(filter.needsReview); clauses.push(`needs_review = $${params.length}`); }
      params.push(filter.limit ?? 200);
      const rows = await query<any>(
        `select * from sales.inbound_reply where ${clauses.join(" and ")} order by received_at desc limit $${params.length}`,
        params,
      );
      return rows.map(toReply);
    },
    async markReplyHandled(id, by) {
      const rows = await query<any>(
        `update sales.inbound_reply set handled_at = now(), handled_by = $2 where id = $1 returning *`,
        [id, by],
      );
      return rows[0] ? toReply(rows[0]) : null;
    },
    async findInbound(provider, providerMessageId) {
      const rows = await query<any>(
        `select * from sales.inbound_reply where provider = $1 and provider_message_id = $2`,
        [provider, providerMessageId],
      );
      return rows[0] ? toReply(rows[0]) : null;
    },
    async resolveReview(id, patch) {
      const rows = await query<any>(
        `update sales.inbound_reply
            set is_opt_out = $2, opt_out_confidence = $3, needs_review = false,
                handled_at = now(), handled_by = $4
          where id = $1 returning *`,
        [id, patch.isOptOut, patch.isOptOut ? "certain" : "none", patch.handledBy],
      );
      return rows[0] ? toReply(rows[0]) : null;
    },

    async listCountryOverrides() {
      const rows = await query<any>(`select * from sales.outreach_country`);
      return rows.map((r) => ({ code: r.code, enabled: r.enabled, dailyCap: r.daily_cap, updatedBy: r.updated_by, updatedAt: iso(r.updated_at) ?? undefined }));
    },
    async setCountryOverride(override) {
      await query(
        `insert into sales.outreach_country (code, enabled, daily_cap, updated_by, updated_at)
         values ($1,$2,$3,$4, now())
         on conflict (code) do update set enabled = excluded.enabled, daily_cap = excluded.daily_cap,
           updated_by = excluded.updated_by, updated_at = now()`,
        [override.code.toUpperCase(), override.enabled, override.dailyCap ?? null, override.updatedBy ?? "system"],
      );
    },

    async suppressed(check) {
      return isSuppressed(check);
    },
    async suppress(input) {
      await suppressInDb(input);
    },
  };
}

/* eslint-enable @typescript-eslint/no-explicit-any */

let cached: SendingStore | null = null;
let cachedKind: "postgres" | "memory" | null = null;

/**
 * The store for this process.
 *
 * Re-resolved when the answer would change, because the check scripts rig the
 * environment between cases and a store cached across that would be the wrong
 * one.
 */
export function sendingStore(): SendingStore {
  const wantMemory = !isConfigured() || flag("stubs");
  const kind = wantMemory ? "memory" : "postgres";
  if (!cached || cachedKind !== kind) {
    cached = wantMemory ? memoryStore() : postgresStore();
    cachedKind = kind;
  }
  return cached;
}

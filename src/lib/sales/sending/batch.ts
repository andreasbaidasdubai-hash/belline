/**
 * Batches: what staff approve, and the only thing that can become a send.
 *
 * A batch is built, screened, costed and shown. Nothing about building one
 * sends anything, and nothing sends until `approveBatch` records a named human
 * being against it. The engine has no autonomous mode and no flag that would
 * add one; `dispatch.ts` reads `approved_by` and refuses on null.
 *
 * The candidate list comes through a port rather than a query in this file, so
 * the planning and screening can be tested exactly as they will run, with no
 * database at all.
 */

import { legalIdentity, identityFingerprint, type LegalIdentity } from "../../legal/identity";
import { effectiveRule, type CountryOverride, type EffectiveCountry } from "./countries";
import { screen, isActionable, type Block } from "./compliance";
import { signUnsubscribeToken, unsubscribeUrl, footerFor, unsubscribeSecretPresent } from "./unsubscribe";
import { capacityFor, planDay, DEFAULT_WINDOW, type MailboxCapacity, type SendWindow } from "./schedule";
import { assess, countEvents } from "./health";
import { sendingStore, type BatchPlan, type SendBatch, type SendItem, type SendingStore } from "./store";
import { spacingFor, stepLabel } from "./sequence";
import { FILS_PER_USD } from "../../billing/cost";

/**
 * Minutes of avatar time one demo view costs us.
 *
 * The demo is capped at three video sessions a day per link and a session runs
 * to roughly two minutes, but for costing a batch the honest number is one
 * view per recipient — that is what we are committing to when we send.
 */
export const MINUTES_PER_DEMO_VIEW = 2;
export const USD_PER_DEMO_MINUTE = 0.244; // Tavus business rate, per billing/cost.ts

export interface Candidate {
  leadId: number;
  companyId: number | null;
  companyName: string;
  toAddress: string | null;
  countryCode: string | null;
  /** The drafted message, already personalised and guarded. */
  messageId: number | null;
  subject: string;
  /** The body with the frame applied but no footer — this module adds that. */
  body: string;
  videoDemoId: string | null;
  demoUrl: string | null;
  hasResearch: boolean;
  guardProblems: string[];
  suppressed: string | null;
  touches90d: number;
  lastTouchAt: string | null;
  sequenceStopped: string | null;
}

export interface CandidateSource {
  /** Leads with a prepared demo and no first email yet. */
  firstTouch(limit: number): Promise<Candidate[]>;
  /** Leads whose next follow-up is due. */
  dueFollowUps(limit: number, now: Date): Promise<(Candidate & { step: number })[]>;
}

export interface BuildInput {
  source: CandidateSource;
  store?: SendingStore;
  limit?: number;
  /** Follow-ups as well as first touches. */
  includeFollowUps?: boolean;
  window?: SendWindow;
  now?: Date;
  origin: string;
  env?: Record<string, string | undefined>;
  seed?: number;
}

export interface PlannedItem {
  candidate: Candidate;
  step: number;
  country: EffectiveCountry;
  blocks: Block[];
  mailboxId: number | null;
  mailboxAddress: string | null;
  scheduledFor: Date | null;
  subject: string;
  body: string;
  language: string;
  unsubscribeToken: string | null;
  identity: LegalIdentity;
}

export interface BuiltBatch {
  items: PlannedItem[];
  sendable: PlannedItem[];
  blocked: PlannedItem[];
  plan: BatchPlan;
  capacities: MailboxCapacity[];
  /** Asked for more than the day can hold. */
  unplaced: number;
  unplacedReason?: string;
}

/** Today's capacity for every mailbox, with health folded in. */
export async function capacities(store: SendingStore, now: Date): Promise<MailboxCapacity[]> {
  const [domains, mailboxes, events] = await Promise.all([
    store.listDomains(),
    store.listMailboxes(),
    store.listEvents({ since: new Date(now.getTime() - 30 * 86_400_000).toISOString(), limit: 5000 }),
  ]);
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const sent = await store.sentToday(dayStart.toISOString());
  const today = now.toISOString().slice(0, 10);

  return mailboxes.map((mailbox) => {
    const domain = domains.find((d) => d.id === mailbox.domainId);
    const health = assess(countEvents(events.filter((e) => e.mailboxId === mailbox.id)));
    return capacityFor({
      mailbox,
      health,
      sentToday: sent[mailbox.id] ?? 0,
      today,
      domainPaused:
        !domain || domain.status === "paused" || domain.status === "retired"
          ? (domain?.pausedReason ?? "domain unavailable")
          : null,
    });
  });
}

/**
 * Build a batch: screen every candidate, place the survivors on the clock.
 *
 * Returns a plan. Writes nothing. The caller shows it, and only a separate,
 * explicitly-approved call turns it into rows.
 */
export async function buildBatch(input: BuildInput): Promise<BuiltBatch> {
  const store = input.store ?? sendingStore();
  const now = input.now ?? new Date();
  const env = input.env ?? process.env;
  const identity = legalIdentity(env);
  const canSign = unsubscribeSecretPresent(env);
  const overrides = (await store.listCountryOverrides()) as CountryOverride[];
  const caps = await capacities(store, now);
  const engineReady = caps.some((c) => c.unusable === null && c.remaining > 0);

  const limit = input.limit ?? 50;
  const first = await input.source.firstTouch(limit);
  const follow = input.includeFollowUps ? await input.source.dueFollowUps(limit, now) : [];

  const raw: { candidate: Candidate; step: number }[] = [
    ...first.map((candidate) => ({ candidate, step: 1 })),
    ...follow.map((c) => ({ candidate: c, step: c.step })),
  ];

  const screened: PlannedItem[] = raw.map(({ candidate, step }) => {
    const country = effectiveRule(candidate.countryCode, overrides);
    const result = screen({
      companyName: candidate.companyName,
      toAddress: candidate.toAddress,
      countryCode: candidate.countryCode,
      country,
      identity,
      suppressed: candidate.suppressed,
      step,
      touches90d: candidate.touches90d,
      lastTouchAt: candidate.lastTouchAt,
      hasDemoLink: Boolean(candidate.demoUrl),
      hasResearch: candidate.hasResearch,
      sequenceStopped: candidate.sequenceStopped,
      guardProblems: candidate.guardProblems,
      canSignUnsubscribe: canSign,
      engineReady,
      now,
    });
    return {
      candidate,
      step,
      country,
      blocks: result.blocks,
      mailboxId: null,
      mailboxAddress: null,
      scheduledFor: null,
      subject: candidate.subject,
      body: candidate.body,
      language: result.language,
      unsubscribeToken: null,
      identity,
    };
  });

  const sendable = screened.filter((i) => i.blocks.length === 0);
  const blocked = screened
    .filter((i) => i.blocks.length > 0)
    .sort((a, b) => Number(isActionable(b.blocks[0].code)) - Number(isActionable(a.blocks[0].code)));

  // Per-country daily ceilings, applied before the mailbox allocation so a
  // country's cap cannot be exceeded by a mailbox happening to have room.
  const perCountryUsed = new Map<string, number>();
  const withinCountryCap: PlannedItem[] = [];
  for (const item of sendable) {
    const used = perCountryUsed.get(item.country.code) ?? 0;
    if (used >= item.country.effectiveDailyCap) {
      item.blocks.push({
        code: "country_off",
        reason: `${item.country.label}'s daily limit of ${item.country.effectiveDailyCap} is already allocated`,
      });
      blocked.push(item);
      continue;
    }
    perCountryUsed.set(item.country.code, used + 1);
    withinCountryCap.push(item);
  }

  const window = input.window ?? DEFAULT_WINDOW;
  const { sends, unplaced, reason } = planDay({
    capacities: caps,
    count: withinCountryCap.length,
    window,
    day: now,
    notBefore: now,
    seed: input.seed ?? 1,
  });

  const placed: PlannedItem[] = [];
  for (let i = 0; i < withinCountryCap.length; i++) {
    const item = withinCountryCap[i];
    const slot = sends[i];
    if (!slot) {
      item.blocks.push({ code: "engine_inert", reason: reason ?? "no room in today's schedule" });
      blocked.push(item);
      continue;
    }
    item.mailboxId = slot.mailboxId;
    item.mailboxAddress = slot.address;
    item.scheduledFor = slot.at;
    placed.push(item);
  }

  const plan: BatchPlan = {
    leads: placed.length,
    demoMinutes: placed.filter((i) => i.step === 1).length * MINUTES_PER_DEMO_VIEW,
    demoCostFils: Math.round(
      placed.filter((i) => i.step === 1).length * MINUTES_PER_DEMO_VIEW * USD_PER_DEMO_MINUTE * FILS_PER_USD,
    ),
    perMailbox: summariseMailboxes(placed),
    perCountry: summariseCountries(placed),
    blocked: blocked.map((i) => ({ company: i.candidate.companyName, reason: i.blocks[0]?.reason ?? "blocked" })),
  };

  return { items: screened, sendable: placed, blocked, plan, capacities: caps, unplaced, unplacedReason: reason };
}

function summariseMailboxes(items: readonly PlannedItem[]): BatchPlan["perMailbox"] {
  const by = new Map<string, { count: number; first?: Date; last?: Date }>();
  for (const item of items) {
    if (!item.mailboxAddress || !item.scheduledFor) continue;
    const entry = by.get(item.mailboxAddress) ?? { count: 0 };
    entry.count++;
    if (!entry.first || item.scheduledFor < entry.first) entry.first = item.scheduledFor;
    if (!entry.last || item.scheduledFor > entry.last) entry.last = item.scheduledFor;
    by.set(item.mailboxAddress, entry);
  }
  return [...by.entries()].map(([mailbox, entry]) => ({
    mailbox,
    count: entry.count,
    firstAt: entry.first?.toISOString(),
    lastAt: entry.last?.toISOString(),
  }));
}

function summariseCountries(items: readonly PlannedItem[]): BatchPlan["perCountry"] {
  const by = new Map<string, { label: string; rule: string; count: number }>();
  for (const item of items) {
    const entry = by.get(item.country.code) ?? { label: item.country.label, rule: item.country.basis, count: 0 };
    entry.count++;
    by.set(item.country.code, entry);
  }
  return [...by.entries()].map(([code, e]) => ({ code, label: e.label, count: e.count, rule: e.rule }));
}

/**
 * Turn a built plan into rows, in `draft` status.
 *
 * The footer and the opt-out link are attached here, at the last possible
 * moment before the text is frozen, so that no earlier step can produce a body
 * without them and no later step has to remember to add them.
 */
export async function saveBatch(input: {
  built: BuiltBatch;
  createdBy: string;
  origin: string;
  notes?: string | null;
  store?: SendingStore;
  env?: Record<string, string | undefined>;
}): Promise<{ batch: SendBatch; items: SendItem[] }> {
  const store = input.store ?? sendingStore();
  const env = input.env ?? process.env;
  const batch = await store.createBatch({
    createdBy: input.createdBy,
    planned: input.built.plan,
    notes: input.notes ?? null,
  });

  const rows: Omit<SendItem, "id" | "createdAt">[] = [];
  for (const item of input.built.sendable) {
    // The token needs the item id, which does not exist yet, so it is signed
    // against the batch and lead and rewritten with the real id after insert.
    const placeholder = signUnsubscribeToken(
      { itemId: batch.id, companyId: item.candidate.companyId, email: item.candidate.toAddress! },
      env,
    );
    rows.push({
      batchId: batch.id,
      leadId: item.candidate.leadId,
      companyId: item.candidate.companyId,
      messageId: item.candidate.messageId,
      videoDemoId: item.candidate.videoDemoId,
      step: item.step,
      mailboxId: item.mailboxId,
      toAddress: item.candidate.toAddress!,
      subject: item.subject,
      body: item.body,
      language: item.language,
      scheduledFor: item.scheduledFor?.toISOString() ?? null,
      status: "planned",
      countryCode: item.country.code,
      countryRule: item.country.basis,
      identityFingerprint: identityFingerprint(item.identity),
      identitySnapshot: {
        entity: item.identity.entity,
        address: item.identity.address,
        managingDirector: item.identity.managingDirector,
        registration: item.identity.registration,
        email: item.identity.email,
      },
      unsubscribeToken: placeholder,
      provider: null,
      providerMsgId: null,
      blockedReason: null,
      error: null,
      sentAt: null,
    });
  }

  const inserted = await store.addItems(rows);
  // Re-sign each token against its own item id, so an unsubscribe identifies
  // exactly which message the recipient was looking at.
  const finished: SendItem[] = [];
  for (const row of inserted) {
    const token = signUnsubscribeToken({ itemId: row.id, companyId: row.companyId, email: row.toAddress }, env);
    const url = unsubscribeUrl(input.origin, token);
    const body = withFooter(row.body, row.language, url, input.built.sendable[0]?.identity ?? legalIdentity(env));
    finished.push((await store.updateItem(row.id, { unsubscribeToken: token, body })) ?? row);
  }

  return { batch, items: finished };
}

/**
 * Replace whatever footer the drafting step left with the real one.
 *
 * The drafter writes a placeholder line because, until this engine existed,
 * there was no link to put there. Anything from the `—` separator down is
 * ours; above it is the personalised message a person reviewed.
 */
export function withFooter(body: string, language: string, url: string, identity: LegalIdentity): string {
  const cut = body.lastIndexOf("\n—");
  const message = (cut === -1 ? body : body.slice(0, cut)).trimEnd();
  const footer = footerFor({
    language,
    url,
    entity: identity.entity,
    address: identity.address,
    managingDirector: identity.managingDirector,
    registration: identity.registration,
    vatNumber: identity.vatNumber,
    email: identity.email,
  });
  return `${message}\n\n${footer}\n`;
}

export { stepLabel, spacingFor };

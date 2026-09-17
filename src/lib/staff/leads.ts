import type { Lead } from "../leads";
import { isWaitlistLead } from "../leads/waitlist";
import type { LeadCrmRow, LeadEvent, User } from "../types";
import { getLead as getJsonLead, getLeadCrm, getUser, id as newId, listLeadCrm, listLeads as listJsonLeads, listUsers, saveLead, saveLeadCrm } from "../store";
import { isBellineStaff } from "../auth";
import { MARKETS, type Market } from "../markets";
import { isConfigured, isUniqueViolation, query, tx } from "../sales/db/client";
import { staffAudit } from "./audit";
import { STAGE_LABEL, dbStageFor, jsonStatusFor, stageFromDb, stageFromJson, type Stage } from "./stages";

/**
 * Every lead, from every store, as one list.
 *
 * A read model, not a migration. Enquiries, Belle's leads and the DACH
 * waitlist stay JSON rows (`src/lib/leads`); the prospects the agents found
 * stay Postgres rows (`sales.lead`). Each is read into `UnifiedLead` with a
 * composite id that says where it lives — `json:<id>` or `db:<id>` — and every
 * change is written back to that record: the stage into the record itself, in
 * its own vocabulary (stages.ts); the owner, next step and notes into
 * `leadCrm`, keyed by the composite id, because neither store has room for
 * them.
 *
 * Without `DATABASE_URL` the list is the JSON leads alone, and says so; a
 * database that does not answer is the same, never an error page.
 *
 * No `next/*` imports: the checks drive this directly, with the database side
 * replaced by a port.
 */

// --- sources ----------------------------------------------------------------

export type SourceTag = "enquiry" | "website_belle" | "phone_belle" | "whatsapp" | "waitlist_dach" | "researched";

export const SOURCE_LABEL: Record<SourceTag, string> = {
  enquiry: "Enquiry",
  website_belle: "Website Belle",
  phone_belle: "Phone Belle",
  whatsapp: "WhatsApp",
  waitlist_dach: "Waitlist DACH",
  researched: "Researched prospect",
};

export function sourceOfJson(lead: Pick<Lead, "source">): SourceTag {
  const source = lead.source ?? "";
  if (isWaitlistLead(lead)) return "waitlist_dach";
  if (source === "belle:whatsapp") return "whatsapp";
  if (source === "belle:phone") return "phone_belle";
  if (source.startsWith("belle:")) return "website_belle";
  return "enquiry";
}

/** A Postgres lead, as the list needs it. */
export interface DbLeadRow {
  id: number;
  company_id: number;
  name: string;
  email: string | null;
  phone_e164: string | null;
  website: string | null;
  country_code: string | null;
  city: string | null;
  stage: string;
  current_score: number | null;
  priority: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  last_activity_at: Date | string | null;
  drafts: number;
  summary: string | null;
}

/**
 * The database side, as a port: the real one below, or a fake in the checks.
 * `list` returns null when there is no database to read.
 */
export interface LeadDbPort {
  list(): Promise<DbLeadRow[] | null>;
  stageOf(leadId: number): Promise<string | undefined>;
  setStage(leadId: number, dbStage: string, actor: string, summary: string, reason: string | null): Promise<void>;
}

export const realDbPort: LeadDbPort = {
  async list() {
    if (!isConfigured()) return null;
    try {
      return await query<DbLeadRow>(
        `select l.id, c.id as company_id, c.name, c.email, c.phone_e164, c.website,
                c.country_code, c.city, l.stage::text, l.current_score, l.priority::text,
                l.created_at, l.updated_at,
                (select max(a.at) from sales.activity a where a.lead_id = l.id) as last_activity_at,
                (select count(*)::int from sales.message m
                  where m.lead_id = l.id and m.direction = 'outbound'
                    and m.status in ('pending_approval', 'draft')) as drafts,
                r.summary
           from sales.lead l
           join sales.company c on c.id = l.company_id
           left join lateral (
             select summary from sales.research_record rr
              where rr.company_id = c.id order by rr.created_at desc limit 1
           ) r on true
          order by l.updated_at desc
          limit 1000`,
      );
    } catch (err) {
      console.error("[staff/leads] could not read the pipeline:", err instanceof Error ? err.message : String(err));
      return null;
    }
  },
  async stageOf(leadId) {
    if (!isConfigured()) return undefined;
    const rows = await query<{ stage: string }>(`select stage::text from sales.lead where id = $1`, [leadId]);
    return rows[0]?.stage;
  },
  async setStage(leadId, dbStage, actor, summary, reason) {
    await tx(async (c) => {
      const before = await c.query<{ stage: string; company_id: number; agent_id: number }>(
        `select stage::text, company_id, agent_id from sales.lead where id = $1 for update`,
        [leadId],
      );
      const row = before.rows[0];
      if (!row) throw new Error("No such lead.");
      await c.query(
        `update sales.lead
            set stage = $2::sales.lead_stage, stage_changed_at = now(), updated_at = now(),
                closed_reason = case when $2 in ('lost', 'do_not_contact') then $3 else closed_reason end
          where id = $1`,
        [leadId, dbStage, reason],
      );
      await c.query(
        `insert into sales.activity (lead_id, company_id, agent_id, actor, type, summary, data)
         values ($1, $2, $3, $4, 'stage_changed', $5, $6)`,
        [leadId, row.company_id, row.agent_id, actor, summary.slice(0, 500), JSON.stringify({ from: row.stage, to: dbStage, reason })],
      );
    });
  },
};

// --- the unified row ----------------------------------------------------------

export interface UnifiedLead {
  /** `json:<id>` or `db:<id>`. */
  id: string;
  store: "json" | "db";
  sourceId: string;
  /** The business, or the person when there is no business name. */
  name: string;
  contactName?: string;
  email?: string;
  phone?: string;
  website?: string;
  source: SourceTag;
  country?: string;
  countryName?: string;
  city?: string;
  stage: Stage;
  /** The stored value the stage was read from. */
  storedStage: string;
  score: number | null;
  priority: string | null;
  hot: boolean;
  ownerUserId?: string;
  ownerName?: string;
  nextAction?: string;
  nextActionDue?: string;
  createdAt: string;
  lastActivityAt: string;
  /** Drafts written by the agents that are waiting for a person. */
  drafts: number;
  summary?: string;
  notes?: string;
}

/** Events that make a lead hot for the next fortnight. The video demo agent records `demo_watched`. */
export const HOT_EVENT_TYPES = ["demo_watched", "demo_replied"] as const;
const HOT_WINDOW_MS = 14 * 86_400_000;

function iso(at: Date | string | null | undefined): string {
  if (!at) return "";
  return typeof at === "string" ? new Date(at).toISOString() : at.toISOString();
}

function latest(...values: (string | undefined)[]): string {
  return values.filter((v): v is string => Boolean(v)).sort().pop() ?? "";
}

export function countryName(code: string | null | undefined): string | undefined {
  if (!code) return undefined;
  const upper = code.toUpperCase();
  const known = (MARKETS as Record<string, { name: string }>)[upper];
  if (known) return known.name;
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(upper) ?? upper;
  } catch {
    return upper;
  }
}

function hotFromEvents(crm: LeadCrmRow | undefined, now: number): boolean {
  return Boolean(
    crm?.events.some((e) => (HOT_EVENT_TYPES as readonly string[]).includes(e.type) && now - Date.parse(e.at) < HOT_WINDOW_MS),
  );
}

function withCrm(base: Omit<UnifiedLead, "ownerName" | "hot">, crm: LeadCrmRow | undefined, now: number, hot: boolean): UnifiedLead {
  const owner = crm?.ownerUserId ? getUser(crm.ownerUserId) : undefined;
  const lastEvent = crm ? latest(...crm.events.map((e) => e.at), ...crm.notes.map((n) => n.at)) : "";
  return {
    ...base,
    ownerUserId: crm?.ownerUserId,
    ownerName: owner ? owner.name || owner.email : undefined,
    nextAction: crm?.nextAction,
    nextActionDue: crm?.nextActionDue,
    lastActivityAt: latest(base.lastActivityAt, lastEvent),
    hot: hot || base.stage === "demo_watched" || hotFromEvents(crm, now),
  };
}

export function fromJson(lead: Lead, crm: LeadCrmRow | undefined, now = Date.now()): UnifiedLead {
  return withCrm(
    {
      id: `json:${lead.id}`,
      store: "json",
      sourceId: lead.id,
      name: lead.company || lead.name,
      contactName: lead.company ? lead.name : undefined,
      email: lead.email || undefined,
      phone: lead.phone || undefined,
      website: lead.website,
      source: sourceOfJson(lead),
      country: lead.market,
      countryName: lead.market ? MARKETS[lead.market as Market]?.name ?? countryName(lead.market) : undefined,
      stage: stageFromJson(lead.status),
      storedStage: lead.status,
      score: null,
      priority: null,
      createdAt: lead.createdAt,
      lastActivityAt: lead.createdAt,
      drafts: 0,
      notes: lead.notes,
    },
    crm,
    now,
    false,
  );
}

export function fromDb(row: DbLeadRow, crm: LeadCrmRow | undefined, now = Date.now()): UnifiedLead {
  return withCrm(
    {
      id: `db:${row.id}`,
      store: "db",
      sourceId: String(row.id),
      name: row.name,
      email: row.email ?? undefined,
      phone: row.phone_e164 ?? undefined,
      website: row.website ?? undefined,
      source: "researched",
      country: row.country_code ?? undefined,
      countryName: countryName(row.country_code),
      city: row.city ?? undefined,
      stage: stageFromDb(row.stage),
      storedStage: row.stage,
      score: row.current_score,
      priority: row.priority,
      createdAt: iso(row.created_at),
      lastActivityAt: latest(iso(row.updated_at), iso(row.last_activity_at)),
      drafts: Number(row.drafts ?? 0),
      summary: row.summary ?? undefined,
    },
    crm,
    now,
    row.priority === "hot",
  );
}

export interface LeadList {
  leads: UnifiedLead[];
  /** False when the Postgres pipeline could not be read: no database, or it did not answer. */
  pipelineRead: boolean;
}

export async function allLeads(port: LeadDbPort = realDbPort, now = Date.now()): Promise<LeadList> {
  const crm = new Map(listLeadCrm().map((r) => [r.id, r]));
  const json = listJsonLeads().map((l) => fromJson(l, crm.get(`json:${l.id}`), now));
  const rows = await port.list();
  const db = (rows ?? []).map((r) => fromDb(r, crm.get(`db:${r.id}`), now));
  const leads = [...json, ...db].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  return { leads, pipelineRead: rows !== null };
}

// --- filters ------------------------------------------------------------------

export interface LeadFilter {
  source?: SourceTag;
  stage?: Stage;
  country?: string;
  /** A user id, or "none" for unassigned. */
  owner?: string;
  hot?: boolean;
  drafts?: boolean;
  q?: string;
}

export function filterLeads(leads: UnifiedLead[], f: LeadFilter): UnifiedLead[] {
  const q = f.q?.trim().toLowerCase();
  return leads.filter((l) => {
    if (f.source && l.source !== f.source) return false;
    if (f.stage && l.stage !== f.stage) return false;
    if (f.country && (l.country ?? "").toUpperCase() !== f.country.toUpperCase()) return false;
    if (f.owner === "none" ? Boolean(l.ownerUserId) : f.owner && l.ownerUserId !== f.owner) return false;
    if (f.hot && !l.hot) return false;
    if (f.drafts && l.drafts === 0) return false;
    if (q && ![l.name, l.contactName, l.email, l.phone, l.website, l.city].some((v) => v?.toLowerCase().includes(q))) return false;
    return true;
  });
}

/** The people a lead can be assigned to: Belline staff. */
export function staffUsers(): User[] {
  return listUsers().filter((u) => !u.disabled && isBellineStaff(u));
}

// --- ids ----------------------------------------------------------------------

export type ParsedLeadId = { store: "json"; id: string } | { store: "db"; id: number };

export function parseLeadId(raw: string): ParsedLeadId | null {
  const value = decodeURIComponent(raw);
  if (value.startsWith("json:") && value.length > 5) return { store: "json", id: value.slice(5) };
  if (value.startsWith("db:")) {
    const n = Number(value.slice(3));
    return Number.isInteger(n) && n > 0 ? { store: "db", id: n } : null;
  }
  return null;
}

export function leadHref(compositeId: string): string {
  return `/sales/leads/${encodeURIComponent(compositeId)}`;
}

async function exists(parsed: ParsedLeadId, port: LeadDbPort): Promise<string | undefined> {
  if (parsed.store === "json") return getJsonLead(parsed.id)?.status ?? undefined;
  return port.stageOf(parsed.id);
}

// --- the CRM row --------------------------------------------------------------

function crmRow(compositeId: string): LeadCrmRow {
  return getLeadCrm(compositeId) ?? { id: compositeId, notes: [], events: [], updatedAt: new Date(0).toISOString() };
}

/**
 * Something happened to a lead: add it to the timeline.
 *
 * The hook for anything outside this module — the video demo, a reply, a
 * booking. `type: "demo_watched"` also marks the lead hot for two weeks
 * (`HOT_EVENT_TYPES`). Returns null for an id that is not a lead.
 */
export function recordLeadEvent(
  compositeId: string,
  event: { type: string; summary: string; actor: string; data?: Record<string, unknown> },
  now: Date = new Date(),
): LeadEvent | null {
  if (!parseLeadId(compositeId)) return null;
  const row = crmRow(compositeId);
  const saved: LeadEvent = { id: newId("lev"), at: now.toISOString(), type: event.type, summary: event.summary.slice(0, 500), actor: event.actor, ...(event.data ? { data: event.data } : {}) };
  saveLeadCrm({ ...row, events: [...row.events, saved], updatedAt: saved.at });
  return saved;
}

export type Outcome<T = undefined> = { ok: true; value: T } | { ok: false; status: number; error: string };

const actorOf = (user: User) => `user:${user.id}`;

export async function changeStage(
  compositeId: string,
  stage: Stage,
  user: User,
  reason: string | null,
  port: LeadDbPort = realDbPort,
): Promise<Outcome<{ from: Stage; to: Stage }>> {
  const parsed = parseLeadId(compositeId);
  if (!parsed) return { ok: false, status: 404, error: "No such lead." };
  const stored = await exists(parsed, port);
  if (stored === undefined) return { ok: false, status: 404, error: "No such lead." };

  if (parsed.store === "json") {
    const lead = getJsonLead(parsed.id)!;
    const from = stageFromJson(lead.status);
    if (from === stage) return { ok: true, value: { from, to: stage } };
    saveLead({ ...lead, status: jsonStatusFor(stage) });
    recordLeadEvent(compositeId, { type: "stage_changed", summary: `Stage: ${STAGE_LABEL[from]} → ${STAGE_LABEL[stage]}${reason ? ` (${reason})` : ""}`, actor: actorOf(user), data: { from, to: stage } });
    await staffAudit({ actor: user, action: "lead_stage_changed", entity: "lead", entityId: compositeId, reason: reason ?? undefined, before: { status: lead.status }, after: { status: stage } });
    return { ok: true, value: { from, to: stage } };
  }

  const from = stageFromDb(stored);
  if (from === stage) return { ok: true, value: { from, to: stage } };
  const dbStage = dbStageFor(stage, stored);
  try {
    await port.setStage(parsed.id, dbStage, actorOf(user), `Stage: ${STAGE_LABEL[from]} → ${STAGE_LABEL[stage]}${reason ? ` (${reason})` : ""}`, reason);
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { ok: false, status: 409, error: "Another agent is already working this company. Close that lead first." };
    }
    throw err;
  }
  await staffAudit({ actor: user, action: "lead_stage_changed", entity: "lead", entityId: compositeId, reason: reason ?? undefined, before: { stage: stored }, after: { stage: dbStage } });
  return { ok: true, value: { from, to: stage } };
}

export async function assignOwner(compositeId: string, ownerUserId: string | null, user: User, port: LeadDbPort = realDbPort): Promise<Outcome> {
  const parsed = parseLeadId(compositeId);
  if (!parsed || (await exists(parsed, port)) === undefined) return { ok: false, status: 404, error: "No such lead." };
  if (ownerUserId && !staffUsers().some((u) => u.id === ownerUserId)) {
    return { ok: false, status: 422, error: "Leads can only be given to Belline staff." };
  }
  const row = crmRow(compositeId);
  if ((row.ownerUserId ?? null) === ownerUserId) return { ok: true, value: undefined };
  const owner = ownerUserId ? getUser(ownerUserId) : undefined;
  saveLeadCrm({ ...row, ownerUserId: ownerUserId ?? undefined, updatedAt: new Date().toISOString() });
  recordLeadEvent(compositeId, { type: "owner_changed", summary: owner ? `Given to ${owner.name || owner.email}` : "Owner removed", actor: actorOf(user) });
  await staffAudit({ actor: user, action: "lead_owner_changed", entity: "lead", entityId: compositeId, before: { ownerUserId: row.ownerUserId ?? null }, after: { ownerUserId } });
  return { ok: true, value: undefined };
}

export async function setNextAction(
  compositeId: string,
  text: string,
  due: string | null,
  user: User,
  port: LeadDbPort = realDbPort,
): Promise<Outcome> {
  const parsed = parseLeadId(compositeId);
  if (!parsed || (await exists(parsed, port)) === undefined) return { ok: false, status: 404, error: "No such lead." };
  const clean = text.trim().slice(0, 200);
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) return { ok: false, status: 422, error: "Pick a due date." };
  if (due && !clean) return { ok: false, status: 422, error: "Say what the next step is." };
  const row = crmRow(compositeId);
  saveLeadCrm({ ...row, nextAction: clean || undefined, nextActionDue: clean ? due ?? undefined : undefined, updatedAt: new Date().toISOString() });
  recordLeadEvent(compositeId, { type: "next_action", summary: clean ? `Next: ${clean}${due ? ` by ${due}` : ""}` : "Next step cleared", actor: actorOf(user) });
  await staffAudit({ actor: user, action: "lead_next_action_set", entity: "lead", entityId: compositeId, before: { nextAction: row.nextAction ?? null, due: row.nextActionDue ?? null }, after: { nextAction: clean || null, due: clean ? due : null } });
  return { ok: true, value: undefined };
}

export async function addNote(compositeId: string, text: string, user: User, port: LeadDbPort = realDbPort): Promise<Outcome> {
  const parsed = parseLeadId(compositeId);
  if (!parsed || (await exists(parsed, port)) === undefined) return { ok: false, status: 404, error: "No such lead." };
  const clean = text.trim().slice(0, 4000);
  if (clean.length < 2) return { ok: false, status: 422, error: "Write the note first." };
  const row = crmRow(compositeId);
  const at = new Date().toISOString();
  const note = { id: newId("note"), at, by: user.id, byName: user.name || user.email, text: clean };
  saveLeadCrm({ ...row, notes: [...row.notes, note], updatedAt: at });
  await staffAudit({ actor: user, action: "lead_note_added", entity: "lead", entityId: compositeId, after: { noteId: note.id, length: clean.length } });
  return { ok: true, value: undefined };
}

// --- the timeline -------------------------------------------------------------

export interface TimelineItem {
  id: string;
  at: string;
  type: string;
  summary: string;
  /** "You", a staff member's name, "Agent", "Belle", "System". */
  who: string;
  body?: string;
}

function whoFor(actor: string, viewer?: User): string {
  if (actor.startsWith("user:")) {
    const userId = actor.slice(5);
    if (viewer && viewer.id === userId) return "You";
    const u = getUser(userId);
    return u ? u.name || u.email : "Staff";
  }
  if (actor.startsWith("agent:")) return "Sales agent";
  return "System";
}

/** Plain words for the event types the timeline can hold. */
export const EVENT_LABEL: Record<string, string> = {
  created: "Came in",
  note: "Note",
  stage_changed: "Stage changed",
  owner_changed: "Owner changed",
  next_action: "Next step",
  marked_sent: "Email sent by hand",
  discovered: "Found",
  imported: "Imported",
  merged: "Merged",
  researched: "Website read",
  scored: "Scored",
  drafted: "Email drafted",
  approved: "Draft approved",
  rejected: "Draft rejected",
  sent: "Email sent",
  demo_issued: "Demo built",
  demo_used: "Demo used",
  demo_watched: "Demo watched",
  agent_paused: "Agent paused",
  error: "Problem",
};

export function eventLabel(type: string): string {
  return EVENT_LABEL[type] ?? type.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/**
 * The timeline: what the stores recorded, plus staff notes and events.
 * `dbActivity` is the Postgres activity for a `db:` lead (kpi/leads.ts `getTimeline`).
 */
export function mergeTimeline(
  compositeId: string,
  opts: {
    createdAt?: string;
    source?: SourceTag;
    dbActivity?: { id: number; at: Date | string; actor: string; type: string; summary: string }[];
    viewer?: User;
  },
): TimelineItem[] {
  const row = getLeadCrm(compositeId);
  const items: TimelineItem[] = [];
  if (opts.createdAt) {
    items.push({ id: "created", at: opts.createdAt, type: "created", summary: opts.source ? `Came in: ${SOURCE_LABEL[opts.source]}` : "Came in", who: opts.source === "researched" ? "Sales agent" : "System" });
  }
  for (const a of opts.dbActivity ?? []) {
    items.push({ id: `act:${a.id}`, at: iso(a.at), type: a.type, summary: a.summary, who: whoFor(a.actor, opts.viewer) });
  }
  for (const e of row?.events ?? []) {
    // A db stage change is already in sales.activity; the JSON event is its twin.
    items.push({ id: e.id, at: e.at, type: e.type, summary: e.summary, who: whoFor(e.actor, opts.viewer) });
  }
  for (const n of row?.notes ?? []) {
    items.push({ id: n.id, at: n.at, type: "note", summary: "Note", body: n.text, who: opts.viewer?.id === n.by ? "You" : n.byName });
  }
  return items.sort((a, b) => b.at.localeCompare(a.at));
}

export function crmFor(compositeId: string): LeadCrmRow | undefined {
  return getLeadCrm(compositeId);
}

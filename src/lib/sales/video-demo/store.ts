import { isConfigured, query, tx } from "../db/client";
import { log as logActivity } from "../db/repo/activity";
import { isSuppressed } from "../compliance/suppression";
import { DEFAULT_CONFIG } from "../config/defaults";
import { flag } from "../../flags";
import type { ProspectFacts, ProspectSource } from "./context";

/** The shipped compliance defaults, used where an agent's own configuration cannot be read. */
const DEFAULT_MIN_DAYS = DEFAULT_CONFIG.compliance?.min_days_between_touches ?? 2;
const DEFAULT_TOUCH_CAP = DEFAULT_CONFIG.compliance?.company_touch_cap_90d ?? 6;

/**
 * Where video-demo links, their counters and their timeline rows live.
 *
 * Postgres (`sales.video_demo`, `sales.activity`) wherever the sales database
 * is. In memory for the checks and for a stubbed local run, which have no
 * database by design — the same split every provider in this app follows.
 * The memory store refuses to stand in for Postgres anywhere a real database
 * is configured and the stubs are not on.
 */

export interface DemoStats {
  opens: number;
  firstOpenedAt?: string;
  lastOpenedAt?: string;
  videoSessions: number;
  videoSeconds: number;
  longestVideoSeconds: number;
  chats: number;
  chatMessages: number;
  /** Visitor turns that asked something. A count, never the words. */
  questions: number;
  topics: string[];
  outcomes: string[];
  costUsd: number;
  getStartedClicks: number;
  emailPreparedAt?: string;
}

export interface VideoDemoLink {
  id: string;
  leadId: number;
  companyId: number | null;
  facts: ProspectFacts;
  opening: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  revokedBy?: string;
  stats: DemoStats;
  /** Per UTC day: what the rate limits count. */
  daily: Record<string, { video: number; chats: number; opens: number }>;
}

export type DemoEventName =
  | "link_created"
  | "opened"
  | "video_started"
  | "video_ended"
  | "chat_started"
  | "chat_ended"
  | "get_started_clicked"
  | "email_prepared"
  | "revoked";

export interface DemoActivityRow {
  id: number;
  leadId: number;
  companyId: number | null;
  actor: string;
  type: "demo_issued" | "demo_used";
  summary: string;
  data: Record<string, unknown>;
  at: string;
}

export interface TouchPolicy {
  minDaysBetweenTouches: number;
  touchCap90d: number;
  lastTouchAt: string | null;
  touches90d: number;
}

export function emptyStats(): DemoStats {
  return {
    opens: 0,
    videoSessions: 0,
    videoSeconds: 0,
    longestVideoSeconds: 0,
    chats: 0,
    chatMessages: 0,
    questions: 0,
    topics: [],
    outcomes: [],
    costUsd: 0,
    getStartedClicks: 0,
  };
}

export type DemoStatus = "active" | "expired" | "revoked";

export function demoStatus(link: Pick<VideoDemoLink, "expiresAt" | "revokedAt">, now = Date.now()): DemoStatus {
  if (link.revokedAt) return "revoked";
  if (Date.parse(link.expiresAt) <= now) return "expired";
  return "active";
}

/** "Hot": watched for more than a minute, or asked something. */
export function isHot(stats: DemoStats): boolean {
  return stats.longestVideoSeconds > 60 || stats.videoSeconds > 60 || stats.questions > 0;
}

export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export interface DemoStore {
  readonly kind: "postgres" | "memory";
  insert(link: VideoDemoLink): Promise<void>;
  get(id: string): Promise<VideoDemoLink | null>;
  list(filter?: { leadId?: number; limit?: number }): Promise<VideoDemoLink[]>;
  /** Read, change and write one link atomically. Returning null writes nothing. */
  update(id: string, change: (link: VideoDemoLink) => VideoDemoLink | null): Promise<VideoDemoLink | null>;
  log(row: Omit<DemoActivityRow, "id" | "at">): Promise<void>;
  timeline(leadId: number): Promise<DemoActivityRow[]>;
  loadSource(leadId: number): Promise<ProspectSource | null>;
  suppressed(check: { email?: string | null; domain?: string | null; companyId?: number | null }): Promise<string | null>;
  touchPolicy(leadId: number): Promise<TouchPolicy>;
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

interface MemoryState {
  links: Map<string, VideoDemoLink>;
  activity: DemoActivityRow[];
  sources: Map<number, ProspectSource>;
  suppressions: { matchType: "email" | "domain" | "company_id"; value: string; reason: string }[];
  touches: { leadId: number; at: string }[];
}

const globalRef = globalThis as unknown as { __bellineVideoDemoMemory?: MemoryState; __bellineVideoDemoStore?: DemoStore };

function memoryState(): MemoryState {
  globalRef.__bellineVideoDemoMemory ??= { links: new Map(), activity: [], sources: new Map(), suppressions: [], touches: [] };
  return globalRef.__bellineVideoDemoMemory;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

class MemoryDemoStore implements DemoStore {
  readonly kind = "memory" as const;
  async insert(link: VideoDemoLink) {
    const s = memoryState();
    if (s.links.has(link.id)) throw new Error("duplicate demo link id");
    s.links.set(link.id, clone(link));
  }
  async get(id: string) {
    const found = memoryState().links.get(id);
    return found ? clone(found) : null;
  }
  async list(filter: { leadId?: number; limit?: number } = {}) {
    return [...memoryState().links.values()]
      .filter((l) => filter.leadId === undefined || l.leadId === filter.leadId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, filter.limit ?? 200)
      .map(clone);
  }
  async update(id: string, change: (link: VideoDemoLink) => VideoDemoLink | null) {
    const s = memoryState();
    const found = s.links.get(id);
    if (!found) return null;
    const next = change(clone(found));
    if (!next) return null;
    s.links.set(id, clone(next));
    return clone(next);
  }
  async log(row: Omit<DemoActivityRow, "id" | "at">) {
    const s = memoryState();
    s.activity.unshift({ ...clone(row), id: s.activity.length + 1, at: new Date().toISOString() });
    if (row.data?.event === "email_prepared") s.touches.push({ leadId: row.leadId, at: new Date().toISOString() });
  }
  async timeline(leadId: number) {
    return memoryState().activity.filter((a) => a.leadId === leadId).map(clone);
  }
  async loadSource(leadId: number) {
    const found = memoryState().sources.get(leadId);
    return found ? clone(found) : null;
  }
  async suppressed(check: { email?: string | null; domain?: string | null; companyId?: number | null }) {
    const email = check.email?.trim().toLowerCase();
    const domains = [check.domain, email?.split("@")[1]].filter(Boolean).map((d) => String(d).replace(/^www\./, "").toLowerCase());
    const hit = memoryState().suppressions.find(
      (s) =>
        (s.matchType === "email" && s.value.toLowerCase() === email) ||
        (s.matchType === "domain" && domains.includes(s.value.toLowerCase())) ||
        (s.matchType === "company_id" && check.companyId != null && s.value === String(check.companyId)),
    );
    return hit ? `${hit.reason} (${hit.matchType} ${hit.value})` : null;
  }
  async touchPolicy(leadId: number): Promise<TouchPolicy> {
    const since = Date.now() - 90 * 86_400_000;
    const touches = memoryState().touches.filter((t) => t.leadId === leadId).map((t) => t.at).sort();
    return {
      minDaysBetweenTouches: DEFAULT_MIN_DAYS,
      touchCap90d: DEFAULT_TOUCH_CAP,
      lastTouchAt: touches.at(-1) ?? null,
      touches90d: touches.filter((t) => Date.parse(t) >= since).length,
    };
  }
}

/** For the checks and the stubbed run: rows the Postgres store would have read. */
export const memoryFixtures = {
  reset(): void {
    globalRef.__bellineVideoDemoMemory = { links: new Map(), activity: [], sources: new Map(), suppressions: [], touches: [] };
  },
  putSource(source: ProspectSource): void {
    memoryState().sources.set(source.leadId, clone(source));
  },
  suppress(matchType: "email" | "domain" | "company_id", value: string, reason = "opt_out"): void {
    memoryState().suppressions.push({ matchType, value, reason });
  },
  touch(leadId: number, at: string): void {
    memoryState().touches.push({ leadId, at });
  },
};

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

interface Row {
  id: string;
  lead_id: number;
  company_id: number | null;
  facts: ProspectFacts;
  opening: string;
  created_by: string;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  revoked_by: string | null;
  stats: Partial<DemoStats>;
  daily: VideoDemoLink["daily"];
}

function fromRow(r: Row): VideoDemoLink {
  return {
    id: r.id,
    leadId: Number(r.lead_id),
    companyId: r.company_id === null ? null : Number(r.company_id),
    facts: r.facts,
    opening: r.opening,
    createdBy: r.created_by,
    createdAt: new Date(r.created_at).toISOString(),
    expiresAt: new Date(r.expires_at).toISOString(),
    ...(r.revoked_at ? { revokedAt: new Date(r.revoked_at).toISOString() } : {}),
    ...(r.revoked_by ? { revokedBy: r.revoked_by } : {}),
    stats: { ...emptyStats(), ...(r.stats ?? {}) },
    daily: r.daily ?? {},
  };
}

const COLUMNS = "id, lead_id, company_id, facts, opening, created_by, created_at, expires_at, revoked_at, revoked_by, stats, daily";

class PostgresDemoStore implements DemoStore {
  readonly kind = "postgres" as const;
  async insert(link: VideoDemoLink) {
    await query(
      `insert into sales.video_demo (${COLUMNS})
       values ($1, $2, $3, $4, $5, $6, $7, $8, null, null, $9, $10)`,
      [link.id, link.leadId, link.companyId, JSON.stringify(link.facts), link.opening, link.createdBy, link.createdAt, link.expiresAt, JSON.stringify(link.stats), JSON.stringify(link.daily)],
    );
  }
  async get(id: string) {
    const rows = await query<Row>(`select ${COLUMNS} from sales.video_demo where id = $1`, [id]);
    return rows[0] ? fromRow(rows[0]) : null;
  }
  async list(filter: { leadId?: number; limit?: number } = {}) {
    const rows = await query<Row>(
      `select ${COLUMNS} from sales.video_demo
        where ($1::bigint is null or lead_id = $1)
        order by created_at desc limit $2`,
      [filter.leadId ?? null, filter.limit ?? 200],
    );
    return rows.map(fromRow);
  }
  async update(id: string, change: (link: VideoDemoLink) => VideoDemoLink | null) {
    return tx(async (c) => {
      const found = await c.query<Row>(`select ${COLUMNS} from sales.video_demo where id = $1 for update`, [id]);
      if (!found.rows[0]) return null;
      const next = change(fromRow(found.rows[0]));
      if (!next) return null;
      await c.query(
        `update sales.video_demo set opening = $2, revoked_at = $3, revoked_by = $4, stats = $5, daily = $6 where id = $1`,
        [id, next.opening, next.revokedAt ?? null, next.revokedBy ?? null, JSON.stringify(next.stats), JSON.stringify(next.daily)],
      );
      return next;
    });
  }
  async log(row: Omit<DemoActivityRow, "id" | "at">) {
    await logActivity({
      leadId: row.leadId,
      companyId: row.companyId,
      actor: row.actor,
      type: row.type,
      summary: row.summary,
      data: row.data,
    });
  }
  async timeline(leadId: number) {
    const rows = await query<{ id: number; lead_id: number; company_id: number | null; actor: string; type: string; summary: string; data: Record<string, unknown>; at: Date }>(
      `select id, lead_id, company_id, actor, type, summary, data, at from sales.activity
        where lead_id = $1 and type in ('demo_issued', 'demo_used') and data ? 'videoDemo'
        order by at desc limit 100`,
      [leadId],
    );
    return rows.map((r) => ({
      id: r.id,
      leadId: Number(r.lead_id),
      companyId: r.company_id,
      actor: r.actor,
      type: r.type as DemoActivityRow["type"],
      summary: r.summary,
      data: r.data,
      at: new Date(r.at).toISOString(),
    }));
  }
  async loadSource(leadId: number): Promise<ProspectSource | null> {
    const rows = await query<{
      lead_id: number;
      company_id: number;
      name: string;
      city: string | null;
      country_code: string | null;
      vertical_slug: string | null;
      website: string | null;
      domain: string | null;
      email: string | null;
      has_whatsapp: boolean | null;
      booking_provider: string | null;
      booking_url: string | null;
      opening_hours: unknown;
      location_count: number | null;
      rating: number | null;
      review_count: number | null;
      contact_name: string | null;
      contact_email: string | null;
      contact_language: string | null;
      research_id: number | null;
      summary: string | null;
      signals: Record<string, unknown> | null;
      evidence: ProspectSource["research"] extends infer R ? (R extends { evidence: infer E } ? E : never) : never;
      research_at: Date | null;
      demo_slug: string | null;
      demo_scenario: string | null;
    }>(
      `select l.id as lead_id, c.id as company_id, c.name, c.city, c.country_code, c.vertical_slug,
              c.website, c.domain, c.email, c.has_whatsapp, c.booking_provider, c.booking_url,
              c.opening_hours, c.location_count, c.rating, c.review_count,
              ct.full_name as contact_name, ct.email as contact_email, ct.language as contact_language,
              r.id as research_id, r.summary, r.signals, r.evidence, r.created_at as research_at,
              d.location_slug as demo_slug, d.scenario as demo_scenario
         from sales.lead l
         join sales.company c on c.id = l.company_id
         left join sales.contact ct on ct.id = l.contact_id and ct.redacted_at is null
         left join lateral (
           select id, summary, signals, evidence, created_at from sales.research_record rr
            where rr.company_id = c.id order by rr.created_at desc limit 1
         ) r on true
         left join lateral (
           select location_slug, scenario from sales.demo dd
            where dd.lead_id = l.id and dd.expires_at > now()
            order by dd.issued_at desc limit 1
         ) d on true
        where l.id = $1`,
      [leadId],
    );
    const r = rows[0];
    if (!r) return null;
    let demoServices: { name: string; price?: number }[] | null = null;
    if (r.demo_slug) {
      try {
        const { findProspect } = await import("../../prospect");
        demoServices = findProspect(r.demo_slug)?.salon?.services.map((s) => ({ name: s.name, price: s.price })) ?? null;
      } catch {
        demoServices = null;
      }
    }
    return {
      leadId: Number(r.lead_id),
      companyId: Number(r.company_id),
      company: {
        name: r.name,
        city: r.city,
        country_code: r.country_code,
        vertical_slug: r.vertical_slug,
        website: r.website,
        domain: r.domain,
        email: r.email,
        has_whatsapp: r.has_whatsapp,
        booking_provider: r.booking_provider,
        booking_url: r.booking_url,
        opening_hours: r.opening_hours,
        location_count: r.location_count,
        rating: r.rating,
        review_count: r.review_count,
      },
      contact: r.contact_name || r.contact_email ? { full_name: r.contact_name, email: r.contact_email, language: r.contact_language } : null,
      research: r.research_id
        ? { id: Number(r.research_id), summary: r.summary ?? "", signals: r.signals ?? {}, evidence: r.evidence ?? [], created_at: r.research_at ?? new Date() }
        : null,
      demo: r.demo_slug ? { location_slug: r.demo_slug, scenario: r.demo_scenario } : null,
      demoServices,
    };
  }
  async suppressed(check: { email?: string | null; domain?: string | null; companyId?: number | null }) {
    return isSuppressed(check);
  }
  async touchPolicy(leadId: number): Promise<TouchPolicy> {
    // The lead's own agent configuration decides the spacing, as it does for
    // every other outreach touch.
    let minDays = DEFAULT_MIN_DAYS;
    let cap = DEFAULT_TOUCH_CAP;
    try {
      const agent = await query<{ agent_id: number }>(`select agent_id from sales.lead where id = $1`, [leadId]);
      if (agent[0]) {
        const { resolveAgentConfig } = await import("../config/agents");
        const { config } = await resolveAgentConfig(Number(agent[0].agent_id));
        minDays = config.compliance.min_days_between_touches;
        cap = config.compliance.company_touch_cap_90d;
      }
    } catch {
      /* the defaults, which are the strictest shipped values */
    }
    const rows = await query<{ last: Date | null; n: number }>(
      `select max(at) as last, count(*) filter (where at > now() - interval '90 days')::int as n from (
         select m.created_at as at from sales.message m
          where m.lead_id = $1 and m.direction = 'outbound' and m.sent_at is not null
         union all
         select a.at from sales.activity a
          where a.lead_id = $1 and a.type = 'demo_issued' and a.data->>'event' = 'email_prepared'
       ) t`,
      [leadId],
    );
    return {
      minDaysBetweenTouches: minDays,
      touchCap90d: cap,
      lastTouchAt: rows[0]?.last ? new Date(rows[0].last).toISOString() : null,
      touches90d: rows[0]?.n ?? 0,
    };
  }
}

/** The store for this process: Postgres where it exists, memory for the checks and the stubbed run. */
export function demoStore(): DemoStore {
  const wantMemory = !isConfigured() || flag("stubs");
  const cached = globalRef.__bellineVideoDemoStore;
  if (cached && (cached.kind === "memory") === wantMemory) return cached;
  globalRef.__bellineVideoDemoStore = wantMemory ? new MemoryDemoStore() : new PostgresDemoStore();
  return globalRef.__bellineVideoDemoStore;
}

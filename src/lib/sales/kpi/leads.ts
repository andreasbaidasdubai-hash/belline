import { isConfigured, query } from "../db/client";

/** Queries behind the pipeline views. */

export interface LeadListRow {
  lead_id: number;
  company_id: number;
  name: string;
  city: string | null;
  domain: string | null;
  phone_e164: string | null;
  rating: number | null;
  review_count: number | null;
  branches: number;
  stage: string;
  priority: string | null;
  current_score: number | null;
  agent_name: string;
  researched: boolean;
  summary: string | null;
  use_cases: string[] | null;
  updated_at: Date;
}

export async function listLeads(filter: {
  agentId?: number;
  stage?: string;
  limit?: number;
} = {}): Promise<LeadListRow[]> {
  if (!isConfigured()) return [];
  try {
    return await query<LeadListRow>(
      `select l.id as lead_id, c.id as company_id, c.name, c.city, c.domain,
              c.phone_e164, c.rating, c.review_count,
              (select count(*)::int from sales.company_location cl
                where cl.company_id = c.id) as branches,
              l.stage::text, l.priority::text, l.current_score,
              a.name as agent_name, l.updated_at,
              r.id is not null as researched,
              r.summary, r.use_cases
         from sales.lead l
         join sales.company c on c.id = l.company_id
         join sales.agent a on a.id = l.agent_id
         -- The latest research record, if any. A lateral join rather than a
         -- group-by because research is append-only and we want the newest.
         left join lateral (
           select id, summary, use_cases from sales.research_record rr
            where rr.company_id = c.id order by rr.created_at desc limit 1
         ) r on true
        where ($1::bigint is null or l.agent_id = $1)
          and ($2::text is null or l.stage::text = $2)
        order by l.current_score desc nulls last, c.review_count desc nulls last
        limit $3`,
      [filter.agentId ?? null, filter.stage ?? null, filter.limit ?? 200],
    );
  } catch {
    return [];
  }
}

export interface LeadDetail {
  lead_id: number;
  company_id: number;
  name: string;
  city: string | null;
  address: string | null;
  website: string | null;
  domain: string | null;
  phone_e164: string | null;
  email: string | null;
  rating: number | null;
  review_count: number | null;
  has_whatsapp: boolean | null;
  vertical_slug: string | null;
  stage: string;
  priority: string | null;
  current_score: number | null;
  agent_id: number;
  agent_name: string;
  created_at: Date;
  sources: { slug: string; url?: string; at: string }[];
}

export async function getLead(leadId: number): Promise<LeadDetail | undefined> {
  if (!isConfigured()) return undefined;
  try {
    const rows = await query<LeadDetail>(
      `select l.id as lead_id, c.id as company_id, c.name, c.city, c.address,
              c.website, c.domain, c.phone_e164, c.email, c.rating, c.review_count,
              c.has_whatsapp, c.vertical_slug, c.sources,
              l.stage::text, l.priority::text, l.current_score,
              a.id as agent_id, a.name as agent_name, l.created_at
         from sales.lead l
         join sales.company c on c.id = l.company_id
         join sales.agent a on a.id = l.agent_id
        where l.id = $1`,
      [leadId],
    );
    return rows[0];
  } catch {
    return undefined;
  }
}

export interface ResearchView {
  id: number;
  summary: string;
  signals: Record<string, unknown>;
  use_cases: string[];
  evidence: { claim: string; url: string; quote: string }[];
  pages_read: string[];
  model: string;
  cost_usd: number | null;
  created_at: Date;
}

export async function getResearch(companyId: number): Promise<ResearchView | undefined> {
  if (!isConfigured()) return undefined;
  try {
    const rows = await query<ResearchView>(
      `select id, summary, signals, use_cases, evidence, pages_read, model, cost_usd, created_at
         from sales.research_record where company_id = $1
        order by created_at desc limit 1`,
      [companyId],
    );
    return rows[0];
  } catch {
    return undefined;
  }
}

export interface LocationRow {
  address: string | null;
  city: string | null;
  external_id: string | null;
}

export async function getLocations(companyId: number): Promise<LocationRow[]> {
  if (!isConfigured()) return [];
  try {
    return await query<LocationRow>(
      `select address, city, external_id from sales.company_location
        where company_id = $1 order by id`,
      [companyId],
    );
  } catch {
    return [];
  }
}

export interface TimelineRow {
  id: number;
  at: Date;
  actor: string;
  type: string;
  summary: string;
  data: Record<string, unknown>;
}

export async function getTimeline(leadId: number): Promise<TimelineRow[]> {
  if (!isConfigured()) return [];
  try {
    return await query<TimelineRow>(
      `select id, at, actor, type, summary, data from sales.activity
        where lead_id = $1 order by at desc limit 100`,
      [leadId],
    );
  } catch {
    return [];
  }
}

export interface AgentRunRow {
  id: number;
  agent_name: string;
  stage: string;
  trigger: string;
  started_at: Date;
  ended_at: Date | null;
  status: string;
  stats: Record<string, unknown>;
  error: string | null;
}

/** What the agents have actually done, run by run. */
export async function recentRuns(limit = 20): Promise<AgentRunRow[]> {
  if (!isConfigured()) return [];
  try {
    return await query<AgentRunRow>(
      `select r.id, a.name as agent_name, r.stage, r.trigger, r.started_at,
              r.ended_at, r.status, r.stats, r.error
         from sales.agent_run r join sales.agent a on a.id = r.agent_id
        order by r.started_at desc limit $1`,
      [limit],
    );
  } catch {
    return [];
  }
}

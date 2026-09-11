import { one, query, tx } from "../db/client";
import { resolveAgentConfig } from "../config/agents";
import { log } from "../db/repo/activity";
import { record } from "../cost/meter";
import { slugify } from "../../prospect";
import { disclosureFor, writeDemoScript, type DemoScript } from "./script";
import { renderScript, ttsAvailable, ttsCostUsd } from "./render";

/**
 * Build personalised demos for qualified leads.
 *
 * Two artefacts per prospect, and they do different jobs:
 *
 *   the **recording** is the hook — it goes in the email, plays on the landing
 *   page, and proves in forty seconds what a paragraph cannot;
 *
 *   the **live line** is the conversion — the owner rings it, pretends to be
 *   their own patient, and finds out the thing actually works.
 *
 * Only the recording is built here. The live demo already exists in
 * `src/lib/prospect.ts` and is wired separately, because it configures a whole
 * venue rather than a script.
 */

const DEMO_TTL_DAYS = 14;

/** How the vertical refers to its customers, for the script's vocabulary. */
const CUSTOMER_WORD: Record<string, string> = {
  dentists: "patient",
  clinics: "patient",
  salons: "client",
  restaurants: "guest",
};

export interface DemoRunResult {
  built: number;
  skipped: { company: string; reason: string }[];
  rejected: { company: string; problems: string[] }[];
  llmCostUsd: number;
  ttsCostUsd: number;
  demos: { company: string; leadId: number; slug: string; seconds: number; scenario: string }[];
}

export async function buildDemos(options: {
  agentId: number;
  limit?: number;
  actor?: string;
  /** Rebuild even where a live demo already exists. */
  force?: boolean;
}): Promise<DemoRunResult> {
  const { agent, config } = await resolveAgentConfig(options.agentId);
  const actor = options.actor ?? `agent:${agent.id}`;

  if (!ttsAvailable()) {
    throw new Error("ELEVENLABS_API_KEY is not set — demo audio cannot be rendered.");
  }

  // Qualified leads that have been researched (the script needs grounding) and
  // do not already have a demo.
  const candidates = await query<{
    lead_id: number;
    company_id: number;
    name: string;
    city: string | null;
    vertical_slug: string | null;
    summary: string;
    signals: Record<string, unknown>;
    evidence: { claim: string; url: string; quote: string }[];
    use_cases: string[];
  }>(
    `select l.id as lead_id, c.id as company_id, c.name, c.city, c.vertical_slug,
            r.summary, r.signals, r.evidence, r.use_cases
       from sales.lead l
       join sales.company c on c.id = l.company_id
       join lateral (
         select summary, signals, evidence, use_cases from sales.research_record rr
          where rr.company_id = c.id order by rr.created_at desc limit 1
       ) r on true
      where l.agent_id = $1
        and l.stage in ('qualified','contacted','follow_up','replied','interested')
        and ($3 or not exists (
              select 1 from sales.demo d
               where d.lead_id = l.id and d.expires_at > now()))
      order by l.current_score desc nulls last
      limit $2`,
    [agent.id, options.limit ?? 5, options.force ?? false],
  );

  const result: DemoRunResult = {
    built: 0,
    skipped: [],
    rejected: [],
    llmCostUsd: 0,
    ttsCostUsd: 0,
    demos: [],
  };

  for (const candidate of candidates) {
    try {
      // Only what the research actually established. The quotes matter more
      // than the summary: they are the business's own words, which is what
      // keeps the script sounding like their front desk rather than ours.
      const grounding = [
        candidate.summary,
        "",
        "Established facts:",
        ...Object.entries(candidate.signals)
          .filter(([, v]) => v !== null)
          .map(([k, v]) => `  ${k.replace(/_/g, " ")}: ${Array.isArray(v) ? v.join(", ") : v}`),
        "",
        "From their own pages:",
        ...candidate.evidence.map((e) => `  "${e.quote}"`),
      ].join("\n");

      const written = await writeDemoScript({
        agentId: agent.id,
        leadId: candidate.lead_id,
        companyName: candidate.name,
        city: candidate.city,
        vertical: candidate.vertical_slug,
        grounding,
        customerWord: CUSTOMER_WORD[candidate.vertical_slug ?? ""] ?? "customer",
      });
      result.llmCostUsd += written.costUsd;

      if (written.problems.length > 0) {
        // Never published, never rendered. A failed guard costs one model call;
        // a bad recording in a business owner's inbox costs the relationship.
        result.rejected.push({ company: candidate.name, problems: written.problems });
        await log({
          leadId: candidate.lead_id,
          companyId: candidate.company_id,
          agentId: agent.id,
          actor,
          type: "error",
          summary: `Demo script rejected for ${candidate.name}`,
          // The turns, not just the verdict. A guard that rejects without
          // showing what it rejected is impossible to tune, and the usual
          // cause of a rejection is the guard being wrong rather than the
          // script being bad.
          data: {
            problems: written.problems,
            scenario: written.script.scenario,
            turns: written.script.turns,
          },
        });
        continue;
      }

      const disclosure = disclosureFor(candidate.name);
      const rendered = await renderScript(written.script, disclosure);
      const audioCost = ttsCostUsd(rendered.charactersBilled);
      result.ttsCostUsd += audioCost;

      if (audioCost > 0) {
        await record({
          agentId: agent.id,
          leadId: candidate.lead_id,
          category: "voice",
          provider: "elevenlabs",
          units: rendered.charactersBilled,
          unitLabel: "characters",
          amountUsd: audioCost,
        });
      }

      const slug = `${slugify(candidate.name)}-${candidate.lead_id}`;
      const expiresAt = new Date(Date.now() + DEMO_TTL_DAYS * 86_400_000);

      await tx(async (c) => {
        // Supersede rather than duplicate. A recording is immutable, so a
        // rebuild issues a new one — but only one may be live for a lead, or
        // the same prospect has two different demos behind one slug and which
        // they hear depends on row order.
        //
        // The old row is expired, not deleted: it is still the record of what
        // was said in this business's name, and its clips are content-addressed
        // so a re-render of an unchanged line reuses the same file anyway.
        await c.query(
          `update sales.demo set expires_at = now()
            where lead_id = $1 and expires_at > now()`,
          [candidate.lead_id],
        );

        await c.query(
          `insert into sales.demo
             (lead_id, kind, location_slug, script_hint, expires_at, call_ids,
              script, scenario, seconds)
           values ($1, 'recording', $2, $3, $4, $5, $6, $7, $8)`,
          [
            candidate.lead_id,
            slug,
            written.script.try_this,
            expiresAt,
            // The clip ids, in order. Stored here rather than in a separate
            // table: a recording is one immutable artefact, not a collection.
            rendered.clips.map((cl) => `${cl.role}:${cl.id}`),
            // The transcript, so the page can show the words beside the audio
            // and so "what did we say in their name" is answerable later.
            JSON.stringify({
              turns: written.script.turns,
              disclosure,
              clips: rendered.clips.map((cl) => ({ id: cl.id, role: cl.role, text: cl.text })),
            }),
            written.script.scenario,
            written.estimatedSeconds,
          ],
        );

        await log({
          client: c,
          leadId: candidate.lead_id,
          companyId: candidate.company_id,
          agentId: agent.id,
          actor,
          type: "demo_issued",
          summary: written.script.scenario,
          data: {
            slug,
            seconds: written.estimatedSeconds,
            clips: rendered.clips.length,
            newClips: rendered.madeCount,
            llmCostUsd: written.costUsd,
            ttsCostUsd: audioCost,
          },
        });
      });

      result.built++;
      result.demos.push({
        company: candidate.name,
        leadId: candidate.lead_id,
        slug,
        seconds: written.estimatedSeconds,
        scenario: written.script.scenario,
      });
    } catch (err) {
      result.skipped.push({ company: candidate.name, reason: (err as Error).message });
      await log({
        leadId: candidate.lead_id,
        companyId: candidate.company_id,
        agentId: agent.id,
        actor,
        type: "error",
        summary: `Demo build failed for ${candidate.name}`,
        data: { error: (err as Error).message },
      });
    }
  }

  return result;
}

export interface StoredDemo {
  id: number;
  lead_id: number;
  company_name: string;
  city: string | null;
  vertical_slug: string | null;
  script_hint: string;
  expires_at: Date;
  first_used_at: Date | null;
  use_count: number;
  call_ids: string[];
}

/** A demo by its public slug, if it has not expired. */
export async function findDemoBySlug(slug: string): Promise<StoredDemo | undefined> {
  const rows = await query<StoredDemo>(
    `select d.id, d.lead_id, c.name as company_name, c.city, c.vertical_slug,
            d.script_hint, d.expires_at, d.first_used_at, d.use_count, d.call_ids
       from sales.demo d
       join sales.lead l on l.id = d.lead_id
       join sales.company c on c.id = l.company_id
      where d.location_slug = $1 and d.expires_at > now()
      order by d.issued_at desc limit 1`,
    [slug],
  );
  return rows[0];
}

/**
 * Record that a prospect played the recording.
 *
 * The strongest behavioural signal in the funnel before a reply: someone who
 * listened is orders of magnitude warmer than someone who opened. First play
 * is logged separately from repeat plays, because "they listened" and "they
 * listened four times" are different facts.
 */
export async function recordDemoPlay(demoId: number, seconds: number): Promise<void> {
  const row = await one<{ lead_id: number; first: boolean }>(
    `update sales.demo
        set use_count = use_count + 1,
            total_seconds = total_seconds + $2,
            first_used_at = coalesce(first_used_at, now())
      where id = $1
      returning lead_id, (use_count = 1) as first`,
    [demoId, Math.max(0, Math.round(seconds))],
  );
  if (!row) return;

  await query(
    `insert into sales.activity (lead_id, actor, type, summary, data)
     select $1, 'system', 'demo_used', $2, $3
      where not exists (
        select 1 from sales.activity
         where lead_id = $1 and type = 'demo_used' and at > now() - interval '1 hour')`,
    [
      row.lead_id,
      row.first ? "Played their demo for the first time" : "Played their demo again",
      JSON.stringify({ seconds, first: row.first }),
    ],
  );
}

export type { DemoScript };

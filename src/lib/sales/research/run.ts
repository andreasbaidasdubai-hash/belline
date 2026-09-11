import { one, query, tx } from "../db/client";
import { resolveAgentConfig } from "../config/agents";
import { log } from "../db/repo/activity";
import { setStage } from "../db/repo/lead";
import { crawlSite } from "./crawl";
import { researchCompany } from "./agent";

/**
 * Research a batch of leads.
 *
 * Sequential rather than parallel on purpose: each company costs a model call
 * and up to six HTTP fetches, and the first runs exist to be *read* by a
 * person. Ten at a time, watched, beats a hundred at once unwatched — the
 * failure this stage has is producing plausible nonsense, and only a human
 * reading the output catches that.
 */

export interface ResearchRunResult {
  runId: number;
  attempted: number;
  researched: number;
  failed: { company: string; reason: string }[];
  unreadable: { company: string; reason: string }[];
  droppedEvidence: number;
  costUsd: number;
}

export interface ResearchRunOptions {
  agentId: number;
  limit?: number;
  actor?: string;
  /** Re-research companies that already have a record. */
  force?: boolean;
}

interface Candidate {
  lead_id: number;
  company_id: number;
  name: string;
  website: string | null;
  city: string | null;
  vertical_slug: string | null;
  rating: number | null;
  review_count: number | null;
  branches: number;
}

export async function researchLeads(options: ResearchRunOptions): Promise<ResearchRunResult> {
  const { agent, config } = await resolveAgentConfig(options.agentId);
  const limit = options.limit ?? 10;
  const actor = options.actor ?? `agent:${agent.id}`;

  // Leads at `discovered`, with a website, that nobody has researched yet.
  // Ordered by review count: the busiest practices are both the best
  // prospects and the most informative to read first.
  const candidates = await query<Candidate>(
    `select l.id as lead_id, c.id as company_id, c.name, c.website, c.city,
            c.vertical_slug, c.rating, c.review_count,
            (select count(*)::int from sales.company_location cl where cl.company_id = c.id) as branches
       from sales.lead l
       join sales.company c on c.id = l.company_id
      where l.agent_id = $1
        and l.stage = 'discovered'
        and c.website is not null
        and ($3 or not exists (
              select 1 from sales.research_record r where r.company_id = c.id))
      order by c.review_count desc nulls last
      limit $2`,
    [agent.id, limit, options.force ?? false],
  );

  const run = await one<{ id: number }>(
    `insert into sales.agent_run (agent_id, stage, trigger, stats)
     values ($1, 'research', $2, $3) returning id`,
    [
      agent.id,
      options.actor?.startsWith("user:") ? "manual" : "schedule",
      JSON.stringify({ limit, candidates: candidates.length }),
    ],
  );
  const runId = run!.id;

  const result: ResearchRunResult = {
    runId,
    attempted: candidates.length,
    researched: 0,
    failed: [],
    unreadable: [],
    droppedEvidence: 0,
    costUsd: 0,
  };

  for (const candidate of candidates) {
    try {
      const crawl = await crawlSite(candidate.website!);

      if (crawl.failure || crawl.pages.length === 0) {
        // A site behind a bot-blocker is an ordinary outcome, not a failure of
        // the pipeline. The lead keeps its place and can be researched from
        // another source later; what it must never do is get researched from
        // nothing and acquire invented facts.
        result.unreadable.push({
          company: candidate.name,
          reason: crawl.failure ?? "no readable pages",
        });
        await log({
          leadId: candidate.lead_id,
          companyId: candidate.company_id,
          agentId: agent.id,
          actor,
          type: "error",
          summary: `Could not read ${candidate.name}'s website`,
          data: { website: candidate.website, reason: crawl.failure },
        });
        continue;
      }

      const output = await researchCompany({
        agentId: agent.id,
        leadId: candidate.lead_id,
        companyName: candidate.name,
        city: candidate.city,
        vertical: candidate.vertical_slug,
        crawl,
        allowedServices: config.belline_services,
        researchPrompt: config.research_prompt,
        known: {
          rating: candidate.rating,
          reviewCount: candidate.review_count,
          branches: candidate.branches,
        },
      });

      result.costUsd += output.costUsd;
      result.droppedEvidence += output.droppedEvidence.length;

      await tx(async (c) => {
        await c.query(
          `insert into sales.research_record
             (company_id, agent_id, summary, signals, use_cases, evidence,
              pages_read, model, prompt_hash, cost_usd)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            candidate.company_id,
            agent.id,
            output.research.summary,
            JSON.stringify(output.research.signals),
            output.research.use_cases,
            JSON.stringify(output.research.evidence),
            crawl.fetched,
            output.model,
            output.promptHash,
            output.costUsd,
          ],
        );

        await log({
          client: c,
          leadId: candidate.lead_id,
          companyId: candidate.company_id,
          agentId: agent.id,
          actor,
          type: "researched",
          summary: output.research.summary.split(". ")[0].slice(0, 200),
          data: {
            pages: crawl.fetched.length,
            useCases: output.research.use_cases,
            droppedEvidence: output.droppedEvidence.length,
            costUsd: output.costUsd,
          },
        });

        await setStage(c, {
          leadId: candidate.lead_id,
          stage: "researching",
          actor,
          reason: `Researched from ${crawl.fetched.length} pages`,
        });
      });

      result.researched++;
    } catch (err) {
      result.failed.push({ company: candidate.name, reason: (err as Error).message });
      await log({
        leadId: candidate.lead_id,
        companyId: candidate.company_id,
        agentId: agent.id,
        actor,
        type: "error",
        summary: `Research failed for ${candidate.name}`,
        data: { error: (err as Error).message },
      });
    }
  }

  await query(
    `update sales.agent_run
        set ended_at = now(), status = $2, stats = stats || $3::jsonb
      where id = $1`,
    [
      runId,
      result.failed.length > 0 && result.researched === 0 ? "failed" : "done",
      JSON.stringify({
        researched: result.researched,
        unreadable: result.unreadable.length,
        failed: result.failed.length,
        droppedEvidence: result.droppedEvidence,
        costUsd: Math.round(result.costUsd * 1e6) / 1e6,
      }),
    ],
  );

  return result;
}

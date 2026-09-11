import { query, tx } from "../db/client";
import { resolveAgentConfig } from "../config/agents";
import { setScore, setStage } from "../db/repo/lead";
import { log } from "../db/repo/activity";
import { scoreLead, type ScoreResult } from "./model";

/**
 * Score every researched lead for an agent.
 *
 * Costs nothing and touches no external service, so it is safe to re-run after
 * any weight change — which is the whole reason scoring is deterministic. The
 * expensive part (deciding what a website says) already happened.
 */

export interface ScoringRunResult {
  scored: number;
  skipped: number;
  qualified: number;
  results: { company: string; leadId: number; score: ScoreResult }[];
}

export async function scoreLeads(options: {
  agentId: number;
  actor?: string;
  limit?: number;
}): Promise<ScoringRunResult> {
  const { agent, config } = await resolveAgentConfig(options.agentId);
  const actor = options.actor ?? `agent:${agent.id}`;

  const rows = await query<{
    lead_id: number;
    company_id: number;
    name: string;
    city: string | null;
    status: string;
    phone_e164: string | null;
    domain: string | null;
    rating: number | null;
    review_count: number | null;
    branches: number;
    signals: Record<string, unknown> | null;
    demo_used: boolean;
  }>(
    `select l.id as lead_id, c.id as company_id, c.name, c.city, c.status,
            c.phone_e164, c.domain, c.rating, c.review_count,
            (select count(*)::int from sales.company_location cl
              where cl.company_id = c.id) as branches,
            r.signals,
            exists (select 1 from sales.demo d
                     where d.lead_id = l.id and d.first_used_at is not null) as demo_used
       from sales.lead l
       join sales.company c on c.id = l.company_id
       left join lateral (
         select signals from sales.research_record rr
          where rr.company_id = c.id order by rr.created_at desc limit 1
       ) r on true
      where l.agent_id = $1
        and l.stage in ('discovered','researching','qualified')
      order by c.review_count desc nulls last
      limit $2`,
    [agent.id, options.limit ?? 500],
  );

  const result: ScoringRunResult = { scored: 0, skipped: 0, qualified: 0, results: [] };

  for (const row of rows) {
    // An unresearched company has no signals to score. Scoring it anyway would
    // produce a low number that looks like a judgement rather than an absence,
    // and it would then sort below genuinely poor prospects that *were* read.
    if (!row.signals) {
      result.skipped++;
      continue;
    }

    const score = scoreLead({
      signals: row.signals,
      company: {
        reviewCount: row.review_count,
        rating: row.rating,
        branches: row.branches,
        hasPhone: Boolean(row.phone_e164),
        hasWebsite: Boolean(row.domain),
        status: row.status,
        city: row.city,
      },
      regions: config.regions,
      demoUsed: row.demo_used,
      scoring: config.scoring,
    });

    const qualifies = score.score >= config.qualification_rules.min_score_to_contact;

    await tx(async (c) => {
      await setScore(c, {
        leadId: row.lead_id,
        score: score.score,
        priority: score.priority,
        breakdown: score.breakdown,
        reason: score.reason,
        modelVersion: score.modelVersion,
      });

      await log({
        client: c,
        leadId: row.lead_id,
        companyId: row.company_id,
        agentId: agent.id,
        actor,
        type: "scored",
        summary: score.reason,
        data: {
          score: score.score,
          priority: score.priority,
          qualifies,
          modelVersion: score.modelVersion,
        },
      });

      // `qualified` means "cleared the bar to be contacted", which is a
      // different claim from "we have read their website". Only the former
      // moves the lead on.
      if (qualifies) {
        await setStage(c, {
          leadId: row.lead_id,
          stage: "qualified",
          actor,
          reason: `Scored ${score.score} (${score.priority})`,
        });
      }
    });

    result.scored++;
    if (qualifies) result.qualified++;
    result.results.push({ company: row.name, leadId: row.lead_id, score });
  }

  result.results.sort((a, b) => b.score.score - a.score.score);
  return result;
}

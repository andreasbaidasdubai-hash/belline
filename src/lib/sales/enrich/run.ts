import { query } from "../db/client";
import { log } from "../db/repo/activity";
import { isSuppressed } from "../compliance/suppression";
import { findCompanyEmail } from "./email";

/**
 * Fill in what discovery could not reach.
 *
 * Runs before research on purpose: research is the expensive stage, and a
 * company nobody can be written to is not worth spending a model call on. The
 * ordering is the cheap filter in front of the costly one.
 *
 * Costs nothing but HTTP requests — no model, no paid provider.
 */

export interface EnrichRunResult {
  attempted: number;
  found: number;
  notFound: { company: string }[];
  suppressed: { company: string; email: string; reason: string }[];
}

export async function enrichEmails(options: {
  agentId: number;
  limit?: number;
  actor?: string;
}): Promise<EnrichRunResult> {
  const actor = options.actor ?? `agent:${options.agentId}`;

  const candidates = await query<{
    lead_id: number;
    company_id: number;
    name: string;
    website: string;
    domain: string | null;
  }>(
    `select l.id as lead_id, c.id as company_id, c.name, c.website, c.domain
       from sales.lead l
       join sales.company c on c.id = l.company_id
      where l.agent_id = $1
        and c.website is not null
        and c.email is null
        and c.status = 'active'
      order by c.review_count desc nulls last
      limit $2`,
    [options.agentId, options.limit ?? 25],
  );

  const result: EnrichRunResult = {
    attempted: candidates.length,
    found: 0,
    notFound: [],
    suppressed: [],
  };

  for (const candidate of candidates) {
    const found = await findCompanyEmail(candidate.website, candidate.domain);

    if (!found) {
      result.notFound.push({ company: candidate.name });
      continue;
    }

    // A company that has already opted out must not have its address written
    // back into our database — that is re-acquiring data somebody asked us to
    // stop holding against them.
    const suppression = await isSuppressed({ email: found.email, companyId: candidate.company_id });
    if (suppression) {
      result.suppressed.push({
        company: candidate.name,
        email: found.email,
        reason: suppression,
      });
      continue;
    }

    await query(`update sales.company set email = $2, updated_at = now() where id = $1`, [
      candidate.company_id,
      found.email,
    ]);

    await log({
      leadId: candidate.lead_id,
      companyId: candidate.company_id,
      agentId: options.agentId,
      actor,
      type: "researched",
      summary: `Found ${found.email} on their contact page`,
      data: {
        email: found.email,
        confidence: found.confidence,
        sourceUrl: found.sourceUrl,
      },
    });

    result.found++;
  }

  return result;
}

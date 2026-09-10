import { tx } from "../db/client";
import * as companies from "../db/repo/company";
import * as leads from "../db/repo/lead";
import { log } from "../db/repo/activity";
import type { ImportPlan } from "./csv";

/**
 * Execute an import plan.
 *
 * The plan (`planImport`) touches nothing; this writes. Splitting them is what
 * lets the import screen say "48 companies, 2 skipped, 3 duplicated in the
 * file" *before* anything is committed, and it means the dedup logic can be
 * tested exhaustively without a database — see `npm run check:import`.
 *
 * One transaction for the whole file. A half-imported spreadsheet is worse
 * than a failed one: you cannot tell by looking which rows landed, and
 * re-running would be the only way to find out.
 */

export interface ImportOutcome {
  companiesCreated: number;
  companiesMerged: number;
  leadsClaimed: number;
  conflicts: { company: string; heldBy: string; stage: string }[];
  merged: { company: string; on: string }[];
}

export async function executeImport(
  plan: ImportPlan,
  input: { agentId: number; actor: string; sourceSlug?: string; campaignId?: number | null },
): Promise<ImportOutcome> {
  const outcome: ImportOutcome = {
    companiesCreated: 0,
    companiesMerged: 0,
    leadsClaimed: 0,
    conflicts: [],
    merged: [],
  };

  await tx(async (c) => {
    for (const row of plan.companies) {
      const { company, created, mergedOn } = await companies.upsert(c, {
        name: row.name,
        verticalSlug: row.verticalSlug,
        countryCode: row.countryCode,
        city: row.city,
        address: row.address,
        website: row.website,
        phone: row.phone,
        email: row.email,
        companySize: row.companySize,
        locationCount: row.locationCount,
        rating: row.rating,
        reviewCount: row.reviewCount,
        bookingUrl: row.bookingUrl,
        sourceSlug: input.sourceSlug ?? "csv",
        sourceUrl: row.sourceUrl,
      });

      if (created) {
        outcome.companiesCreated++;
        await log({
          client: c,
          companyId: company.id,
          agentId: input.agentId,
          actor: input.actor,
          type: "discovered",
          summary: `Imported ${company.name}`,
          data: { source: input.sourceSlug ?? "csv", row: row.row },
        });
      } else {
        outcome.companiesMerged++;
        outcome.merged.push({ company: company.name, on: mergedOn ?? "unknown" });
        await log({
          client: c,
          companyId: company.id,
          agentId: input.agentId,
          actor: input.actor,
          type: "merged",
          summary: `Already known — matched on ${mergedOn}`,
          data: { matchedOn: mergedOn, row: row.row },
        });
      }

      const claim = await leads.claim(c, {
        companyId: company.id,
        agentId: input.agentId,
        campaignId: input.campaignId ?? null,
      });

      if (claim.ok) {
        if (claim.created) {
          outcome.leadsClaimed++;
          await log({
            client: c,
            leadId: claim.lead.id,
            companyId: company.id,
            agentId: input.agentId,
            actor: input.actor,
            type: "discovered",
            summary: `${company.name} entered the pipeline`,
          });
        }
      } else {
        // Not a failure. Another agent already owns this company, the conflict
        // is on record, and the country manager decides — see AGENTS.md §1.
        outcome.conflicts.push({
          company: company.name,
          heldBy: claim.holder.agentName,
          stage: claim.holder.stage,
        });
      }
    }
  });

  return outcome;
}

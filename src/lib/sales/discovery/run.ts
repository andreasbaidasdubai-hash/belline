import { one, tx } from "../db/client";
import { resolveAgentConfig } from "../config/agents";
import { VERTICALS } from "../config/defaults";
import * as companies from "../db/repo/company";
import * as leads from "../db/repo/lead";
import { log } from "../db/repo/activity";
import { record } from "../cost/meter";
import { assertWithinBudget } from "../cost/budget";
import { normalisePhone } from "./dedup";
import { GooglePlacesProvider } from "./google-places";
import type { LeadSourceProvider, RawCompany } from "./provider";

/**
 * A discovery run.
 *
 * Deliberately the same shape as a CSV import once the rows exist: upsert the
 * company, dedupe, claim the lead, log it. The only thing a connector changes
 * is where the rows came from — which is the entire point of the provider
 * interface.
 *
 * Cost is metered per *result*, not per run, because that is the unit the
 * model is tuned on. Budget is checked before the run with the whole run's
 * estimated cost as headroom, so an agent cannot discover 300 companies it
 * has no money left to research.
 */

const PROVIDERS: Record<string, () => LeadSourceProvider> = {
  google_places: () => new GooglePlacesProvider(),
};

export interface RunResult {
  runId: number;
  found: number;
  companiesCreated: number;
  companiesMerged: number;
  leadsClaimed: number;
  conflicts: { company: string; heldBy: string }[];
  skipped: { company: string; reason: string }[];
  costUsd: number;
  /**
   * What was actually found, for a human to read.
   *
   * The point of a dry run is to see whether "dental clinic in Dubai" returns
   * clinics or dental *suppliers* — a count of ten tells you nothing about
   * that, and getting the search terms wrong poisons every stage downstream.
   */
  sample: RawCompany[];
}

export interface RunOptions {
  agentId: number;
  source: string;
  /** Overrides the agent's `discovery.max_results_per_run`. */
  limit?: number;
  actor?: string;
  /** Resolve and report what *would* run, without calling the provider. */
  dryRun?: boolean;
}

export async function discover(options: RunOptions): Promise<RunResult> {
  const { agent, config } = await resolveAgentConfig(options.agentId);

  const factory = PROVIDERS[options.source];
  if (!factory) {
    throw new Error(
      `Unknown source "${options.source}". Available: ${Object.keys(PROVIDERS).join(", ")}, csv (via the import screen).`,
    );
  }
  const provider = factory();
  if (!provider.available()) throw new Error(provider.unavailableReason()!);

  if (!agent.country_code || !agent.vertical_slug) {
    throw new Error(`"${agent.name}" is not a vertical agent — only those discover companies.`);
  }

  // Search terms come from configuration; the vertical's defaults are the
  // fallback so a newly-created agent finds something before anyone tunes it.
  const searchTerms =
    config.discovery.search_terms.length > 0
      ? config.discovery.search_terms
      : (VERTICALS.find((v) => v.slug === agent.vertical_slug)?.searchTerms ?? []);

  if (searchTerms.length === 0) {
    throw new Error(`"${agent.name}" has no discovery search terms configured.`);
  }

  const limit = options.limit ?? config.discovery.max_results_per_run;
  const actor = options.actor ?? `agent:${agent.id}`;

  await assertWithinBudget(agent.id, limit * provider.costPerResultUsd);

  const run = await one<{ id: number }>(
    `insert into sales.agent_run (agent_id, stage, trigger, stats)
     values ($1, 'discover', $2, $3) returning id`,
    [
      agent.id,
      options.actor?.startsWith("user:") ? "manual" : "schedule",
      JSON.stringify({ source: options.source, limit, searchTerms, regions: config.regions }),
    ],
  );
  const runId = run!.id;

  const result: RunResult = {
    runId,
    found: 0,
    companiesCreated: 0,
    companiesMerged: 0,
    leadsClaimed: 0,
    conflicts: [],
    skipped: [],
    costUsd: 0,
    sample: [],
  };

  try {
    const stream = provider.search({
      countryCode: agent.country_code,
      regions: config.regions,
      verticalSlug: agent.vertical_slug,
      searchTerms,
      limit,
      languageCode: config.default_language,
    });

    for await (const raw of stream) {
      result.found++;
      result.costUsd += provider.costPerResultUsd;
      if (result.sample.length < 25) result.sample.push(raw);

      if (options.dryRun) continue;

      const outcome = await persist(raw, {
        agentId: agent.id,
        runId,
        actor,
        sourceSlug: provider.slug,
        countryCode: agent.country_code,
      });

      if (outcome.skipped) {
        result.skipped.push({ company: raw.name, reason: outcome.skipped });
        continue;
      }
      if (outcome.created) result.companiesCreated++;
      else result.companiesMerged++;
      if (outcome.claimed) result.leadsClaimed++;
      if (outcome.conflict) result.conflicts.push({ company: raw.name, heldBy: outcome.conflict });
    }

    // One cost row per run rather than per result: the charge is per API call
    // and a thousand rows of $0.0035 is noise in the ledger, not detail.
    if (result.costUsd > 0 && !options.dryRun) {
      await record({
        agentId: agent.id,
        runId,
        category: "discovery",
        provider: provider.slug,
        units: result.found,
        unitLabel: "results",
        amountUsd: result.costUsd,
      });
    }

    await finish(runId, "done", result);
    return result;
  } catch (err) {
    await finish(runId, "failed", result, (err as Error).message);
    throw err;
  }
}

interface PersistContext {
  agentId: number;
  runId: number;
  actor: string;
  sourceSlug: string;
  countryCode: string;
}

async function persist(
  raw: RawCompany,
  ctx: PersistContext,
): Promise<{ created?: boolean; claimed?: boolean; conflict?: string; skipped?: string }> {
  // Nothing to reach them by means nothing to research and nothing to contact.
  // Filtering here rather than after research is the difference between a
  // wasted row and a wasted model call.
  if (!raw.website && !raw.phone) {
    return { skipped: "no website or phone" };
  }
  if (raw.status === "closed") return { skipped: "permanently or temporarily closed" };

  return tx(async (c) => {
    const { company, created, mergedOn } = await companies.upsert(c, {
      name: raw.name,
      verticalSlug: raw.verticalSlug,
      countryCode: raw.countryCode ?? ctx.countryCode,
      city: raw.city,
      address: raw.address,
      website: raw.website,
      phone: raw.phone,
      companySize: null,
      rating: raw.rating,
      reviewCount: raw.reviewCount,
      bookingUrl: raw.bookingUrl,
      hasWhatsapp: raw.hasWhatsapp,
      sourceSlug: ctx.sourceSlug,
      sourceUrl: raw.sourceUrl,
    });

    await companies.addLocation(c, company.id, {
      externalId: raw.externalId,
      address: raw.address,
      city: raw.city,
      phoneE164: normalisePhone(raw.phone, raw.countryCode ?? ctx.countryCode),
      lat: raw.lat,
      lng: raw.lng,
      openingHours: raw.openingHours,
    });

    await log({
      client: c,
      companyId: company.id,
      agentId: ctx.agentId,
      actor: ctx.actor,
      type: created ? "discovered" : "merged",
      summary: created
        ? `Found ${company.name}${raw.city ? ` in ${raw.city}` : ""}`
        : `Already known — matched on ${mergedOn}`,
      data: { source: ctx.sourceSlug, externalId: raw.externalId, rating: raw.rating },
    });

    const claim = await leads.claim(c, { companyId: company.id, agentId: ctx.agentId });
    if (!claim.ok) return { created, conflict: claim.holder.agentName };

    if (claim.created) {
      await log({
        client: c,
        leadId: claim.lead.id,
        companyId: company.id,
        agentId: ctx.agentId,
        actor: ctx.actor,
        type: "discovered",
        summary: `${company.name} entered the pipeline`,
      });
    }
    return { created, claimed: claim.created };
  });
}

async function finish(
  runId: number,
  status: "done" | "failed",
  result: RunResult,
  error?: string,
): Promise<void> {
  await one(
    `update sales.agent_run
        set ended_at = now(), status = $2, error = $3,
            stats = stats || $4::jsonb
      where id = $1 returning id`,
    [
      runId,
      status,
      error ?? null,
      JSON.stringify({
        found: result.found,
        created: result.companiesCreated,
        merged: result.companiesMerged,
        claimed: result.leadsClaimed,
        conflicts: result.conflicts.length,
        skipped: result.skipped.length,
        costUsd: Math.round(result.costUsd * 1e6) / 1e6,
      }),
    ],
  );
}

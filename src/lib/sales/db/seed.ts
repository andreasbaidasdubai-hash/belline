import { one, query, tx } from "./client";
import {
  COUNTRIES,
  FIRST_AGENT_CONFIG,
  LAUNCH_CHECKLIST,
  SEQUENCES,
  SERVICES,
  VERTICALS,
} from "../config/defaults";
import type { PartialAgentConfig } from "../config/schema";

/**
 * Seed.
 *
 * Idempotent by construction — every statement is an upsert keyed on a natural
 * key, so running it against a live database updates the reference data and
 * leaves agents, leads and history alone. It is meant to be run again after
 * every deploy that changes a country profile or adds a service.
 *
 * The one thing it will not do is overwrite an agent's `config` once that agent
 * exists. Reference data is ours; an agent's configuration belongs to whoever
 * has been tuning it in the dashboard.
 */

export interface SeedResult {
  countries: number;
  regions: number;
  verticals: number;
  services: number;
  sequences: number;
  agentsCreated: string[];
}

export async function seed(): Promise<SeedResult> {
  const agentsCreated: string[] = [];
  let regions = 0;

  await tx(async (c) => {
    for (const country of COUNTRIES) {
      await c.query(
        `insert into sales.country
           (code, name, default_languages, default_timezone, currency, compliance_profile)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (code) do update set
           name = excluded.name,
           default_languages = excluded.default_languages,
           default_timezone = excluded.default_timezone,
           currency = excluded.currency,
           compliance_profile = excluded.compliance_profile`,
        [
          country.code,
          country.name,
          country.default_languages,
          country.default_timezone,
          country.currency,
          JSON.stringify(country.compliance_profile),
        ],
      );
      for (const region of country.regions) {
        const r = await c.query(
          `insert into sales.region (country_code, name) values ($1, $2)
           on conflict (country_code, name) do nothing`,
          [country.code, region],
        );
        regions += r.rowCount ?? 0;
      }
    }

    for (const v of VERTICALS) {
      await c.query(
        `insert into sales.vertical (slug, name, parent_slug, terms, default_icp)
         values ($1, $2, $3, $4, $5)
         on conflict (slug) do update set
           name = excluded.name,
           terms = excluded.terms,
           default_icp = excluded.default_icp`,
        [v.slug, v.name, v.parent_slug ?? null, JSON.stringify(v.terms), JSON.stringify(v.default_icp)],
      );
    }

    for (const s of SERVICES) {
      await c.query(
        `insert into sales.service (slug, name, description, verticals, proof)
         values ($1, $2, $3, $4, $5)
         on conflict (slug) do update set
           name = excluded.name,
           description = excluded.description,
           verticals = excluded.verticals,
           proof = excluded.proof`,
        [s.slug, s.name, s.description, s.verticals, JSON.stringify(s.proof)],
      );
    }

    for (const s of SEQUENCES) {
      await c.query(
        `insert into sales.sequence (key, name, scope, steps)
         values ($1, $2, $3, $4)
         on conflict (key) do update set
           name = excluded.name, scope = excluded.scope, steps = excluded.steps`,
        [s.key, s.name, JSON.stringify(s.scope), JSON.stringify(s.steps)],
      );
    }
  });

  // --- the hierarchy ------------------------------------------------------
  //
  // Created outside the transaction above because each level needs the id of
  // the one above it, and because a partially-seeded hierarchy is recoverable
  // by running seed again.

  const director = await upsertAgent({
    kind: "director",
    name: "Belline Sales Director",
    parentId: null,
    countryCode: null,
    verticalSlug: null,
    regions: [],
    languages: ["en", "ar", "de", "fr"],
    // The Director holds the global posture. Anything set here that is a
    // `strictest` field cannot be loosened further down.
    config: {
      belline_services: SERVICES.map((s) => s.slug),
      compliance: {
        min_days_between_touches: 2,
        company_touch_cap_90d: 6,
      },
    },
    dailyBudget: 60,
    monthlyBudget: 1200,
    onCreate: (name) => agentsCreated.push(name),
  });

  const managers = new Map<string, number>();
  for (const country of COUNTRIES) {
    const manager = await upsertAgent({
      kind: "country_manager",
      name: `${country.name} Manager`,
      parentId: director,
      countryCode: country.code,
      verticalSlug: null,
      regions: country.regions,
      languages: country.default_languages,
      config: {
        default_language: country.default_languages[0],
        compliance: country.compliance_profile,
        outreach_strategy: {
          channels: country.channels,
          send_window: country.send_window,
        },
      },
      dailyBudget: 20,
      monthlyBudget: 400,
      onCreate: (name) => agentsCreated.push(name),
    });
    managers.set(country.code, manager);
  }

  // Phase 1's first and only vertical agent. Created as `draft`: the launch
  // checklist in COMPLIANCE.md §5 has to pass before it may send anything.
  const uae = managers.get("AE");
  if (uae) {
    await upsertAgent({
      kind: "vertical_agent",
      name: "UAE Dental Agent",
      parentId: uae,
      countryCode: "AE",
      verticalSlug: "dentists",
      regions: FIRST_AGENT_CONFIG.regions ?? [],
      languages: FIRST_AGENT_CONFIG.languages ?? ["en"],
      config: FIRST_AGENT_CONFIG,
      dailyBudget: FIRST_AGENT_CONFIG.budget?.daily_usd ?? 12,
      monthlyBudget: FIRST_AGENT_CONFIG.budget?.monthly_usd ?? 250,
      launchChecklist: LAUNCH_CHECKLIST,
      onCreate: (name) => agentsCreated.push(name),
    });
  }

  const counts = await one<{ countries: number; verticals: number; services: number; sequences: number }>(
    `select
       (select count(*) from sales.country)  as countries,
       (select count(*) from sales.vertical) as verticals,
       (select count(*) from sales.service)  as services,
       (select count(*) from sales.sequence) as sequences`,
  );

  return {
    countries: Number(counts?.countries ?? 0),
    regions,
    verticals: Number(counts?.verticals ?? 0),
    services: Number(counts?.services ?? 0),
    sequences: Number(counts?.sequences ?? 0),
    agentsCreated,
  };
}

/**
 * Push the configs in `defaults.ts` onto the agents that already exist.
 *
 * `seed` deliberately never touches an existing agent's config — an
 * afternoon of tuning in the dashboard must not be reverted by a redeploy.
 * But during development the defaults *are* the source of truth and there has
 * to be a way to apply a change to them, so this is that way: explicit,
 * separate, and audited.
 *
 * Every change writes a new `agent_config_version` row, so the previous
 * configuration is recoverable and "what were the rules when this lead was
 * scored?" stays answerable.
 */
export async function reconfigure(): Promise<{ name: string; version: number }[]> {
  const updated: { name: string; version: number }[] = [];

  const targets: { name: string; config: PartialAgentConfig }[] = [
    {
      name: "Belline Sales Director",
      config: {
        belline_services: SERVICES.map((s) => s.slug),
        compliance: { min_days_between_touches: 2, company_touch_cap_90d: 6 },
      },
    },
    ...COUNTRIES.map((country) => ({
      name: `${country.name} Manager`,
      config: {
        default_language: country.default_languages[0],
        compliance: country.compliance_profile,
        outreach_strategy: {
          channels: country.channels,
          send_window: country.send_window,
        },
      } as PartialAgentConfig,
    })),
    { name: "UAE Dental Agent", config: FIRST_AGENT_CONFIG },
  ];

  for (const target of targets) {
    const agent = await one<{ id: number; config: unknown }>(
      `select id, config from sales.agent where name = $1`,
      [target.name],
    );
    if (!agent) continue;

    const next = JSON.stringify(target.config);
    if (JSON.stringify(agent.config) === next) continue;

    const version = await one<{ v: number }>(
      `select coalesce(max(version), 0) + 1 as v
         from sales.agent_config_version where agent_id = $1`,
      [agent.id],
    );

    await query(
      `insert into sales.agent_config_version (agent_id, version, config, changed_by, note)
       values ($1, $2, $3, 'system', 'reconfigure from defaults.ts')`,
      [agent.id, version!.v, next],
    );
    await query(`update sales.agent set config = $2, updated_at = now() where id = $1`, [
      agent.id,
      next,
    ]);
    await query(
      `insert into sales.audit_log (actor, action, entity, entity_id, before, after)
       values ('system', 'reconfigure', 'agent', $1, $2, $3)`,
      [String(agent.id), JSON.stringify(agent.config), next],
    );

    updated.push({ name: target.name, version: version!.v });
  }

  return updated;
}

interface UpsertAgent {
  kind: "director" | "country_manager" | "vertical_agent";
  name: string;
  parentId: number | null;
  countryCode: string | null;
  verticalSlug: string | null;
  regions: string[];
  languages: string[];
  config: PartialAgentConfig;
  dailyBudget: number;
  monthlyBudget: number;
  launchChecklist?: Record<string, boolean>;
  onCreate: (name: string) => void;
}

/**
 * Create the agent if it does not exist; otherwise leave its configuration
 * completely alone and return its id. Re-seeding must never quietly revert an
 * afternoon of tuning in the dashboard.
 */
async function upsertAgent(input: UpsertAgent): Promise<number> {
  const existing = await one<{ id: number }>(`select id from sales.agent where name = $1`, [
    input.name,
  ]);
  if (existing) return existing.id;

  const row = await one<{ id: number }>(
    `insert into sales.agent
       (kind, parent_id, name, country_code, vertical_slug, regions, languages,
        status, autonomy_mode, config, daily_budget, monthly_budget, launch_checklist)
     values ($1,$2,$3,$4,$5,$6,$7,'draft','review',$8,$9,$10,$11)
     returning id`,
    [
      input.kind,
      input.parentId,
      input.name,
      input.countryCode,
      input.verticalSlug,
      input.regions,
      input.languages,
      JSON.stringify(input.config),
      input.dailyBudget,
      input.monthlyBudget,
      JSON.stringify(input.launchChecklist ?? {}),
    ],
  );
  if (!row) throw new Error(`Failed to create agent "${input.name}".`);

  await query(
    `insert into sales.agent_config_version (agent_id, version, config, changed_by, note)
     values ($1, 1, $2, 'system', 'seed')`,
    [row.id, JSON.stringify(input.config)],
  );
  input.onCreate(input.name);
  return row.id;
}

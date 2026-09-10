import { query } from "../db/client";
import {
  MERGE_MODES,
  OUTREACH_KEY_MODES,
  PartialAgentConfig,
  ResolvedAgentConfig,
  STRICTEST_DIRECTION,
  type Compliance,
  type MergeMode,
} from "./schema";
import { DEFAULT_CONFIG } from "./defaults";

/**
 * Configuration inheritance: Sales Director → Country Manager → Vertical Agent.
 *
 * The whole point of the hierarchy is that compliance and spend flow *downward
 * and cannot be reversed*. A Switzerland Manager that removes WhatsApp removes
 * it from every Swiss vertical agent permanently; a country budget of $200
 * cannot be spent $150 at a time by four children. There is deliberately no
 * syntax for a child widening what its parent allows — `intersect`,
 * `sum_capped` and `strictest` are one-way by construction, so the restriction
 * is a property of the merge rather than a rule someone has to remember.
 *
 * `mergeChain` is pure and takes no database, because it is the piece most
 * worth testing and the piece a bug would be most invisible in.
 */

export interface AgentRow {
  id: number;
  kind: "director" | "country_manager" | "vertical_agent";
  parent_id: number | null;
  name: string;
  country_code: string | null;
  vertical_slug: string | null;
  regions: string[];
  languages: string[];
  status: "draft" | "active" | "paused" | "archived";
  autonomy_mode: "review" | "semi" | "autonomous";
  config: unknown;
  daily_budget: number | null;
  monthly_budget: number | null;
  budget_currency: string;
  launch_checklist: Record<string, boolean>;
  paused_reason: string | null;
}

type AnyRecord = Record<string, unknown>;

const isPlainObject = (v: unknown): v is AnyRecord =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// ---------------------------------------------------------------------------
// Merge primitives
// ---------------------------------------------------------------------------

/** Child may only narrow. An empty parent set means "no restriction stated". */
function intersect(parent: unknown, child: unknown): unknown {
  if (!Array.isArray(child)) return parent;
  if (!Array.isArray(parent) || parent.length === 0) return child;
  const allowed = new Set(parent);
  return child.filter((v) => allowed.has(v));
}

/** Child's number may not exceed the parent's. */
function sumCapped(parent: unknown, child: unknown): unknown {
  if (typeof child !== "number") return parent;
  if (typeof parent !== "number") return child;
  return Math.min(parent, child);
}

/** Deep merge of two plain objects, child winning per key. */
function deepMerge(parent: unknown, child: unknown): unknown {
  if (!isPlainObject(child)) return child === undefined ? parent : child;
  if (!isPlainObject(parent)) return child;
  const out: AnyRecord = { ...parent };
  for (const [key, value] of Object.entries(child)) {
    if (value === undefined) continue;
    out[key] = isPlainObject(value) && isPlainObject(parent[key])
      ? deepMerge(parent[key], value)
      : value;
  }
  return out;
}

/**
 * The more restrictive value wins, whichever level set it.
 *
 * Note this ignores who is the parent: a *Director* cannot loosen a country's
 * consent requirement any more than a vertical agent can. That is intentional
 * — a compliance rule is a fact about a jurisdiction, not a preference held by
 * whoever sits highest in the org chart.
 */
function strictestCompliance(parent: unknown, child: unknown): unknown {
  const a = isPlainObject(parent) ? parent : {};
  const b = isPlainObject(child) ? child : {};
  const out: AnyRecord = { ...a };

  for (const [key, value] of Object.entries(b)) {
    if (value === undefined) continue;
    const existing = out[key];
    if (existing === undefined) {
      out[key] = value;
      continue;
    }
    const direction = STRICTEST_DIRECTION[key as keyof Compliance];
    switch (direction) {
      case "true":
        out[key] = Boolean(existing) || Boolean(value);
        break;
      case "min":
        out[key] = Math.min(Number(existing), Number(value));
        break;
      case "max":
        out[key] = Math.max(Number(existing), Number(value));
        break;
      case "union":
        out[key] = [...new Set([...(existing as string[]), ...(value as string[])])].sort();
        break;
      default:
        out[key] = value;
    }
  }
  return out;
}

function applyMode(mode: MergeMode, parent: unknown, child: unknown): unknown {
  if (child === undefined) return parent;
  switch (mode) {
    case "intersect":
      return intersect(parent, child);
    case "sum_capped":
      return sumCapped(parent, child);
    case "deep":
      return deepMerge(parent, child);
    case "strictest":
      return strictestCompliance(parent, child);
    case "override":
    default:
      return child;
  }
}

/** `budget` is `sum_capped`, but it is an object of numbers rather than one. */
function mergeBudget(parent: unknown, child: unknown): unknown {
  const a = isPlainObject(parent) ? parent : {};
  const b = isPlainObject(child) ? child : {};
  const out: AnyRecord = { ...a };
  for (const [key, value] of Object.entries(b)) {
    if (value === undefined) continue;
    out[key] = sumCapped(a[key], value);
  }
  return out;
}

/**
 * `outreach_strategy` merges deep, except for the three keys where deep would
 * let a child widen what its parent permits. Without this, one `deep` merge
 * re-opens every channel a country manager closed.
 */
function mergeOutreach(parent: unknown, child: unknown): unknown {
  const a = isPlainObject(parent) ? parent : {};
  const b = isPlainObject(child) ? child : {};
  const out: AnyRecord = { ...a };
  for (const [key, value] of Object.entries(b)) {
    if (value === undefined) continue;
    const mode = OUTREACH_KEY_MODES[key as never] as MergeMode | undefined;
    out[key] = mode
      ? applyMode(mode === "strictest" ? "override" : mode, a[key], value)
      : value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

/**
 * Fill anything the chain left unset from `DEFAULT_CONFIG`.
 *
 * Deliberately applied *after* the chain rather than as its first layer. The
 * merge modes are one-way: `intersect` narrows and `sum_capped` takes a
 * minimum. A default used as a layer therefore becomes a ceiling — a default
 * of `channels: ["email"]` would silently delete the LinkedIn a country
 * manager permits, and a default daily budget of $5 would cap every agent at
 * $5 no matter what anyone configured. Defaults are a floor for what is
 * missing, never a limit on what is present.
 */
function fillDefaults(value: unknown, defaults: unknown): unknown {
  if (value === undefined) return defaults;
  if (!isPlainObject(value) || !isPlainObject(defaults)) return value;
  const out: AnyRecord = { ...value };
  for (const [key, fallback] of Object.entries(defaults)) {
    out[key] = fillDefaults(out[key], fallback);
  }
  return out;
}

/**
 * Merge a chain ordered outermost-first: [director, country, vertical].
 * Pure — no database, no environment. Every interesting property of the
 * hierarchy is a property of this function.
 */
export function mergeChain(chain: PartialAgentConfig[]): PartialAgentConfig {
  let acc: AnyRecord = {};

  for (const layer of chain) {
    for (const [key, value] of Object.entries(layer)) {
      if (value === undefined) continue;
      const field = key as keyof PartialAgentConfig;
      if (field === "budget") {
        acc[key] = mergeBudget(acc[key], value);
      } else if (field === "outreach_strategy") {
        acc[key] = mergeOutreach(acc[key], value);
      } else {
        acc[key] = applyMode(MERGE_MODES[field] ?? "override", acc[key], value);
      }
    }
  }
  return fillDefaults(acc, DEFAULT_CONFIG) as PartialAgentConfig;
}

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly issues: string[],
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Parse one agent's stored config, naming the agent if it is malformed. */
export function parseStoredConfig(raw: unknown, agentName: string): PartialAgentConfig {
  const parsed = PartialAgentConfig.safeParse(raw ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new ConfigError(`Configuration for "${agentName}" is invalid.`, issues);
  }
  return parsed.data;
}

/** Load an agent and every ancestor, ordered director-first. */
export async function loadChain(agentId: number): Promise<AgentRow[]> {
  const rows = await query<AgentRow>(
    `with recursive chain as (
       select * from sales.agent where id = $1
       union all
       select a.* from sales.agent a join chain c on a.id = c.parent_id
     )
     select * from chain`,
    [agentId],
  );
  if (rows.length === 0) throw new Error(`No agent with id ${agentId}.`);

  // The recursive query returns leaf-first; the merge needs director-first.
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered: AgentRow[] = [];
  let cursor: AgentRow | undefined = rows.find((r) => r.id === agentId);
  while (cursor) {
    ordered.unshift(cursor);
    cursor = cursor.parent_id ? byId.get(cursor.parent_id) : undefined;
  }
  return ordered;
}

export interface ResolvedAgent {
  agent: AgentRow;
  chain: AgentRow[];
  config: ResolvedAgentConfig;
}

/**
 * The one function the pipeline calls. Throws rather than degrading: an agent
 * whose resolved configuration is incomplete must not run, because every
 * failure mode downstream of that is silent and expensive.
 */
export async function resolveAgentConfig(agentId: number): Promise<ResolvedAgent> {
  const chain = await loadChain(agentId);
  const agent = chain[chain.length - 1];

  const merged = mergeChain(
    chain.map((row) => parseStoredConfig(row.config, row.name)),
  );

  // Columns win over config JSON for the fields that exist in both: the agent
  // editor writes them as columns, and two sources of truth for "which regions"
  // is a bug waiting for a Tuesday.
  const withColumns: PartialAgentConfig = {
    ...merged,
    regions: agent.regions?.length ? agent.regions : merged.regions,
    languages: agent.languages?.length
      ? (intersect(merged.languages, agent.languages) as string[])
      : merged.languages,
    budget: {
      daily_usd: sumCapped(merged.budget?.daily_usd, agent.daily_budget ?? undefined) as number,
      monthly_usd: sumCapped(
        merged.budget?.monthly_usd,
        agent.monthly_budget ?? undefined,
      ) as number,
    },
  };

  const parsed = ResolvedAgentConfig.safeParse(withColumns);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new ConfigError(
      `Resolved configuration for "${agent.name}" is incomplete — the agent cannot run.`,
      issues,
    );
  }

  // An intersect that empties a set is not a valid configuration, it is a
  // misconfiguration that would otherwise present as an agent doing nothing at
  // all with no error anywhere.
  if (parsed.data.outreach_strategy.channels.length === 0) {
    throw new ConfigError(
      `"${agent.name}" has no channels left after inheritance.`,
      ["Its country manager permits none of the channels this agent requests."],
    );
  }

  return { agent, chain, config: parsed.data };
}

/** Every vertical agent under a country manager, or under the director. */
export async function listChildren(agentId: number): Promise<AgentRow[]> {
  return query<AgentRow>(
    `select * from sales.agent where parent_id = $1 and status <> 'archived' order by name`,
    [agentId],
  );
}

export async function getAgentByName(name: string): Promise<AgentRow | undefined> {
  const rows = await query<AgentRow>(
    `select * from sales.agent
      where lower(name) = lower($1) or lower(name) like lower($1) || '%'
      order by length(name) limit 2`,
    [name],
  );
  if (rows.length > 1 && rows[0].name.toLowerCase() !== name.toLowerCase()) {
    throw new Error(
      `"${name}" matches more than one agent (${rows.map((r) => r.name).join(", ")}).`,
    );
  }
  return rows[0];
}

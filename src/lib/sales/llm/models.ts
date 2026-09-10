/**
 * Which model runs which agent, and what it costs.
 *
 * Every task is separately configurable, because they are not the same job.
 * Personalisation writes the words a prospect reads and is the one place a
 * weak model costs a customer rather than a few cents; reply classification
 * picks one of eleven labels. Defaulting the whole pipeline to one model
 * either overpays for the easy tasks or underpays for the hard one.
 *
 * Defaults are Opus 5 across the board. That is the expensive answer and a
 * deliberate one: quality per lead matters more than cost per lead until
 * volume proves otherwise, and every task here is overridable by environment
 * variable, so trading down is a decision you make with numbers rather than
 * one this file makes for you.
 */

export type LlmTask =
  | "research"
  | "decision_maker"
  | "personalise"
  | "classify_reply"
  | "briefing"
  | "directive";

/** Per 1M tokens, in USD. */
interface Pricing {
  input: number;
  output: number;
  /** Cache writes cost ~1.25x input; cache reads ~0.1x. */
  cacheWrite: number;
  cacheRead: number;
}

export const PRICING: Record<string, Pricing> = {
  "claude-opus-5": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

export const DEFAULT_MODEL = "claude-opus-5";

const TASK_ENV: Record<LlmTask, string> = {
  research: "SALES_MODEL_RESEARCH",
  decision_maker: "SALES_MODEL_DECISION_MAKER",
  personalise: "SALES_MODEL_PERSONALISE",
  classify_reply: "SALES_MODEL_CLASSIFY",
  briefing: "SALES_MODEL_BRIEFING",
  directive: "SALES_MODEL_DIRECTIVE",
};

export function modelFor(task: LlmTask): string {
  return process.env[TASK_ENV[task]] || process.env.SALES_DEFAULT_MODEL || DEFAULT_MODEL;
}

/**
 * Effort per task.
 *
 * Haiku 4.5 rejects `output_config.effort` outright — the same trap the voice
 * runtime already documents in `src/lib/agent/runtime.ts`, where getting it
 * wrong is a hard API error rather than a worse answer. So effort is resolved
 * against the model actually chosen, not against the task alone.
 */
export function effortFor(task: LlmTask, model: string): "low" | "medium" | "high" | undefined {
  if (model.startsWith("claude-haiku")) return undefined;
  switch (task) {
    // Reads a website and fills in a fixed schema. Judgement is in what to
    // believe, not in how to reason about it.
    case "research":
    case "decision_maker":
    case "classify_reply":
      return "low";
    // Writes the sentence a prospect actually reads, and has to decide which
    // observation is worth leading with. Worth the tokens.
    case "personalise":
      return "medium";
    case "briefing":
    case "directive":
      return "medium";
    default:
      return "low";
  }
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** USD for one call. Unknown models cost 0 rather than throwing — a missing
 *  price is a reporting gap, not a reason to fail the pipeline. */
export function costOf(model: string, usage: TokenUsage): number {
  const price = PRICING[model];
  if (!price) return 0;
  const m = 1_000_000;
  return (
    (usage.input_tokens * price.input) / m +
    (usage.output_tokens * price.output) / m +
    ((usage.cache_creation_input_tokens ?? 0) * price.cacheWrite) / m +
    ((usage.cache_read_input_tokens ?? 0) * price.cacheRead) / m
  );
}

/**
 * A rough per-call estimate, used as budget headroom *before* the call so an
 * agent cannot slip past its daily cap on the last request of the day.
 * Intentionally generous — under-estimating headroom defeats the point.
 */
export function estimateCostUsd(task: LlmTask, model: string): number {
  const price = PRICING[model] ?? PRICING[DEFAULT_MODEL];
  const shape: Record<LlmTask, { in: number; out: number }> = {
    research: { in: 18_000, out: 1_200 },
    decision_maker: { in: 6_000, out: 400 },
    personalise: { in: 5_000, out: 500 },
    classify_reply: { in: 3_000, out: 300 },
    briefing: { in: 8_000, out: 1_000 },
    directive: { in: 6_000, out: 800 },
  };
  const s = shape[task];
  return (s.in * price.input) / 1_000_000 + (s.out * price.output) / 1_000_000;
}

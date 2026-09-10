import { z } from "zod";

/**
 * Agent configuration.
 *
 * One schema for all three levels of the hierarchy. A Director sets three
 * fields, a country manager sets compliance and budget, a vertical agent sets
 * everything else — so every field is optional in what is *stored*, and
 * required only in what is *resolved* (see `resolveAgentConfig`).
 *
 * The reason this is validated rather than trusted: an agent is created from a
 * form by a person who is not looking at the pipeline code, and a typo in a
 * scoring weight should stop the agent from starting rather than quietly
 * produce a pipeline full of wrongly-ranked leads.
 */

export const CHANNELS = ["email", "linkedin", "whatsapp", "phone", "sms"] as const;
export type Channel = (typeof CHANNELS)[number];

export const AUTONOMY = ["review", "semi", "autonomous"] as const;
export type AutonomyMode = (typeof AUTONOMY)[number];

/** The signals the research agent may report. A closed vocabulary on purpose:
 *  scoring weights refer to these names, and a model inventing a new signal
 *  would score as zero without anyone noticing. */
export const SIGNALS = [
  "multi_location",
  "long_hours",
  "weekend_open",
  "appointment_based",
  "online_booking",
  "whatsapp_booking",
  "phone_first",
  "has_front_desk",
  "premium_positioning",
  "recent_expansion",
  "review_complaints_about_calls",
  "after_hours_gap",
  "high_ticket",
  // Numeric signals, normalised by the scoring model rather than used raw.
  "review_volume",
  "practitioner_count",
  "location_count",
  // Behavioural, written by the pipeline rather than the research agent.
  "demo_used",
] as const;
export type SignalName = (typeof SIGNALS)[number];

export const PENALTIES = [
  "permanently_closed",
  "solo_operation",
  "no_phone",
  "no_appointments",
  "outside_region",
  "wrong_vertical",
] as const;
export type PenaltyName = (typeof PENALTIES)[number];

// ---------------------------------------------------------------------------

const SendWindow = z.object({
  /** 0 = Sunday, matching Date.getDay() and the booking engine's WeeklyHours. */
  days: z.array(z.number().int().min(0).max(6)).min(1),
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
  tz: z.string().min(1),
});
export type SendWindow = z.infer<typeof SendWindow>;

const Icp = z.object({
  must: z
    .object({
      has_phone: z.boolean(),
      has_website: z.boolean(),
      appointment_based: z.boolean(),
      status_not: z.array(z.string()),
    })
    .partial(),
  prefer: z
    .object({
      location_count_min: z.number().int().min(1),
      review_count_min: z.number().int().min(0),
      rating_min: z.number().min(0).max(5),
      open_weekends: z.boolean(),
      practitioner_count_min: z.number().int().min(1),
    })
    .partial(),
  exclude: z
    .object({
      solo_operation: z.boolean(),
      chains_above: z.number().int().min(1),
      keywords_in_name: z.array(z.string()),
    })
    .partial(),
});
export type Icp = z.infer<typeof Icp>;

const QualificationRules = z.object({
  min_score_to_contact: z.number().int().min(0).max(100),
  /** At least one of these must be present before a lead may be contacted. */
  require_contactable: z.array(z.enum(["email", "phone", "linkedin"])).min(1),
  require_evidence_for_claims: z.boolean(),
});

/**
 * A weight map need not mention every signal — an agent that does not care
 * about weekend opening simply omits it. Zod 4's enum-keyed `z.record` is
 * exhaustive, which would reject that, so keys are checked by refinement
 * instead. The error message names the offender, because the usual cause is a
 * typo in the agent editor and "invalid config" is a useless thing to read.
 */
function partialRecordOf<const T extends readonly string[]>(allowed: T, label: string) {
  const set = new Set<string>(allowed);
  return z.record(z.string(), z.number()).superRefine((value, ctx) => {
    for (const key of Object.keys(value)) {
      if (!set.has(key)) {
        ctx.addIssue({
          code: "custom",
          message: `Unknown ${label} "${key}". Known ${label}s: ${allowed.join(", ")}.`,
          path: [key],
        });
      }
    }
  }) as unknown as z.ZodType<Partial<Record<T[number], number>>>;
}

const Scoring = z.object({
  weights: partialRecordOf(SIGNALS, "signal"),
  penalties: partialRecordOf(PENALTIES, "penalty"),
  bands: z.object({
    hot: z.number().int().min(0).max(100),
    warm: z.number().int().min(0).max(100),
  }),
});
export type Scoring = z.infer<typeof Scoring>;

const OutreachStrategy = z.object({
  channels: z.array(z.enum(CHANNELS)).min(1),
  sequence: z.string().min(1),
  tone: z.string(),
  cta: z.enum(["demo_call", "demo_link", "reply_question", "meeting"]),
  max_words_first_touch: z.number().int().min(20).max(300),
  send_window: SendWindow,
  daily_send_cap: z.number().int().min(1),
});

/** Country-level rules. Merged `strictest`, so a vertical agent can only ever
 *  end up more constrained than its country manager, never less. */
const Compliance = z.object({
  email_requires_prior_consent: z.boolean(),
  prefer_company_level_contact: z.boolean(),
  person_level_requires_review: z.boolean(),
  phone_requires_dnc_screen: z.boolean(),
  max_sequence_steps: z.number().int().min(1).max(10),
  /** Days between two touches to the same contact. */
  min_days_between_touches: z.number().int().min(0),
  /** Messages to one company in any rolling 90 days, across all agents. */
  company_touch_cap_90d: z.number().int().min(1),
  /** ISO dates on which nothing sends in this country. */
  holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
});
export type Compliance = z.infer<typeof Compliance>;

const Budget = z.object({
  daily_usd: z.number().min(0),
  monthly_usd: z.number().min(0),
});

// ---------------------------------------------------------------------------

/** What is stored on any single agent row. Everything optional. */
export const PartialAgentConfig = z
  .object({
    regions: z.array(z.string()),
    languages: z.array(z.string()),
    default_language: z.string(),
    ideal_customer_profile: Icp,
    belline_services: z.array(z.string()),
    qualification_rules: QualificationRules.partial(),
    research_prompt: z.string(),
    scoring: Scoring.partial(),
    outreach_strategy: OutreachStrategy.partial(),
    compliance: Compliance.partial(),
    budget: Budget.partial(),
  })
  .partial()
  .strict();
export type PartialAgentConfig = z.infer<typeof PartialAgentConfig>;

/** What the pipeline actually runs on, after Director → Country → Vertical. */
export const ResolvedAgentConfig = z.object({
  regions: z.array(z.string()),
  languages: z.array(z.string()).min(1),
  default_language: z.string(),
  ideal_customer_profile: Icp,
  belline_services: z.array(z.string()).min(1),
  qualification_rules: QualificationRules,
  research_prompt: z.string(),
  scoring: Scoring,
  outreach_strategy: OutreachStrategy,
  compliance: Compliance,
  budget: Budget,
});
export type ResolvedAgentConfig = z.infer<typeof ResolvedAgentConfig>;

// ---------------------------------------------------------------------------
// Merge modes
// ---------------------------------------------------------------------------

/**
 * How each top-level field combines as configuration flows Director → Country
 * → Vertical. This table is the mechanism that makes the hierarchy real rather
 * than decorative — see docs/sales-engine/AGENTS.md §2.
 *
 *   override    child wins outright
 *   deep        objects merge key by key, child wins per key
 *   intersect   child may only narrow the parent's set
 *   sum_capped  child's number may not exceed the parent's
 *   strictest   the more restrictive value wins regardless of who set it
 */
export type MergeMode = "override" | "deep" | "intersect" | "sum_capped" | "strictest";

export const MERGE_MODES: Record<keyof PartialAgentConfig, MergeMode> = {
  regions: "intersect",
  languages: "intersect",
  default_language: "override",
  ideal_customer_profile: "deep",
  belline_services: "intersect",
  qualification_rules: "deep",
  research_prompt: "override",
  scoring: "deep",
  outreach_strategy: "deep",
  compliance: "strictest",
  budget: "sum_capped",
};

/**
 * Within `outreach_strategy`, which is merged `deep`, two keys still need
 * stricter handling: a vertical agent must not be able to widen the channels
 * its country manager permits, nor raise the daily cap. Without this a single
 * `deep` merge would let a child re-enable WhatsApp in Switzerland.
 */
export const OUTREACH_KEY_MODES: Partial<Record<keyof z.infer<typeof OutreachStrategy>, MergeMode>> =
  {
    channels: "intersect",
    daily_send_cap: "sum_capped",
    send_window: "strictest",
  };

/** For `strictest` on compliance: which direction is more restrictive. */
export const STRICTEST_DIRECTION: Record<keyof Compliance, "max" | "min" | "true" | "union"> = {
  email_requires_prior_consent: "true",
  prefer_company_level_contact: "true",
  person_level_requires_review: "true",
  phone_requires_dnc_screen: "true",
  max_sequence_steps: "min",
  min_days_between_touches: "max",
  company_touch_cap_90d: "min",
  holidays: "union",
};

import crypto from "node:crypto";
import type { Scoring } from "../config/schema";

/**
 * Lead scoring.
 *
 * **Deterministic. No model runs here.** The research agent extracted the
 * signals; this is arithmetic over them with the agent's configured weights.
 * That split is the point: judgement about *what a website says* is a language
 * problem and belongs to an LLM, while judgement about *what we care about* is
 * a business decision and belongs in configuration a person can edit and a
 * test can pin down.
 *
 * Two consequences worth having:
 *
 *   Re-scoring is free. Change a weight and every lead can be re-ranked
 *   without spending a token, because the signals are already stored.
 *
 *   Every score is explainable. `breakdown` carries each term of the sum, so
 *   the dashboard can say "85 — multi-location +15, phone-first +15, 340
 *   reviews +12" instead of showing a number nobody can argue with.
 */

export interface ScoringInput {
  /** From the latest research_record. Values may be null = "could not tell". */
  signals: Record<string, unknown>;
  /** Facts from discovery, which the research agent does not re-derive. */
  company: {
    reviewCount?: number | null;
    rating?: number | null;
    /** Distinct physical locations found, which is harder evidence than the
     *  website's own claim. */
    branches?: number;
    hasPhone: boolean;
    hasWebsite: boolean;
    status?: string | null;
    city?: string | null;
  };
  /** Regions the agent is configured to work. Empty means no restriction. */
  regions: string[];
  /** Whether the prospect has used a demo. Behavioural, not researched. */
  demoUsed?: boolean;
  scoring: Scoring;
}

export interface ScoreTerm {
  signal: string;
  weight: number;
  /** 0–1 for booleans and normalised counts. */
  value: number;
  points: number;
  why: string;
}

export interface ScoreResult {
  score: number;
  priority: "hot" | "warm" | "low";
  breakdown: ScoreTerm[];
  reason: string;
  /** Hash of the weights used, so a score can be tied to the model that made it. */
  modelVersion: string;
}

/**
 * Normalisation for the signals that are counts rather than facts.
 *
 * Each returns 0–1 and saturates, because the difference between 200 and 2000
 * reviews does not matter nearly as much as the difference between 5 and 200 —
 * both are "this phone rings a lot".
 */
const NORMALISE: Record<string, (input: ScoringInput) => { value: number; why: string } | null> = {
  review_volume: (i) => {
    const n = i.company.reviewCount;
    if (n === null || n === undefined) return null;
    return { value: Math.min(n / 200, 1), why: `${n} Google reviews` };
  },
  practitioner_count: (i) => {
    const n = num(i.signals.practitioner_count);
    if (n === null) return null;
    return { value: Math.min(n / 8, 1), why: `${n} practitioners listed` };
  },
  location_count: (i) => {
    // The website's claim and the map's evidence can disagree — Dr Joy's site
    // says thirteen clinics while discovery found four. Take the larger: the
    // site is authoritative about the business, the map only about what it
    // happened to index.
    const claimed = num(i.signals.location_count);
    const found = i.company.branches ?? 0;
    const n = Math.max(claimed ?? 0, found);
    if (n <= 0) return null;
    return { value: Math.min(n / 5, 1), why: `${n} locations` };
  },
};

/** Signals that are plain booleans, with the phrasing used in `reason`. */
const BOOLEAN_WHY: Record<string, string> = {
  multi_location: "multiple locations",
  long_hours: "long opening hours",
  weekend_open: "open at weekends",
  appointment_based: "runs on appointments",
  online_booking: "has online booking",
  whatsapp_booking: "books over WhatsApp",
  phone_first: "phone is the main way to book",
  has_front_desk: "has a front desk",
  premium_positioning: "premium positioning",
  recent_expansion: "recently expanded",
  review_complaints_about_calls: "reviews mention unanswered calls",
  after_hours_gap: "no cover outside opening hours",
  high_ticket: "high-value treatments",
  demo_used: "used the demo",
};

export function scoreLead(input: ScoringInput): ScoreResult {
  const breakdown: ScoreTerm[] = [];
  let raw = 0;

  for (const [signal, weight] of Object.entries(input.scoring.weights ?? {})) {
    if (!weight) continue;

    const normaliser = NORMALISE[signal];
    let value: number | null = null;
    let why = BOOLEAN_WHY[signal] ?? signal.replace(/_/g, " ");

    if (normaliser) {
      const out = normaliser(input);
      if (out) {
        value = out.value;
        why = out.why;
      }
    } else if (signal === "demo_used") {
      value = input.demoUsed ? 1 : 0;
    } else {
      const v = input.signals[signal];
      // null is "could not tell" and scores nothing — it is neither evidence
      // for nor against, and must not be treated as a negative.
      if (v === null || v === undefined) value = null;
      else value = v === true ? 1 : 0;
    }

    if (value === null) continue;

    const points = Math.round(weight * value * 10) / 10;
    raw += points;
    if (points !== 0) breakdown.push({ signal, weight, value, points, why });
  }

  for (const [penalty, weight] of Object.entries(input.scoring.penalties ?? {})) {
    if (!weight) continue;
    const hit = penaltyApplies(penalty, input);
    if (!hit) continue;
    raw += weight;
    breakdown.push({ signal: penalty, weight, value: 1, points: weight, why: hit });
  }

  const score = Math.max(0, Math.min(100, Math.round(raw)));
  const bands = input.scoring.bands ?? { hot: 75, warm: 55 };
  const priority = score >= bands.hot ? "hot" : score >= bands.warm ? "warm" : "low";

  return {
    score,
    priority,
    breakdown: breakdown.sort((a, b) => Math.abs(b.points) - Math.abs(a.points)),
    reason: explain(breakdown, score),
    modelVersion: versionOf(input.scoring),
  };
}

function penaltyApplies(penalty: string, input: ScoringInput): string | null {
  const s = input.signals;
  switch (penalty) {
    case "permanently_closed":
      return input.company.status === "closed" ? "permanently closed" : null;
    case "solo_operation": {
      const n = num(s.practitioner_count);
      return n === 1 ? "single practitioner" : null;
    }
    case "no_phone":
      return input.company.hasPhone ? null : "no phone number";
    case "no_appointments":
      // Explicitly false, not merely unknown. An unresearched company must not
      // be penalised for something nobody has checked.
      return s.appointment_based === false ? "does not take appointments" : null;
    case "outside_region": {
      if (input.regions.length === 0 || !input.company.city) return null;
      const city = input.company.city.toLowerCase();
      const inside = input.regions.some(
        (r) => city.includes(r.toLowerCase()) || r.toLowerCase().includes(city),
      );
      return inside ? null : `${input.company.city} is outside the target regions`;
    }
    case "wrong_vertical":
      return null; // Decided upstream by discovery, not inferable from signals.
    default:
      return null;
  }
}

/** A sentence a person can read, built from the three heaviest terms. */
function explain(breakdown: ScoreTerm[], score: number): string {
  const positive = breakdown.filter((t) => t.points > 0).slice(0, 3);
  const negative = breakdown.filter((t) => t.points < 0);

  if (positive.length === 0 && negative.length === 0) {
    return `Scored ${score} with no signals established — this company has not been researched.`;
  }

  const parts: string[] = [];
  if (positive.length) parts.push(positive.map((t) => t.why).join(", "));
  if (negative.length) parts.push(`against: ${negative.map((t) => t.why).join(", ")}`);
  return `${score} — ${parts.join("; ")}.`;
}

/**
 * A hash of the weights, not a version number someone has to remember to bump.
 *
 * Stored on every `lead_score` row, so "which rules produced this number" is
 * answerable, and a re-score after a weight change is visibly a different
 * model rather than a mysterious change of mind.
 */
export function versionOf(scoring: Scoring): string {
  const canonical = JSON.stringify({
    w: Object.entries(scoring.weights ?? {}).sort(),
    p: Object.entries(scoring.penalties ?? {}).sort(),
    b: scoring.bands,
  });
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

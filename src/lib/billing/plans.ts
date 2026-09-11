/**
 * What Belline costs.
 *
 * One catalogue, read by the billing engine and checked against the website by
 * `scripts/check-billing.ts`. Two rules hold it together:
 *
 *   Money is integer fils, never a float. An invoice that reads
 *   "AED 246.60000000000002" destroys more trust than a whole outage, and
 *   137 minutes at AED 1.45 is exactly that sum in IEEE 754.
 *
 *   Every feature carries whether it actually works. A plan may describe
 *   something we intend to build, but `status: "not-yet"` never reaches a
 *   public page — the test suite fails the build if it does. The temptation to
 *   list a roadmap item on a pricing card is strongest precisely when someone
 *   is deciding whether to pay, which is the worst possible moment to be found
 *   out.
 */

/** 1 AED = 100 fils. Every amount in this module is fils. */
export const FILS = 100;

export type PlanId = "starter" | "business";
export type BillingCycle = "monthly" | "annual";

export interface Feature {
  text: string;
  /**
   * `live` — works end to end today, on a real phone call.
   * `not-yet` — real intent, not built. Never rendered on a public page.
   */
  status: "live" | "not-yet";
  /** What is missing. Read by the internal gaps report, never by a visitor. */
  gap?: string;
}

export interface Plan {
  id: PlanId;
  name: string;
  /** Charged every month, in fils. */
  monthly: number;
  /** Charged once a year, in fils. Ten months' money for twelve months. */
  annual: number;
  /** Minutes included each month, on either cycle. */
  includedMinutes: number;
  /** Charged per whole minute past the allowance, in fils. */
  overagePerMinute: number;
  recommended?: boolean;
  summary: string;
  features: Feature[];
}

/**
 * Priced in dirhams, not converted at runtime.
 *
 * The dirham is pegged to the dollar at 3.6725, so these are the dollar
 * figures rounded to numbers that read like software pricing rather than like
 * a conversion someone forgot to tidy: $49 → AED 179, $99 → AED 365,
 * $0.49 → AED 1.80, $0.39 → AED 1.45.
 */
export const PLANS: Plan[] = [
  {
    id: "starter",
    name: "Starter",
    monthly: 179 * FILS,
    annual: 1790 * FILS,
    includedMinutes: 60,
    overagePerMinute: 180,
    summary: "For a single venue that wants the phone answered properly.",
    features: [
      { text: "60 voice minutes a month", status: "live" },
      { text: "One Belline receptionist, answering 24/7", status: "live" },
      { text: "Books and changes appointments against your real availability", status: "live" },
      { text: "Answers questions from your own hours, prices and policies", status: "live" },
      { text: "Summary and full transcript of every call", status: "live" },
      { text: "Flags anything it should not handle for you to call back", status: "live" },
      { text: "No setup fee", status: "live" },
      {
        text: "English and Arabic",
        status: "not-yet",
        gap:
          "Speech recognition is pinned to English in src/lib/providers/stt.ts. " +
          "Deepgram and ElevenLabs both support Arabic, but nothing is configured, " +
          "prompted or tested for it, and no Arabic call has ever been made.",
      },
      {
        text: "Warm call transfer to a member of staff",
        status: "not-yet",
        gap:
          "The agent decides to transfer and then hangs up. There is no Twilio " +
          "<Dial> anywhere in the codebase, so the caller is never connected to a " +
          "person — the call is recorded as 'transferred' and raised in the Action " +
          "Inbox for a callback. What works today is a flagged callback, not a transfer.",
      },
    ],
  },
  {
    id: "business",
    name: "Business",
    monthly: 365 * FILS,
    annual: 3650 * FILS,
    includedMinutes: 180,
    overagePerMinute: 145,
    recommended: true,
    summary: "For a venue where the phone is genuinely busy.",
    features: [
      { text: "180 voice minutes a month", status: "live" },
      { text: "Everything in Starter", status: "live" },
      { text: "Your own rules about what it may and may not decide", status: "live" },
      { text: "Every change versioned, with one-click revert", status: "live" },
      { text: "Waitlist — it offers a slot the moment one frees", status: "live" },
      { text: "Priority support", status: "live" },
      {
        text: "Google Calendar and booking-system integrations",
        status: "not-yet",
        gap:
          "Google Calendar is written and tested but has never run — it needs " +
          "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Railway. Fresha, SevenRooms, " +
          "OpenTable and Treatwell are partner-gated and issue no credentials without " +
          "a signed agreement.",
      },
    ],
  },
];

export function planById(id: PlanId): Plan {
  const plan = PLANS.find((p) => p.id === id);
  if (!plan) throw new Error(`No such plan: ${id}`);
  return plan;
}

/** What a plan costs for one billing period, in fils. */
export function periodFee(plan: Plan, cycle: BillingCycle): number {
  return cycle === "annual" ? plan.annual : plan.monthly;
}

/**
 * The monthly-equivalent price of the annual cycle.
 *
 * Shown on the website beside "billed annually". Rounded down to the whole
 * dirham so the twelve months we advertise never add up to more than the sum
 * we actually charge.
 */
export function annualPerMonth(plan: Plan): number {
  return Math.floor(plan.annual / 12 / FILS) * FILS;
}

/** Months of the year the annual cycle does not charge for. */
export const ANNUAL_MONTHS_FREE = 2;

/**
 * Everything the catalogue describes that does not yet work.
 *
 * The pricing page is generated against `live` features only; this is the
 * other half of that list, so what we are choosing not to say is written down
 * somewhere rather than just absent.
 */
export function notYetLive(): { plan: string; feature: string; gap: string }[] {
  return PLANS.flatMap((plan) =>
    plan.features
      .filter((f) => f.status === "not-yet")
      .map((f) => ({ plan: plan.name, feature: f.text, gap: f.gap ?? "No reason recorded." })),
  );
}

/** Format fils as dirhams for display. */
export function aed(fils: number): string {
  const whole = fils / FILS;
  return Number.isInteger(whole)
    ? `AED ${whole.toLocaleString("en-AE")}`
    : `AED ${whole.toLocaleString("en-AE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

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

export type PlanId = "starter" | "business" | "enterprise";
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
  /**
   * Minutes included each month. `null` is unlimited.
   *
   * There is no per-minute overage anywhere in this product. A plan is a
   * plan: use what it includes, and when you need more, move up. That is one
   * fewer number for an operator to model, and it removes the failure this
   * whole file was written to prevent — an invoice nobody saw coming.
   */
  includedMinutes: number | null;
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
    recommended: true,
    summary: "For a venue where the phone is genuinely busy.",
    features: [
      { text: "180 voice minutes a month", status: "live" },
      { text: "Everything in Starter", status: "live" },
      { text: "Your own rules about what it may and may not decide", status: "live" },
      { text: "Every change versioned, with one-click revert", status: "live" },
      { text: "Waitlist — it offers a slot the moment one frees", status: "live" },
      { text: "Priority support", status: "live" },
    ],
  },
  {
    id: "enterprise",
    name: "Enterprise",
    /**
     * Unlimited, priced above the heaviest month we can plausibly see.
     *
     * A venue taking thirty calls a day at two minutes each runs to roughly
     * 1,800 minutes a month. Our own cost is about AED 0.40 a minute across
     * the three vendors, so that month costs us around AED 720 — and a price
     * below that turns our best customer into our worst. AED 899 covers it
     * with room, and still sits under what the UAE market charges for far
     * less.
     */
    monthly: 899 * FILS,
    annual: 8990 * FILS,
    includedMinutes: null,
    summary: "For a venue whose phone never stops, or one that would rather not count.",
    features: [
      { text: "Unlimited voice minutes", status: "live" },
      { text: "Everything in Business", status: "live" },
      { text: "One venue, no allowance to watch", status: "live" },
      { text: "Named contact for onboarding and changes", status: "live" },
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

/**
 * The cheapest plan that would carry this many minutes a month.
 *
 * Used to say "you want Business" rather than "you are over" — the second is
 * a complaint, the first is an answer. Returns null when they are already on
 * the right one.
 */
export function planFor(minutes: number, current: PlanId): Plan | null {
  const fits = PLANS.find((p) => p.includedMinutes === null || minutes <= p.includedMinutes);
  if (!fits || fits.id === current) return null;
  // Never recommend downwards off the back of one quiet month.
  const order = PLANS.map((p) => p.id);
  return order.indexOf(fits.id) > order.indexOf(current) ? fits : null;
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

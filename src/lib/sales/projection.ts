/**
 * Revenue, forward.
 *
 * A model small enough to be argued with. Eight assumptions, one loop, no
 * spreadsheet: new trials arrive, a share of last month's convert, a share of
 * the paying base leaves, and what remains pays the average price. Vendor
 * cost is minutes times what the three vendors charge us; everything else is
 * a fixed line the owner types in.
 *
 * Deliberately pure and browser-safe — no store, no database — so the page
 * can recompute it on every keystroke and the test can pin the arithmetic.
 * All money is in fils, like the rest of billing.
 */

export interface Assumptions {
  /** How far ahead, in months. */
  months: number;
  /** Trials starting in the first month. */
  newTrialsPerMonth: number;
  /** Month-on-month growth in new trials, as a fraction (0.1 = 10%). */
  trialGrowth: number;
  /** Share of a month's trials that become paying the month after. */
  trialConversion: number;
  /** Share of the paying base lost each month. */
  monthlyChurn: number;
  /** Average revenue per paying venue per month, fils. */
  arpaFils: number;
  /** Billable minutes a paying venue uses in a month, on average. */
  minutesPerVenue: number;
  /** What a minute costs us across speech, voice and the model, fils. */
  vendorCostPerMinuteFils: number;
  /** Hosting, numbers, tools — the same every month, fils. */
  fixedCostsFils: number;
}

export interface MonthRow {
  month: number;
  newTrials: number;
  converted: number;
  churned: number;
  paying: number;
  mrrFils: number;
  vendorCostFils: number;
  /** MRR less vendor cost less fixed costs. */
  profitFils: number;
  cumulativeRevenueFils: number;
}

export interface Base {
  /** Venues paying today. */
  paying: number;
  /** Venues on a trial today — the first month's conversions come from these. */
  trialing: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function project(base: Base, a: Assumptions): MonthRow[] {
  const rows: MonthRow[] = [];
  const conversion = clamp(a.trialConversion, 0, 1);
  const churn = clamp(a.monthlyChurn, 0, 1);

  let paying = Math.max(0, base.paying);
  let trialsLastMonth = Math.max(0, base.trialing);
  let cumulative = 0;

  for (let m = 1; m <= Math.max(0, Math.round(a.months)); m++) {
    const newTrials = Math.max(0, a.newTrialsPerMonth) * Math.pow(1 + a.trialGrowth, m - 1);
    const converted = trialsLastMonth * conversion;
    const churned = paying * churn;
    paying = paying - churned + converted;

    const mrr = paying * Math.max(0, a.arpaFils);
    const vendor = paying * Math.max(0, a.minutesPerVenue) * Math.max(0, a.vendorCostPerMinuteFils);
    cumulative += mrr;

    rows.push({
      month: m,
      newTrials,
      converted,
      churned,
      paying,
      mrrFils: mrr,
      vendorCostFils: vendor,
      profitFils: mrr - vendor - Math.max(0, a.fixedCostsFils),
      cumulativeRevenueFils: cumulative,
    });
    trialsLastMonth = newTrials;
  }
  return rows;
}

/**
 * Where the sliders start.
 *
 * From the book where the book has something to say — the real average
 * price and the real minutes — and from the plan table where it does not.
 * The conversion and churn figures are the honest prior for self-serve B2B
 * software at this price, not a measurement; the page says so.
 */
export function defaultAssumptions(book: {
  paying: number;
  trialing: number;
  arpaFils: number | null;
  minutesPerVenue: number | null;
  trialsLast30Days: number;
}): Assumptions {
  return {
    months: 12,
    newTrialsPerMonth: Math.max(3, book.trialsLast30Days),
    trialGrowth: 0.1,
    trialConversion: 0.35,
    monthlyChurn: 0.03,
    arpaFils: book.arpaFils ?? 365 * 100,
    minutesPerVenue: book.minutesPerVenue ?? 120,
    vendorCostPerMinuteFils: 40,
    fixedCostsFils: 0,
  };
}

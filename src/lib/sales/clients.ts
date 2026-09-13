import type { Location, Subscription } from "../types";
import { getTenant, listBookings, listCalls, listLocations, listUsersFor } from "../store";
import { annualPerMonth, planById, type BillingCycle, type PlanId } from "../billing/plans";
import { accountFor } from "../billing/usage";
import { todayIn } from "../time";

/**
 * The book of clients — every venue that has signed up, what it pays, what
 * it uses, and who to ring about it.
 *
 * Not the prospect pipeline. That lives in the sales engine and is other
 * people's businesses we would like to have; this is the businesses we have.
 * It reads the same store the customer dashboard reads, so a number here is
 * the number the customer sees on their own billing page — there is no
 * second ledger to disagree with it.
 *
 * Internal venues (our own demo lines) are excluded: they pay nothing and
 * would count as churned trials forever.
 */

export type ClientStatus = Subscription["status"] | "none";

export interface ClientRow {
  tenantId: string;
  tenantName: string;
  venueId: string;
  venueName: string;
  vertical: Location["vertical"];
  owner: { name: string; email: string } | null;
  /** The billing anniversary, or when the tenant was created. YYYY-MM-DD. */
  since: string;
  planId: PlanId | null;
  planName: string;
  cycle: BillingCycle | null;
  status: ClientStatus;
  trialEndsOn: string | null;
  paymentFailedAt: string | null;
  /** Monthly recurring revenue this venue represents today, fils. Zero unless active. */
  mrrFils: number;
  minutes: { used: number; included: number | null };
  callsThisPeriod: number;
  bookingsLast30Days: number;
  lastCallAt: string | null;
  stripeCustomerId: string | null;
}

export interface BookTotals {
  clients: number;
  venues: number;
  paying: number;
  trialing: number;
  cancelled: number;
  pastDue: number;
  noPlan: number;
  mrrFils: number;
  arrFils: number;
  minutesThisPeriod: number;
  vendorCostFils: number;
  /** MRR less vendor cost, as a share of MRR. Null with no revenue. */
  grossMarginPct: number | null;
  /** Average revenue per paying venue per month, fils. Null with none paying. */
  arpaFils: number | null;
  minutesPerPayingVenue: number | null;
  trialsLast30Days: number;
  planMix: Record<string, number>;
}

/** Our cost per billable minute across speech-to-text, the voice and the model. */
export const VENDOR_COST_PER_MINUTE_FILS = 40;

function mrrOf(sub: Subscription | undefined): number {
  if (!sub || sub.status !== "active") return 0;
  const plan = planById(sub.planId);
  return sub.cycle === "annual" ? annualPerMonth(plan) : plan.monthly;
}

export function clientBook(now = new Date()): ClientRow[] {
  const cutoff = new Date(now.getTime() - 30 * 86_400_000).toISOString();

  return listLocations()
    .map((location): ClientRow => {
      const tenant = getTenant(location.tenantId);
      const owner = listUsersFor(location.tenantId).find((u) => u.role === "owner") ?? null;
      const sub = location.subscription;
      const today = todayIn(location.timezone);
      const account = accountFor(location, today);
      const calls = listCalls(location.id);
      const lastCall = calls.reduce<string | null>(
        (latest, c) => (!latest || c.startedAt > latest ? c.startedAt : latest),
        null,
      );

      return {
        tenantId: location.tenantId,
        tenantName: tenant?.name ?? location.name,
        venueId: location.id,
        venueName: location.name,
        vertical: location.vertical,
        owner: owner ? { name: owner.name, email: owner.email } : null,
        since: sub?.startedOn ?? (tenant?.createdAt ?? "").slice(0, 10),
        planId: sub?.planId ?? null,
        planName: sub ? planById(sub.planId).name : "—",
        cycle: sub?.cycle ?? null,
        status: sub?.status ?? "none",
        trialEndsOn: sub?.trial?.endsOn ?? null,
        paymentFailedAt: sub?.paymentFailedAt ?? null,
        mrrFils: mrrOf(sub),
        minutes: { used: account?.usage.minutes ?? 0, included: account?.usage.included ?? null },
        callsThisPeriod: account?.usage.calls ?? 0,
        bookingsLast30Days: listBookings({ locationId: location.id }).filter(
          (b) => b.createdAt >= cutoff,
        ).length,
        lastCallAt: lastCall,
        stripeCustomerId: location.stripe?.customerId ?? null,
      };
    })
    .sort((a, b) => b.mrrFils - a.mrrFils || a.since.localeCompare(b.since));
}

/** Pure, so the arithmetic can be tested on rows that never touched a store. */
export function totalsOf(rows: ClientRow[], now = new Date()): BookTotals {
  const cutoff = new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
  const paying = rows.filter((r) => r.status === "active");
  const mrr = paying.reduce((n, r) => n + r.mrrFils, 0);
  const minutes = rows.reduce((n, r) => n + r.minutes.used, 0);
  const payingMinutes = paying.reduce((n, r) => n + r.minutes.used, 0);
  const vendor = minutes * VENDOR_COST_PER_MINUTE_FILS;
  const planMix: Record<string, number> = {};
  for (const r of paying) planMix[r.planName] = (planMix[r.planName] ?? 0) + 1;

  return {
    clients: new Set(rows.map((r) => r.tenantId)).size,
    venues: rows.length,
    paying: paying.length,
    trialing: rows.filter((r) => r.status === "trialing").length,
    cancelled: rows.filter((r) => r.status === "cancelled").length,
    pastDue: rows.filter((r) => r.paymentFailedAt).length,
    noPlan: rows.filter((r) => r.status === "none").length,
    mrrFils: mrr,
    arrFils: mrr * 12,
    minutesThisPeriod: minutes,
    vendorCostFils: vendor,
    grossMarginPct: mrr > 0 ? Math.round(((mrr - payingMinutes * VENDOR_COST_PER_MINUTE_FILS) / mrr) * 100) : null,
    arpaFils: paying.length ? Math.round(mrr / paying.length) : null,
    minutesPerPayingVenue: paying.length ? Math.round(payingMinutes / paying.length) : null,
    trialsLast30Days: rows.filter((r) => r.status === "trialing" && r.since >= cutoff).length,
    planMix,
  };
}

/** One line per venue, for a spreadsheet. */
export function bookAsCsv(rows: ClientRow[]): string {
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = [
    "tenant", "venue", "vertical", "owner", "email", "since", "plan", "cycle", "status",
    "trial_ends", "payment_failed_at", "mrr_aed", "minutes_used", "minutes_included",
    "calls_this_period", "bookings_30d", "last_call_at", "stripe_customer",
  ];
  const lines = rows.map((r) =>
    [
      r.tenantName, r.venueName, r.vertical, r.owner?.name, r.owner?.email, r.since, r.planName,
      r.cycle, r.status, r.trialEndsOn, r.paymentFailedAt, (r.mrrFils / 100).toFixed(2),
      r.minutes.used, r.minutes.included ?? "unlimited", r.callsThisPeriod, r.bookingsLast30Days,
      r.lastCallAt, r.stripeCustomerId,
    ]
      .map(cell)
      .join(","),
  );
  return [head.join(","), ...lines].join("\n") + "\n";
}

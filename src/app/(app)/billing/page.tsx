import Link from "next/link";
import { requireUser, resolveLocation } from "@/lib/auth-server";
import { seedIfEmpty } from "@/lib/seed";
import { accountFor, MINUTE_DEFINITION, billableMinutes } from "@/lib/billing/usage";
import { aed, annualPerMonth, FILS, PLANS } from "@/lib/billing/plans";
import { listCalls } from "@/lib/store";
import { addDays, dateToSpoken, todayIn } from "@/lib/time";
import { LocationTabs, PageHeader } from "@/components/LocationTabs";

import ManageBilling from "./ManageBilling";

export const dynamic = "force-dynamic";

/**
 * Minutes, allowance, overage, and what the next invoice will say.
 *
 * The pricing page promises "no surprise invoices". This is where that promise
 * is either kept or exposed as marketing, so the page leads with the number a
 * venue is actually worried about — what this is going to cost — rather than
 * with a usage bar that makes them work it out themselves.
 *
 * Every figure here comes from billing/usage.ts, which is the same module the
 * invoice would be generated from. There is no second calculation on this page
 * to drift away from the first.
 */

function Bar({ used, included }: { used: number; included: number | null }) {
  // Unlimited has no bar. A bar needs an end, and drawing one against an
  // invented ceiling would be the page inventing a limit that does not exist.
  if (included === null) {
    return (
      <div style={{ marginTop: 14, fontSize: 13.5 }}>
        <strong style={{ fontVariantNumeric: "tabular-nums" }}>{used}</strong>{" "}
        <span className="muted">minutes this period · unlimited</span>
      </div>
    );
  }

  const share = included > 0 ? used / included : 0;
  const over = share > 1;
  // The allowance is the full width and anything past it is drawn beyond it,
  // rather than rescaling — a bar that quietly re-baselines makes going over
  // look like normal progress.
  const fill = Math.min(1, share);
  const spill = over ? Math.min(0.35, share - 1) : 0;

  return (
    <div style={{ marginTop: 14 }}>
      <div
        style={{
          display: "flex",
          height: 10,
          borderRadius: 999,
          background: "var(--border-soft)",
          overflow: "hidden",
        }}
        role="img"
        aria-label={`${used} of ${included} minutes used`}
      >
        <div style={{ width: `${fill * 100}%`, background: over ? "var(--warn)" : "var(--ok)" }} />
        {spill > 0 && <div style={{ width: `${spill * 100}%`, background: "var(--bad)" }} />}
      </div>
      <div
        className="muted"
        style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, marginTop: 6 }}
      >
        <span>
          {used} of {included} minutes
        </span>
        <span>{Math.round(share * 100)}%</span>
      </div>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 16,
        padding: "9px 0",
        fontSize: strong ? 14.5 : 13.5,
        fontWeight: strong ? 700 : 400,
        borderTop: strong ? "1px solid var(--border)" : undefined,
        marginTop: strong ? 6 : undefined,
        paddingTop: strong ? 14 : 9,
      }}
    >
      <span className={strong ? undefined : "muted"}>{label}</span>
      <span style={{ fontVariantNumeric: "tabular-nums" }}>{value}</span>
    </div>
  );
}

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ loc?: string }>;
}) {
  seedIfEmpty();
  const user = await requireUser();
  const { loc } = await searchParams;
  const location = await resolveLocation(user, loc);
  if (!location) return <p className="muted">No venues are assigned to your account yet.</p>;

  const today = todayIn(location.timezone);
  const account = accountFor(location, today);

  if (!account) {
    return (
      <>
        <PageHeader title="Plan and usage" subtitle={location.name} />
        <LocationTabs base="/billing" active={location.id} />
        <div className="panel" style={{ padding: "26px 24px" }}>
          <p style={{ margin: 0, fontSize: 14.5 }}>This venue is not on a plan yet.</p>
          <p className="muted" style={{ fontSize: 13, marginTop: 10, lineHeight: 1.6, maxWidth: "60ch" }}>
            Calls are still answered and everything is recorded — nothing is being
            charged and no allowance is being counted against. Choose{" "}
            {PLANS.map((p) => p.name).join(", ")} whenever you are ready.
          </p>
          <Link href={`/checkout?locationId=${location.id}`} className="btn btn-accent" style={{ marginTop: 16, display: "inline-block" }}>
            Choose a plan
          </Link>
        </div>
      </>
    );
  }

  const { plan, subscription, usage, bill, notes } = account;

  // The calls behind the number, so a figure someone disputes can be checked
  // rather than taken on trust.
  const billed = listCalls(location.id)
    .filter((c) => billableMinutes(c) > 0)
    .filter((c) => {
      const day = new Intl.DateTimeFormat("en-CA", { timeZone: location.timezone }).format(
        new Date(c.startedAt),
      );
      return day >= usage.period.start && day < usage.period.end;
    })
    .slice(0, 8);

  const ends = new Date(`${usage.period.end}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
  });

  return (
    <>
      <PageHeader
        title="Plan and usage"
        subtitle={`${location.name} · ${plan.name}${subscription.cycle === "annual" ? ", annual" : ""}`}
      />
      <LocationTabs base="/billing" active={location.id} />

      {/* What it will cost. The question this page is opened to answer. */}
      <div className="panel" style={{ padding: "22px 24px", marginBottom: 14 }}>
        <div className="muted" style={{ fontSize: 12 }}>
          {subscription.status === "trialing"
            ? "Trial — nothing is charged"
            : `Next invoice, ${ends}`}
        </div>
        <div
          style={{
            fontSize: 34,
            fontWeight: 300,
            letterSpacing: "-0.035em",
            lineHeight: 1.05,
            marginTop: 6,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {aed(bill.dueNow)}
        </div>

        {notes.length > 0 && (
          <div style={{ marginTop: 14, display: "grid", gap: 7 }}>
            {notes.map((note) => (
              <p
                key={note}
                className="muted"
                style={{ fontSize: 12.5, margin: 0, lineHeight: 1.55, maxWidth: "72ch" }}
              >
                {note}
              </p>
            ))}
          </div>
        )}
      </div>

      <div className="split">
        <div>
          <div className="panel" style={{ marginBottom: 14 }}>
            <div className="panel-head">
              This period
              <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>
                {dateToSpoken(usage.period.start)} to {dateToSpoken(addDays(usage.period.end, -1))}
              </span>
            </div>
            <div style={{ padding: "18px 18px 20px" }}>
              <Bar used={usage.minutes} included={usage.included} />

              <div style={{ marginTop: 18 }}>
                <Row label="Calls counted" value={String(usage.calls)} />
                <Row label="Minutes used" value={String(usage.minutes)} />
                <Row
                  label="Included"
                  value={usage.included === null ? "Unlimited" : String(usage.included)}
                />
                {usage.included !== null && (
                  <Row
                    label="Past the allowance"
                    value={usage.overBy > 0 ? `${usage.overBy} min — not charged` : "None"}
                  />
                )}
                {usage.projectedMinutes > usage.minutes && (
                  <Row
                    label="On this pace, by period end"
                    value={`${usage.projectedMinutes} min`}
                  />
                )}
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">Calls counted this period</div>
            {billed.length === 0 ? (
              <p className="muted" style={{ padding: "22px 18px", fontSize: 13, margin: 0 }}>
                No billable calls yet this period.
              </p>
            ) : (
              <table>
                <tbody>
                  {billed.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <Link href={`/calls/${c.id}`} style={{ fontWeight: 600 }}>
                          {c.summary ?? c.from}
                        </Link>
                        <div className="muted" style={{ fontSize: 11.5, marginTop: 3 }}>
                          {new Date(c.startedAt).toLocaleString()}
                        </div>
                      </td>
                      <td
                        style={{
                          width: 78,
                          textAlign: "right",
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {billableMinutes(c)} min
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div>
          <div className="panel" style={{ marginBottom: 14 }}>
            <div className="panel-head">What you pay</div>
            <div style={{ padding: "14px 18px 18px" }}>
              <Row
                label={plan.name}
                value={
                  subscription.cycle === "annual"
                    ? `${aed(annualPerMonth(plan))} / mo`
                    : `${aed(plan.monthly)} / mo`
                }
              />
              {bill.prepaid && (
                <p className="muted" style={{ fontSize: 11.5, margin: "2px 0 8px", lineHeight: 1.5 }}>
                  Paid up front for the year — not invoiced again this period.
                </p>
              )}
              {location.currency !== "AED" && (
                // The venue's own currency is what it charges guests. What it
                // pays us is priced in dirhams, and a figure with no currency
                // on it is the sort of ambiguity that produces a support email.
                <p className="muted" style={{ fontSize: 11.5, margin: "2px 0 8px", lineHeight: 1.5 }}>
                  Belline is billed in dirhams. Your own prices stay in {location.currency}.
                </p>
              )}
              <Row label="Invoiced now" value={aed(bill.dueNow)} strong />
              <p className="muted" style={{ fontSize: 11.5, margin: "8px 0 0", lineHeight: 1.5 }}>
                The plan fee and nothing else. There is no per-minute charge on any
                plan — if the allowance runs short, the answer is a bigger plan, not
                a bigger bill.
              </p>
              {location.stripe?.customerId && (
                // Stripe's own portal: change the card, download invoices,
                // cancel. Written months ago as `portalUrl` and reached from
                // nowhere, so a paying customer had no way to do any of those
                // without emailing us.
                <ManageBilling locationId={location.id} />
              )}
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">What counts as a minute</div>
            <div style={{ padding: "14px 18px 18px" }}>
              {/* The same sentence the pricing page carries, from the same
                  constant — two copies of a definition drift, and the one
                  that drifts is always the one the customer read. */}
              <p className="muted" style={{ fontSize: 12.5, margin: 0, lineHeight: 1.6 }}>
                {MINUTE_DEFINITION}
              </p>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

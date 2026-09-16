import Link from "next/link";
import { requireUser, resolveLocation } from "@/lib/auth-server";
import { seedIfEmpty } from "@/lib/seed";
import {
  CONVERSATION_DEFINITION,
  MINUTE_DEFINITION,
  accountFor,
  billableVoiceMinutes,
  channelOfCall,
  conversationStarts,
  isPooledTrial,
  meterWords,
  type Meter,
} from "@/lib/billing/usage";
import { extendTrialIfPaymentsClosed, raiseTrialCapIfPaymentsClosed } from "@/lib/billing/trial-end";
import { ALERT_THRESHOLDS, CHANNELS, isPooled, money, nextPlanUp, productById } from "@/lib/billing/plans";
import { packsSentence } from "@/lib/billing/speak";
import { canManageUsers } from "@/lib/auth";
import UsagePolicy from "./UsagePolicy";
import { MARKETS } from "@/lib/markets";
import { listCalls } from "@/lib/store";
import { addDays, dateToSpoken, todayIn } from "@/lib/time";
import { LocationTabs, PageHeader } from "@/components/LocationTabs";

import ManageBilling from "./ManageBilling";

export const dynamic = "force-dynamic";

/**
 * Plan, usage per allowance, and what the next invoice will say.
 *
 * The page leads with the number a venue is actually worried about — what
 * this is going to cost — and then one bar per allowance: the two pools on a
 * 2026-10 plan (voice minutes, text conversations), or one per channel on an
 * older product.
 *
 * Every figure here comes from billing/usage.ts, which is the same module the
 * invoice would be generated from. There is no second calculation on this page
 * to drift away from the first.
 */

function Bar({ usage }: { usage: Meter }) {
  const { used, included } = usage;
  const words = meterWords(usage.id);
  const across = usage.kind === "pool" ? usage.channels.map((c) => CHANNELS[c].name).join(" · ") : null;

  if (included === null) {
    // Uncounted on a grandfathered plan. No bar: a bar needs an end, and
    // drawing one against an invented ceiling would invent a limit.
    return (
      <div style={{ marginTop: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{usage.name}</div>
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          {used} {words} this period · not counted on your original plan
        </div>
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
    <div style={{ marginTop: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13, marginBottom: 6 }}>
        <strong>{usage.name}</strong>
        <span className="muted" style={{ fontVariantNumeric: "tabular-nums" }}>
          {used} of {included} {words}
        </span>
      </div>
      {across && (
        <div className="muted" style={{ fontSize: 11.5, margin: "-2px 0 6px" }}>
          Shared across {across}
        </div>
      )}
      <div
        style={{ display: "flex", height: 10, borderRadius: 999, background: "var(--border-soft)", overflow: "hidden" }}
        role="img"
        aria-label={`${used} of ${included} ${words} used`}
      >
        <div style={{ width: `${fill * 100}%`, background: over ? "var(--warn)" : "var(--ok)" }} />
        {spill > 0 && <div style={{ width: `${spill * 100}%`, background: "var(--bad)" }} />}
      </div>
      <div className="muted" style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, marginTop: 5 }}>
        <span>
          {usage.overBy > 0
            ? `${usage.overBy} past the allowance`
            : usage.projected > used && usage.projected > included
              ? `On this pace, about ${usage.projected} by period end`
              : " "}
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
  // The sweep does this for every venue; doing it here too means the owner
  // never sees an ended trial on the day payments could not be taken.
  const venue = extendTrialIfPaymentsClosed(location, today).location;
  // The trial note says the team has been told when a cap stops a channel with
  // payments closed; this is what tells them.
  raiseTrialCapIfPaymentsClosed(venue, today);
  const account = accountFor(venue, today);

  if (!account) {
    return (
      <>
        <PageHeader title="Plan and usage" subtitle={location.name} />
        <LocationTabs base="/billing" active={location.id} />
        <div className="panel" style={{ padding: "26px 24px" }}>
          <p style={{ margin: 0, fontSize: 14.5 }}>This venue is not on a plan yet.</p>
          <p className="muted" style={{ fontSize: 13, marginTop: 10, lineHeight: 1.6, maxWidth: "60ch" }}>
            Calls are still answered and everything is recorded — nothing is being charged and no
            allowance is being counted against. Choose a plan whenever you are ready.
          </p>
          <Link href="/checkout" className="btn btn-accent" style={{ marginTop: 16, display: "inline-block" }}>
            Choose a plan
          </Link>
        </div>
      </>
    );
  }

  const { market, products, name, subscription, usage, bill, notes } = account;
  const trialing = subscription.status === "trialing";
  const period = usage.period;

  // The episodes behind the numbers, so a figure someone disputes can be
  // checked rather than taken on trust.
  const inside = (iso: string) => {
    const day = new Intl.DateTimeFormat("en-CA", {
      timeZone: location.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(iso));
    return day >= period.start && day < period.end;
  };
  const counted = listCalls(location.id)
    .map((call) => {
      const channel = channelOfCall(call);
      if (!channel) return null;
      const units =
        CHANNELS[channel].unit === "minutes"
          ? inside(call.startedAt)
            ? billableVoiceMinutes(call)
            : 0
          : conversationStarts(call).filter(inside).length;
      return units > 0 ? { call, channel, units } : null;
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .slice(0, 8);

  const ends = new Date(`${period.end}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long" });
  const units = new Set(usage.meters.map((m) => m.unit));
  const billedIn = MARKETS[market].currency;

  return (
    <>
      <PageHeader
        title="Plan and usage"
        subtitle={`${location.name} · ${name}${subscription.cycle === "annual" && !trialing ? ", annual" : ""}`}
      />
      <LocationTabs base="/billing" active={location.id} />

      {/* What it will cost. The question this page is opened to answer. */}
      <div className="panel" style={{ padding: "22px 24px", marginBottom: 14 }}>
        <div className="muted" style={{ fontSize: 12 }}>
          {trialing ? "Trial — nothing is charged" : `Next invoice, ${ends}`}
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
          {money(bill.dueNow, market)}
        </div>

        {notes.length > 0 && (
          <div style={{ marginTop: 14, display: "grid", gap: 7 }}>
            {notes.map((note) => (
              <p key={note} className="muted" style={{ fontSize: 12.5, margin: 0, lineHeight: 1.55, maxWidth: "72ch" }}>
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
                {dateToSpoken(period.start)} to {dateToSpoken(addDays(period.end, -1))}
              </span>
            </div>
            <div style={{ padding: "4px 18px 20px" }}>
              {usage.meters.map((m) => (
                <Bar key={m.id} usage={m} />
              ))}
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">Counted this period</div>
            {counted.length === 0 ? (
              <p className="muted" style={{ padding: "22px 18px", fontSize: 13, margin: 0 }}>
                Nothing billable yet this period.
              </p>
            ) : (
              <table>
                <tbody>
                  {counted.map(({ call, channel, units: n }) => (
                    <tr key={call.id}>
                      <td>
                        <Link href={`/calls/${call.id}`} style={{ fontWeight: 600 }}>
                          {call.summary ?? call.from}
                        </Link>
                        <div className="muted" style={{ fontSize: 11.5, marginTop: 3 }}>
                          {CHANNELS[channel].name} · {new Date(call.startedAt).toLocaleString()}
                        </div>
                      </td>
                      <td style={{ width: 110, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                        {CHANNELS[channel].unit === "minutes" ? `${n} min` : `${n} conversation${n === 1 ? "" : "s"}`}
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
              {trialing ? (
                <Row label="Free trial" value="Nothing charged" />
              ) : (
                // What they were sold: the fee usage.ts computed from the
                // subscription, never a price looked up again from the catalogue.
                <Row
                  label={products.map((id) => productById(id).name).join(" + ")}
                  value={bill.planFee === 0 ? "Free" : `${money(bill.planFee, market)} / mo`}
                />
              )}
              {bill.prepaid && (
                <p className="muted" style={{ fontSize: 11.5, margin: "2px 0 8px", lineHeight: 1.5 }}>
                  Paid up front for the year — not invoiced again this period.
                </p>
              )}
              {location.currency !== billedIn && (
                // The venue's own currency is what it charges guests. What it
                // pays us is priced in its market's currency, and a figure with
                // no currency on it produces a support email.
                <p className="muted" style={{ fontSize: 11.5, margin: "2px 0 8px", lineHeight: 1.5 }}>
                  Belline is billed in {billedIn}. Your own prices stay in {location.currency}.
                </p>
              )}
              {bill.packsMinor > 0 && <Row label="Packs you chose, this period" value={money(bill.packsMinor, market)} />}
              <Row label="Invoiced now" value={money(bill.dueNow, market)} strong />
              <p className="muted" style={{ fontSize: 11.5, margin: "8px 0 0", lineHeight: 1.5 }}>
                The plan fee for this period{bill.packsMinor > 0 ? ", and the packs your usage choice added" : ""}. Nothing
                is added to your bill unless you chose it.
              </p>
              <Link
                href={trialing || !products.length ? "/checkout" : `/checkout?products=${products.join(",")}`}
                className="btn"
                style={{ marginTop: 14, display: "inline-block" }}
              >
                {trialing ? "Choose a plan" : "Change plan"}
              </Link>
              {location.stripe?.customerId && (
                // Stripe's own portal: change the card, download invoices, cancel.
                <ManageBilling locationId={location.id} />
              )}
            </div>
          </div>

          {/* Shown during the trial too: the choice is made before the first
              invoice, and carries on to the plan (billing/stripe.ts). */}
          {(isPooled(products) || isPooledTrial(subscription)) && (
            <div className="panel" style={{ marginBottom: 14 }}>
              <div className="panel-head">When an allowance runs out</div>
              <UsagePolicy
                trial={trialing}
                locationId={location.id}
                mode={subscription.usagePolicy?.mode ?? null}
                capAed={
                  subscription.usagePolicy?.monthlyCapMinor !== undefined ? subscription.usagePolicy.monthlyCapMinor / 100 : null
                }
                canEdit={canManageUsers(user)}
                packs={packsSentence()}
                alerts={`We tell you at ${ALERT_THRESHOLDS.map((t) => `${t}%`).join(", ").replace(/, (?=[^,]*$)/, " and ")} of each allowance, once each per period.`}
                nextPlan={nextPlanUp(products, market)?.name ?? null}
              />
            </div>
          )}

          <div className="panel">
            <div className="panel-head">What counts</div>
            <div style={{ padding: "14px 18px 18px", display: "grid", gap: 10 }}>
              {/* The same sentences the pricing page carries, from the same
                  constants — two copies of a definition drift, and the one
                  that drifts is always the one the customer read. */}
              {units.has("minutes") && (
                <p className="muted" style={{ fontSize: 12.5, margin: 0, lineHeight: 1.6 }}>
                  {MINUTE_DEFINITION}
                </p>
              )}
              {units.has("conversations") && (
                <p className="muted" style={{ fontSize: 12.5, margin: 0, lineHeight: 1.6 }}>
                  {CONVERSATION_DEFINITION}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

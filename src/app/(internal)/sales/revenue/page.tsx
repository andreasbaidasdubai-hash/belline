import { requireUser } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import { seedIfEmpty } from "@/lib/seed";
import { clientBook, totalsOf } from "@/lib/sales/clients";
import { FILS_PER_USD, MIN_SAMPLES, RATE_CARD, RATE_CARD_DATE, phoneCostPerMinuteFils, unitCosts, type CostChannel } from "@/lib/billing/cost";
import { defaultAssumptions } from "@/lib/sales/projection";
import { ConsoleHeader, Pill, Stat, aed } from "../ui";
import Projection from "./Projection";

export const dynamic = "force-dynamic";

/**
 * The money: what comes in, what a unit costs us, and where it goes if the
 * assumptions hold. Every figure in AED. Staff only.
 */

const CHANNEL_LABEL: Record<CostChannel, string> = {
  phone: "Phone receptionist",
  embed_voice: "Website voice button",
  webchat: "Website chat",
  whatsapp: "WhatsApp",
  test: "Setup checks",
};

const aedUnit = (usd: number) => `AED ${((usd * FILS_PER_USD) / 100).toFixed(2)}`;

export default async function RevenuePage() {
  seedIfEmpty();
  const user = await requireUser();
  if (!isBellineStaff(user)) return <p className="muted">Belline staff only.</p>;

  const rows = clientBook();
  const units = unitCosts();
  const phoneUnit = units.find((u) => u.channel === "phone");
  const costPerMinuteFils = phoneCostPerMinuteFils(units);
  const t = totalsOf(rows, new Date(), costPerMinuteFils);
  const unverifiedRates = Object.values(RATE_CARD).filter((r) => !r.verified).length;
  const defaults = defaultAssumptions({
    paying: t.paying,
    trialing: t.trialing,
    arpaFils: t.arpaFils,
    minutesPerVenue: t.minutesPerPayingVenue,
    trialsLast30Days: t.trialsLast30Days,
    costPerMinuteFils: phoneUnit && !phoneUnit.fallback ? costPerMinuteFils : null,
  });
  const mix = Object.entries(t.planMix)
    .map(([name, n]) => `${n} on ${name}`)
    .join(", ");

  return (
    <>
      <ConsoleHeader
        title="Revenue"
        subtitle={`${t.paying} paying location${t.paying === 1 ? "" : "s"} · ${t.trialing} on a trial${t.pastDue ? ` · ${t.pastDue} with a failed payment` : ""}`}
        actions={
          <a href="/api/sales/clients" className="btn">
            Download CSV
          </a>
        }
      />

      <div className="stats">
        <Stat label="Monthly revenue" value={aed(t.mrrFils)} hint={mix || "nobody paying yet"} tone={t.mrrFils > 0 ? "ok" : undefined} />
        <Stat label="Yearly revenue" value={aed(t.arrFils)} hint="monthly revenue × 12" />
        <Stat
          label="Gross margin"
          value={t.grossMarginPct === null ? "—" : `${t.grossMarginPct}%`}
          hint={`at AED ${(t.costPerMinuteFils / 100).toFixed(2)} a minute (${phoneUnit && !phoneUnit.fallback ? "measured" : "planning figure"}) · ${t.minutesThisPeriod} min this period`}
        />
        <Stat label="Average price" value={t.arpaFils === null ? "—" : aed(t.arpaFils)} hint="per paying location, a month" />
        <Stat label="Trials" value={String(t.trialing)} hint={`${t.trialsLast30Days} started in the last 30 days`} />
      </div>

      <section className="panel staff-section" style={{ marginBottom: 18 }}>
        <div className="panel-head">
          What a unit costs us
          <span className="muted">
            measured from vendor usage · rate card of {RATE_CARD_DATE}
            {unverifiedRates ? ` · ${unverifiedRates} rates not yet checked` : ""}
          </span>
        </div>
        <div className="table-wrap" tabIndex={0}>
          <table className="staff-table">
            <thead>
              <tr>
                <th>Channel</th>
                <th>Per</th>
                <th className="num">Measured</th>
                <th className="num">Samples</th>
                <th className="num">Used for margins</th>
              </tr>
            </thead>
            <tbody>
              {units.map((u) => (
                <tr key={u.channel}>
                  <td style={{ fontWeight: 600 }}>{CHANNEL_LABEL[u.channel]}</td>
                  <td className="muted">{u.unit === "min" ? "minute" : "conversation"}</td>
                  <td className="num">{u.usdPerUnit === null ? "—" : aedUnit(u.usdPerUnit)}</td>
                  <td className="num">{u.samples}</td>
                  <td className="num">
                    {aedUnit(u.effectiveUsdPerUnit)} <Pill tone={u.fallback ? undefined : "ok"}>{u.fallback ? `planning figure until ${MIN_SAMPLES} samples` : "measured"}</Pill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="staff-note" style={{ padding: "10px 18px 14px" }}>
          Every call and conversation reports what it spent, priced from the rate card. A channel is used for margins once it
          has {MIN_SAMPLES} samples; until then the planning figure stands in. Vendor invoices remain the truth.
        </p>
      </section>

      <Projection base={{ paying: t.paying, trialing: t.trialing }} defaults={defaults} />
    </>
  );
}

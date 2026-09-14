import { requireUser } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import NumberCell from "./NumberCell";
import { PageHeader } from "@/components/LocationTabs";
import { seedIfEmpty } from "@/lib/seed";
import { clientBook, totalsOf } from "@/lib/sales/clients";
import {
  FILS_PER_USD,
  MIN_SAMPLES,
  RATE_CARD,
  RATE_CARD_DATE,
  phoneCostPerMinuteFils,
  unitCosts,
  type CostChannel,
} from "@/lib/billing/cost";
import { defaultAssumptions } from "@/lib/sales/projection";
import { isConfigured } from "@/lib/db/client";
import { migrateReception } from "@/lib/reception/migrate";
import { listAccounts } from "@/lib/reception/repo";
import { whatsappConfigured } from "@/lib/whatsapp";
import { Stat } from "../ui";
import Projection from "./Projection";
import WhatsAppCell from "./WhatsAppCell";

export const dynamic = "force-dynamic";

/**
 * Every client, and the money.
 *
 * The one page where the business is looked at as a business: who pays,
 * what they pay, what they use, who is on a trial and when it ends, whose
 * card failed — and underneath it, where the numbers go if the assumptions
 * hold. Owner-only, and inside the internal console rather than the customer
 * shell, because it is every customer's data on one screen.
 */

const aed = (fils: number) => `AED ${Math.round(fils / 100).toLocaleString("en-AE")}`;

const CHANNEL_LABEL: Record<CostChannel, string> = {
  phone: "Phone receptionist",
  embed_voice: "Website voice button",
  webchat: "Website chat",
  whatsapp: "WhatsApp",
};

function statusStyle(status: string, pastDue: boolean): React.CSSProperties {
  if (pastDue) return { color: "var(--bad)", borderColor: "var(--bad)" };
  if (status === "active") return { color: "var(--ok)", borderColor: "var(--ok)" };
  if (status === "trialing") return { color: "var(--accent)", borderColor: "var(--accent)" };
  if (status === "cancelled") return { color: "var(--warn)", borderColor: "var(--warn)" };
  return {};
}

export default async function ClientsPage() {
  const user = await requireUser();
  if (!isBellineStaff(user)) return <p className="muted">Owner only.</p>;

  seedIfEmpty();
  const rows = clientBook();
  // What a minute actually costs, once enough calls have reported it.
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
    .map(([name, n]) => `${n} ${name}`)
    .join(" · ");

  // Which venues have a WhatsApp number answered by Belle. Postgres, not the
  // file store, so read once for every tenant on the page.
  const whatsapp = new Map<string, string>();
  if (isConfigured()) {
    await migrateReception();
    for (const tenantId of new Set(rows.map((r) => r.tenantId))) {
      for (const a of await listAccounts(tenantId)) {
        if (a.channel === "whatsapp" && a.status === "active" && a.locationId && a.phoneE164) {
          whatsapp.set(a.locationId, a.phoneE164);
        }
      }
    }
  }
  const whatsappReady = whatsappConfigured() && isConfigured();

  return (
    <>
      <PageHeader
        title="Clients"
        subtitle={`${t.clients} client${t.clients === 1 ? "" : "s"}, ${t.venues} venue${t.venues === 1 ? "" : "s"} · ${t.paying} paying · ${t.trialing} on trial${t.pastDue ? ` · ${t.pastDue} with a failed payment` : ""}`}
        right={
          <a href="/api/sales/clients" className="btn">
            Download CSV
          </a>
        }
      />

      <div className="stats">
        <Stat label="MRR" value={aed(t.mrrFils)} hint={mix || "nobody paying yet"} tone={t.mrrFils > 0 ? "ok" : undefined} />
        <Stat label="ARR" value={aed(t.arrFils)} hint="MRR × 12" />
        <Stat
          label="Gross margin"
          value={t.grossMarginPct === null ? "—" : `${t.grossMarginPct}%`}
          hint={`after AED ${(t.costPerMinuteFils / 100).toFixed(2)} a minute (${
            phoneUnit && !phoneUnit.fallback ? "measured" : "planning figure"
          }) · ${t.minutesThisPeriod} min this period`}
        />
        <Stat label="Average price" value={t.arpaFils === null ? "—" : aed(t.arpaFils)} hint="per paying venue, a month" />
        <Stat
          label="Trials"
          value={String(t.trialing)}
          hint={`${t.trialsLast30Days} started in the last 30 days`}
          tone={t.trialing > 0 ? "ok" : undefined}
        />
      </div>

      <div className="panel" style={{ marginTop: 18 }}>
        <div className="panel-head">
          The book
          <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>
            by revenue, then by age
          </span>
        </div>
        {rows.length === 0 ? (
          <p className="muted" style={{ padding: "26px 16px", fontSize: 13, margin: 0 }}>
            No clients yet. The first self-serve signup appears here the moment it happens.
          </p>
        ) : (
          <div className="table-wrap" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th>Venue</th>
                  <th>Owner</th>
                  <th>Plan</th>
                  <th>Status</th>
                  <th>Since</th>
                  <th style={{ textAlign: "right" }}>Minutes</th>
                  <th style={{ textAlign: "right" }}>Calls</th>
                  <th style={{ textAlign: "right" }}>Bookings 30d</th>
                  <th style={{ textAlign: "right" }}>MRR</th>
                  <th>Line</th>
                  <th>WhatsApp</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.venueId}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{r.venueName}</div>
                      <div className="muted" style={{ fontSize: 11.5 }}>
                        {r.tenantName !== r.venueName ? `${r.tenantName} · ` : ""}
                        {r.vertical}
                        {r.lastCallAt ? ` · last call ${r.lastCallAt.slice(0, 10)}` : " · no calls yet"}
                      </div>
                    </td>
                    <td style={{ fontSize: 12.5 }}>
                      {r.owner ? (
                        <>
                          <div>{r.owner.name}</div>
                          <a href={`mailto:${r.owner.email}`} className="muted" style={{ fontSize: 11.5 }}>
                            {r.owner.email}
                          </a>
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td style={{ fontSize: 12.5 }}>
                      {r.products.length ? (
                        <>
                          {r.planName}
                          <span className="muted"> · {r.cycle}</span>
                        </>
                      ) : (
                        <span className="muted">none</span>
                      )}
                    </td>
                    <td>
                      <span className="pill" style={statusStyle(r.status, Boolean(r.paymentFailedAt))}>
                        {r.paymentFailedAt ? "payment failed" : r.status === "none" ? "no plan" : r.status}
                      </span>
                      {r.status === "trialing" && r.trialEndsOn && (
                        <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>ends {r.trialEndsOn}</div>
                      )}
                      {r.lapsed && (
                        <div style={{ fontSize: 11, marginTop: 3, color: "var(--bad)" }}>
                          {r.lapsed === "trial_ended" ? "trial over" : r.lapsed === "trial_minutes_used" ? "trial minutes used" : r.lapsed === "legacy_plan_ended" ? "grandfathered plan over" : "cancelled, period over"}
                        </div>
                      )}
                    </td>
                    <td className="mono" style={{ fontSize: 12 }}>{r.since || "—"}</td>
                    <td className="mono" style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {r.minutes.used}
                      <span className="muted"> / {r.minutes.included === null ? "∞" : r.minutes.included}</span>
                    </td>
                    <td className="mono" style={{ textAlign: "right" }}>{r.callsThisPeriod}</td>
                    <td className="mono" style={{ textAlign: "right" }}>{r.bookingsLast30Days}</td>
                    <td className="mono" style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {r.mrrFils ? aed(r.mrrFils) : <span className="muted">—</span>}
                    </td>
                    <td>
                      <NumberCell venueId={r.venueId} phone={r.phone} />
                    </td>
                    <td>
                      <WhatsAppCell venueId={r.venueId} number={whatsapp.get(r.venueId) ?? null} ready={whatsappReady} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* What each channel costs us, measured from what the vendors bill. */}
      <div className="panel" style={{ marginTop: 18 }}>
        <div className="panel-head">
          What a unit costs us
          <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>
            measured from vendor usage · rate card {RATE_CARD_DATE}
            {unverifiedRates ? ` · ${unverifiedRates} rates unverified` : ""}
          </span>
        </div>
        <div className="table-wrap" tabIndex={0}>
          <table>
            <thead>
              <tr>
                <th>Channel</th>
                <th>Unit</th>
                <th style={{ textAlign: "right" }}>Measured</th>
                <th style={{ textAlign: "right" }}>Samples</th>
                <th style={{ textAlign: "right" }}>Used for margins</th>
              </tr>
            </thead>
            <tbody>
              {units.map((u) => (
                <tr key={u.channel}>
                  <td style={{ fontWeight: 600 }}>{CHANNEL_LABEL[u.channel]}</td>
                  <td className="muted">per {u.unit === "min" ? "minute" : "conversation"}</td>
                  <td className="mono" style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {u.usdPerUnit === null
                      ? "—"
                      : `$${u.usdPerUnit.toFixed(4)} · AED ${((u.usdPerUnit * FILS_PER_USD) / 100).toFixed(2)}`}
                  </td>
                  <td className="mono" style={{ textAlign: "right" }}>{u.samples}</td>
                  <td style={{ textAlign: "right" }}>
                    <span className="mono">AED {((u.effectiveUsdPerUnit * FILS_PER_USD) / 100).toFixed(2)}</span>{" "}
                    <span className="pill" style={u.fallback ? undefined : { color: "var(--ok)", borderColor: "var(--ok)" }}>
                      {u.fallback ? `planning figure until ${MIN_SAMPLES}` : "measured"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted" style={{ fontSize: 11.5, margin: "10px 18px 14px", lineHeight: 1.55 }}>
          Every call and conversation reports what it spent — seconds on the line, characters synthesised,
          tokens in and out, messages sent — priced from the rate card in billing/cost.ts. A channel is used for
          margins once it has {MIN_SAMPLES} samples; until then the planning figure stands in. Vendor invoices
          remain the truth; reconcile against them.
        </p>
      </div>

      <Projection base={{ paying: t.paying, trialing: t.trialing }} defaults={defaults} />
    </>
  );
}

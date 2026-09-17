import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import { seedIfEmpty } from "@/lib/seed";
import { listAbuseRows, listBusinesses, listLocationsFor, listUsersFor } from "@/lib/store";
import { needsEmailVerification } from "@/lib/email-verify";
import { KIND_META, listExceptions } from "@/lib/exceptions";
import { isConfigured } from "@/lib/db/client";
import { migrateReception } from "@/lib/reception/migrate";
import { listAccounts } from "@/lib/reception/repo";
import { whatsappConfigured } from "@/lib/whatsapp";
import { videoConfig } from "@/lib/video/config";
import { venueAllowlisted } from "@/lib/video/availability";
import { subscriptionMarket } from "@/lib/billing/usage";
import { MARKETS } from "@/lib/markets";
import { listAudit } from "@/lib/staff/audit";
import { CUSTOMER_STATUS_LABEL, customerRows, customerTenant, paymentsOpen, planNameOf, sellablePlans, usageFor } from "@/lib/staff/customers";
import { FLAG_LABEL } from "@/lib/staff/today";
import Action from "../../Actions";
import { ConsoleHeader, EmptyState, KeyValues, Pill, aed, ago, day } from "../../ui";
import NumberCell from "../NumberCell";
import WhatsAppCell from "../WhatsAppCell";
import AbuseActions from "../AbuseActions";
import VideoAction from "../../settings/video/VideoControls";

export const dynamic = "force-dynamic";

/**
 * One customer: the business, its locations, its people, what it pays and
 * uses, and what has gone wrong. Every action on the page is audited, and
 * "View as customer" opens their dashboard read-only.
 */
export default async function CustomerPage({ params }: { params: Promise<{ tenantId: string }> }) {
  seedIfEmpty();
  const user = await requireUser();
  if (!isBellineStaff(user)) return <p className="muted">Belline staff only.</p>;

  const tenantId = decodeURIComponent((await params).tenantId);
  const tenant = customerTenant(tenantId);
  if (!tenant) notFound();

  const row = customerRows().find((r) => r.tenantId === tenantId)!;
  const business = listBusinesses(tenantId)[0];
  const locations = listLocationsFor(tenantId, { includeArchived: true }).filter((l) => !l.demo?.enabled && !l.prospect);
  const users = listUsersFor(tenantId);
  const issues = listExceptions({ status: "all", tenantId }).slice(0, 20);
  const flags = listAbuseRows().filter((r) => r.tenantId === tenantId);
  const onTrial = locations.some((l) => l.subscription?.status === "trialing");
  const suspended = Boolean(tenant.abuse?.trialSuspendedAt);
  const owner = users.find((u) => u.role === "owner" && !u.disabled);
  const ids = new Set([tenantId, ...locations.map((l) => l.id), ...users.map((u) => u.id)]);
  const history = listAudit({ limit: 400 }).filter((a) => ids.has(a.entityId)).slice(0, 15);

  // WhatsApp lives in Postgres. A database that does not answer costs this
  // column, never the page.
  const whatsapp = new Map<string, string>();
  let whatsappUnavailable = false;
  if (isConfigured()) {
    try {
      await migrateReception();
      for (const a of await listAccounts(tenantId)) {
        if (a.channel === "whatsapp" && a.status === "active" && a.locationId && a.phoneE164) whatsapp.set(a.locationId, a.phoneE164);
      }
    } catch {
      whatsappUnavailable = true;
    }
  }
  const whatsappReady = whatsappConfigured() && isConfigured() && !whatsappUnavailable;
  const video = videoConfig();
  const plansOff = !paymentsOpen();

  return (
    <>
      <p style={{ margin: "0 0 10px" }}>
        <Link href="/sales/customers" className="muted" style={{ fontSize: 12.5 }}>
          ← Customers
        </Link>
      </p>
      <ConsoleHeader
        title={tenant.name}
        subtitle={
          <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <Pill tone={row.status === "active" ? "ok" : row.status === "suspended" ? "bad" : row.status === "trial" ? "accent" : undefined}>{CUSTOMER_STATUS_LABEL[row.status]}</Pill>
            {row.paymentFailed && <Pill tone="bad">Payment failed</Pill>}
            {row.flagged > 0 && <Pill tone="warn">Flagged</Pill>}
            {`Signed up ${day(row.signedUpAt)} · ${row.locations} location${row.locations === 1 ? "" : "s"}${row.mrrFils ? ` · ${aed(row.mrrFils)} a month` : ""}`}
          </span>
        }
        actions={
          owner ? (
            <Action
              endpoint="/api/sales/customers/view-as"
              body={{ tenantId }}
              label="View as customer (read-only)"
              confirm={`Open ${tenant.name}'s dashboard as ${owner.name || owner.email} sees it. Nothing can be changed while you view, and it ends by itself after 30 minutes.`}
              reason="Why are you opening their dashboard?"
              submitLabel="Open their dashboard"
              navigate="$next"
            />
          ) : undefined
        }
      />

      <div className="staff-grid">
        <div className="staff-stack">
          <section className="panel staff-section" id="locations">
            <div className="panel-head">
              Locations<span className="muted">numbers, WhatsApp and video per location</span>
            </div>
            {locations.length === 0 ? (
              <EmptyState title="No locations yet">The owner has not finished signing up.</EmptyState>
            ) : (
              <div className="table-wrap" tabIndex={0}>
                <table className="staff-table">
                  <thead>
                    <tr>
                      <th>Location</th>
                      <th>Belline number</th>
                      <th>WhatsApp</th>
                      <th>Video receptionist</th>
                    </tr>
                  </thead>
                  <tbody>
                    {locations.map((l) => (
                      <tr key={l.id}>
                        <td style={{ minWidth: 150 }}>
                          <div style={{ fontWeight: 600 }}>{l.name}</div>
                          <div className="sub">
                            {l.archivedAt ? "Archived" : l.subscription?.status === "trialing" ? "On a trial" : l.subscription?.status === "active" ? "Paying" : l.subscription?.status === "cancelled" ? "Cancelled" : "Setting up"}
                            {l.businessPhone ? ` · their phone ${l.businessPhone}` : ""}
                          </div>
                        </td>
                        <td>
                          <NumberCell venueId={l.id} venueName={l.name} bellineNumber={l.bellineNumber?.number ?? ""} via={l.bellineNumber?.via ?? null} market={subscriptionMarket(l.subscription)} />
                        </td>
                        <td>
                          <WhatsAppCell venueId={l.id} venueName={l.name} number={whatsapp.get(l.id) ?? null} ready={whatsappReady} />
                        </td>
                        <td>
                          {!l.embed?.enabled ? (
                            <span className="muted" style={{ fontSize: 12 }}>Website button is off</span>
                          ) : venueAllowlisted(l, video) ? (
                            <VideoAction action="disallow" locationId={l.id} label="Remove video" confirm={`Stop offering the video receptionist on ${l.name}'s website?`} />
                          ) : (
                            <VideoAction action="allow" locationId={l.id} label="Allow video" confirm={`Offer the video receptionist on ${l.name}'s website?`} />
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {whatsappUnavailable && <p className="staff-note" style={{ padding: "0 18px 14px" }}>WhatsApp could not be read: the sales database did not answer.</p>}
          </section>

          <section className="panel staff-section" id="subscription">
            <div className="panel-head">
              Subscription and trial
              {plansOff && <span className="muted">card payments are switched off: plan changes are recorded, nobody is charged</span>}
            </div>
            <div className="staff-body" style={{ display: "grid", gap: 16 }}>
              {locations.filter((l) => l.subscription).length === 0 && <p className="staff-note">No location has a plan or a trial yet.</p>}
              {locations
                .filter((l) => l.subscription)
                .map((l) => {
                  const sub = l.subscription!;
                  const plans = sellablePlans(l);
                  return (
                    <div key={l.id} style={{ display: "grid", gap: 10, paddingBottom: 14, borderBottom: "1px solid var(--bl-rule-soft)" }}>
                      <KeyValues
                        rows={[
                          ["Location", l.name],
                          ["Plan", sub.status === "trialing" ? `Free trial (then ${planNameOf(l)})` : planNameOf(l)],
                          ["Billed", sub.cycle === "annual" ? "Yearly" : "Monthly"],
                          ["Status", sub.status === "trialing" ? "On a trial" : sub.status === "active" ? "Paying" : `Cancelled${sub.cancelledAt ? ` on ${day(sub.cancelledAt)}` : ""}, runs to the end of the period`],
                          ["Trial ends", sub.status === "trialing" ? (sub.trial?.endsOn ? day(sub.trial.endsOn) : "Starts when the location goes live") : undefined],
                          ["Country", MARKETS[subscriptionMarket(sub)].name],
                          ["Extended by staff", sub.trial?.staffExtensions?.length ? sub.trial.staffExtensions.map((e) => `${e.days} days on ${day(e.at)}: ${e.reason}`).join("; ") : undefined],
                        ]}
                      />
                      <div className="staff-row-actions">
                        {sub.status === "trialing" && sub.trial?.endsOn && (
                          <Action
                            endpoint="/api/sales/customers"
                            body={{ tenantId, action: "extend_trial", locationId: l.id }}
                            label="Extend trial"
                            small
                            confirm={`Extend ${l.name}'s free trial beyond ${day(sub.trial.endsOn)}.`}
                            fields={[{ name: "days", label: "Days", type: "number", defaultValue: "14", min: 1, max: 90, required: true }]}
                            reason="Why?"
                            submitLabel="Extend trial"
                          />
                        )}
                        {plans.length > 0 && (
                          <Action
                            endpoint="/api/sales/customers"
                            body={{ tenantId, action: "change_plan", locationId: l.id }}
                            label="Change plan"
                            small
                            confirm={`Record a new plan for ${l.name}. The allowance changes straight away. ${plansOff ? "Card payments are off, so nobody is charged." : "Stripe is not changed from here: update the subscription in Stripe too."}`}
                            fields={[{ name: "productId", label: "Plan", type: "select", options: plans.map((pl) => ({ value: pl.id, label: pl.name })), required: true }]}
                            reason="Why?"
                            submitLabel="Record plan"
                          />
                        )}
                        {sub.status === "active" && (
                          <Action
                            endpoint="/api/sales/customers"
                            body={{ tenantId, action: "cancel", locationId: l.id }}
                            label="Cancel at period end"
                            tone="danger"
                            small
                            confirm={`Cancel ${l.name}'s plan. Service runs to the end of the period it has paid for. Stripe is not changed from here.`}
                            reason="Why?"
                            submitLabel="Cancel plan"
                          />
                        )}
                      </div>
                    </div>
                  );
                })}
              {onTrial && (
                <div className="staff-row-actions">
                  {suspended ? (
                    <Action endpoint="/api/sales/customers" body={{ tenantId, action: "reactivate" }} label="Reactivate trial" tone="primary" small confirm={`Let ${tenant.name}'s free trial answer again.`} reason="Why?" submitLabel="Reactivate" />
                  ) : (
                    <Action endpoint="/api/sales/customers" body={{ tenantId, action: "suspend" }} label="Suspend trial" tone="danger" small confirm={`Stop ${tenant.name}'s free trial: Belline stops answering on it and no paid setup work runs until you reactivate it.`} reason="Why?" submitLabel="Suspend trial" />
                  )}
                  {suspended && <span className="staff-note">Suspended by {tenant.abuse?.trialSuspendedBy} on {day(tenant.abuse?.trialSuspendedAt)}.</span>}
                </div>
              )}
            </div>
          </section>

          <section className="panel staff-section" id="usage">
            <div className="panel-head">Usage and cost, this period</div>
            <div className="staff-body" style={{ display: "grid", gap: 14 }}>
              {locations.length === 0 && <p className="staff-note">Nothing used yet.</p>}
              {locations.map((l) => {
                const u = usageFor(l);
                return (
                  <div key={l.id}>
                    <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
                      {l.name}
                      {u.period && <span className="muted" style={{ fontWeight: 400 }}> · {day(u.period.start)} to {day(u.period.end)}</span>}
                    </div>
                    {u.meters.length === 0 ? (
                      <p className="staff-note">No allowance is counted for this location yet.</p>
                    ) : (
                      <KeyValues rows={u.meters.map((m) => [m.name, `${m.used} of ${m.included ?? "uncounted"} ${m.unit}${m.pct !== null ? ` (${m.pct}%)` : ""}`])} />
                    )}
                    <KeyValues rows={[["What it cost us", aed(u.costFils)]]} />
                  </div>
                );
              })}
            </div>
          </section>

          <section className="panel staff-section" id="flags">
            <div className="panel-head">Issues and flags</div>
            {issues.length === 0 && flags.length === 0 ? (
              <EmptyState title="Nothing open">No issue or signup flag for this customer.</EmptyState>
            ) : (
              <div className="staff-body" style={{ display: "grid", gap: 12 }}>
                {issues.map((i) => (
                  <div key={i.id} style={{ fontSize: 13 }}>
                    <Link href={`/sales/issues?ticket=${encodeURIComponent(i.ticket)}&status=all`} style={{ fontWeight: 600 }}>
                      {i.ticket}: {KIND_META[i.kind].label}
                    </Link>{" "}
                    <Pill tone={i.status === "resolved" ? "ok" : "warn"}>{i.status === "open" ? "Open" : i.status === "waiting_customer" ? "Waiting on them" : "Resolved"}</Pill>
                    <div className="sub">{i.reason}</div>
                  </div>
                ))}
                {flags.map((f) => (
                  <div key={f.id} style={{ display: "grid", gap: 6 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>
                      {FLAG_LABEL[f.kind]} <Pill>{f.status === "open" ? "To review" : f.status}</Pill>
                    </div>
                    <AbuseActions id={f.id} status={f.status} canSuspend />
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <div className="staff-stack">
          <section className="panel staff-section" id="business">
            <div className="panel-head">Business</div>
            <div className="staff-body" style={{ display: "grid", gap: 12 }}>
              <KeyValues
                rows={[
                  ["Name", tenant.name],
                  ["Type", business?.category ?? locations[0]?.vertical],
                  ["Contact email", business?.email ?? owner?.email],
                  ["Phone", business?.phone ?? locations[0]?.businessPhone],
                  ["Website", business?.website],
                  ["Country", row.country ?? undefined],
                  ["Signed up from", tenant.signup?.email],
                ]}
              />
              <Action
                endpoint="/api/sales/customers"
                body={{ tenantId, action: "details" }}
                label="Edit details"
                small
                fields={[
                  { name: "name", label: "Name", type: "text", defaultValue: tenant.name, required: true },
                  { name: "category", label: "Type of business", type: "text", defaultValue: business?.category ?? "", placeholder: "Dental practice" },
                  { name: "email", label: "Contact email", type: "email", defaultValue: business?.email ?? "" },
                  { name: "phone", label: "Phone", type: "tel", defaultValue: business?.phone ?? "" },
                ]}
                submitLabel="Save details"
              />
              <p className="staff-note">The country follows the plan&apos;s market and is not edited here: it sets the prices.</p>
            </div>
          </section>

          <section className="panel staff-section" id="users">
            <div className="panel-head">People</div>
            <div className="staff-body" style={{ display: "grid", gap: 14 }}>
              {users.length === 0 && <p className="staff-note">No one can sign in to this account.</p>}
              {users.map((u) => (
                <div key={u.id} style={{ display: "grid", gap: 6, paddingBottom: 12, borderBottom: "1px solid var(--bl-rule-soft)" }}>
                  <div style={{ fontSize: 13 }}>
                    <strong>{u.name}</strong> <span className="muted">· {u.role === "owner" ? "Owner" : u.role === "manager" ? "Manager" : "Staff"}</span>
                    {u.disabled && (
                      <>
                        {" "}
                        <Pill tone="bad">Disabled</Pill>
                      </>
                    )}
                  </div>
                  <div className="sub">
                    <a href={`mailto:${u.email}`}>{u.email}</a> · {needsEmailVerification(u) ? "email not confirmed" : "email confirmed"} · last signed in {u.lastSeenAt ? ago(u.lastSeenAt) : "never"}
                  </div>
                  <div className="staff-row-actions">
                    {!u.disabled && (
                      <Action endpoint="/api/sales/customers" body={{ tenantId, action: "reset_link", userId: u.id }} label="Password reset link" small confirm={`Make a one-time link for ${u.email} to set a new password. Nothing is emailed: you give it to them.`} submitLabel="Make link" />
                    )}
                    {needsEmailVerification(u) && <Action endpoint="/api/sales/customers" body={{ tenantId, action: "confirm_email", userId: u.id }} label="Mark email confirmed" small confirm={`Mark ${u.email} as confirmed. Only do this once you have checked it is theirs.`} submitLabel="Mark confirmed" />}
                    {u.disabled ? (
                      <Action endpoint="/api/sales/customers" body={{ tenantId, action: "enable_user", userId: u.id }} label="Enable" small confirm={`Let ${u.email} sign in again.`} reason="Why?" submitLabel="Enable" />
                    ) : (
                      <Action endpoint="/api/sales/customers" body={{ tenantId, action: "disable_user", userId: u.id }} label="Disable" tone="danger" small confirm={`Stop ${u.email} signing in. They are signed out everywhere now.`} reason="Why?" submitLabel="Disable" />
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="panel staff-section" id="history">
            <div className="panel-head">Changes by staff</div>
            {history.length === 0 ? (
              <EmptyState title="No changes yet">Every change made on this page is listed here, with who made it and why.</EmptyState>
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {history.map((h) => (
                  <li key={h.id} style={{ padding: "9px 18px", borderTop: "1px solid var(--bl-rule-soft)", fontSize: 12.5 }}>
                    <strong>{h.action.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())}</strong> <span className="muted">by {h.actorName}, {ago(h.at)}</span>
                    {h.reason && <div className="sub">{h.reason}</div>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </>
  );
}

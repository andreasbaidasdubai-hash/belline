import Link from "next/link";
import { requireUser } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import { seedIfEmpty } from "@/lib/seed";
import { getLocation, getTenant, listUsers } from "@/lib/store";
import { listAbuse, venueName } from "@/lib/abuse/review";
import { needsEmailVerification } from "@/lib/email-verify";
import { CUSTOMER_STATUS_LABEL, customerRows, filterCustomers, type CustomerStatus } from "@/lib/staff/customers";
import { FLAG_LABEL } from "@/lib/staff/today";
import { ConsoleHeader, EmptyState, FilterChips, Pill, SearchBox, aed, day } from "../ui";
import AbuseActions, { VerifyButton } from "./AbuseActions";

export const dynamic = "force-dynamic";

/**
 * Every customer, one row per business, and the signups that need a second look.
 *
 * "Flagged signups" is the abuse review that used to be its own page: signups
 * the screening noticed (lib/abuse/review.ts) and owners whose email is not
 * confirmed yet. Allow is the override; suspend stops the free trial.
 */

type Params = { status?: string; view?: string; q?: string; flag?: string };

const STATUSES = Object.keys(CUSTOMER_STATUS_LABEL) as CustomerStatus[];
const FLAG_STATUSES = [
  { id: "open", label: "To review" },
  { id: "noted", label: "Noted" },
  { id: "allowed", label: "Allowed" },
  { id: "suspended", label: "Suspended" },
  { id: "all", label: "All" },
] as const;

function tone(status: CustomerStatus): "ok" | "warn" | "bad" | "accent" | undefined {
  return status === "active" ? "ok" : status === "trial" ? "accent" : status === "suspended" ? "bad" : status === "cancelled" ? "warn" : undefined;
}

export default async function CustomersPage({ searchParams }: { searchParams: Promise<Params> }) {
  seedIfEmpty();
  const user = await requireUser();
  if (!isBellineStaff(user)) return <p className="muted">Belline staff only.</p>;

  const p = await searchParams;
  const flaggedView = p.view === "flagged";
  const all = customerRows();
  const status = STATUSES.includes(p.status as CustomerStatus) ? (p.status as CustomerStatus) : undefined;
  const rows = filterCustomers(all, { status, q: p.q });
  const href = (next: Partial<Params>) => {
    const merged = { status: p.status, view: p.view, q: p.q, ...next };
    const qs = new URLSearchParams(Object.entries(merged).filter(([, v]) => v) as [string, string][]).toString();
    return qs ? `/sales/customers?${qs}` : "/sales/customers";
  };
  const openFlags = listAbuse({ status: "open" }).length;

  return (
    <>
      <ConsoleHeader
        title="Customers"
        subtitle={`${all.length} business${all.length === 1 ? "" : "es"} · ${all.filter((r) => r.status === "active").length} paying · ${all.filter((r) => r.status === "trial").length} on a trial`}
        actions={
          <a href="/api/sales/clients" className="btn">
            Download CSV
          </a>
        }
      />

      <FilterChips
        label="Show"
        items={[
          { label: "All customers", href: href({ view: undefined, flag: undefined }), on: !flaggedView },
          { label: "Flagged signups", href: href({ view: "flagged", status: undefined, q: undefined }), on: flaggedView, count: openFlags },
        ]}
      />

      {flaggedView ? (
        <Flagged status={p.flag} />
      ) : (
        <>
          <FilterChips
            label="Status"
            items={[
              { label: "Any", href: href({ status: undefined }), on: !status },
              ...STATUSES.map((s) => ({ label: CUSTOMER_STATUS_LABEL[s], href: href({ status: s }), on: status === s, count: all.filter((r) => r.status === s).length })),
            ]}
          />
          <SearchBox action="/sales/customers" q={p.q} keep={{ status: p.status }} placeholder="Search business, owner or email" />

          <div className="panel">
            {rows.length === 0 ? (
              all.length === 0 ? (
                <EmptyState title="No customers yet">The first self-serve signup appears here the moment it happens.</EmptyState>
              ) : (
                <EmptyState title="No customer matches" action={<Link href="/sales/customers" className="btn btn-row">Clear filters</Link>} />
              )
            ) : (
              <div className="table-wrap" tabIndex={0}>
                <table className="staff-table">
                  <thead>
                    <tr>
                      <th>Business</th>
                      <th>Owner</th>
                      <th>Plan</th>
                      <th>Status</th>
                      <th>Trial ends</th>
                      <th className="num">Usage</th>
                      <th className="num">Monthly</th>
                      <th>Country</th>
                      <th>Signed up</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.tenantId}>
                        <td style={{ minWidth: 180 }}>
                          <Link href={`/sales/customers/${encodeURIComponent(r.tenantId)}`} style={{ fontWeight: 600 }}>
                            {r.name}
                          </Link>
                          <div className="sub">
                            {r.locations} location{r.locations === 1 ? "" : "s"}
                            {r.openIssues ? ` · ${r.openIssues} open issue${r.openIssues === 1 ? "" : "s"}` : ""}
                            {r.flagged ? ` · flagged` : ""}
                          </div>
                        </td>
                        <td style={{ fontSize: 12.5 }}>
                          {r.owner ? (
                            <>
                              <div>{r.owner.name}</div>
                              <a href={`mailto:${r.owner.email}`} className="sub">
                                {r.owner.email}
                              </a>
                            </>
                          ) : (
                            <span className="muted">No owner</span>
                          )}
                        </td>
                        <td style={{ fontSize: 12.5 }}>{r.plan}</td>
                        <td>
                          <Pill tone={r.paymentFailed ? "bad" : tone(r.status)}>{r.paymentFailed ? "Payment failed" : CUSTOMER_STATUS_LABEL[r.status]}</Pill>
                        </td>
                        <td style={{ fontSize: 12.5, whiteSpace: "nowrap" }}>{r.trialEndsOn ? day(r.trialEndsOn) : <span className="muted">—</span>}</td>
                        <td className="num">{r.usagePct === null ? <span className="muted">—</span> : `${r.usagePct}%`}</td>
                        <td className="num">{r.mrrFils ? aed(r.mrrFils) : <span className="muted">—</span>}</td>
                        <td style={{ fontSize: 12.5 }}>{r.country ?? <span className="muted">—</span>}</td>
                        <td style={{ fontSize: 12.5, whiteSpace: "nowrap" }}>{day(r.signedUpAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}

function Flagged({ status }: { status?: string }) {
  const current = FLAG_STATUSES.find((s) => s.id === status)?.id ?? "open";
  const rows = listAbuse({ status: current });
  const unconfirmed = listUsers().filter((u) => needsEmailVerification(u) && !u.disabled);

  return (
    <>
      <FilterChips
        label="Decision"
        items={FLAG_STATUSES.map((s) => ({ label: s.label, href: `/sales/customers?view=flagged&flag=${s.id}`, on: current === s.id }))}
      />
      <div className="panel" style={{ marginBottom: 18 }}>
        {rows.length === 0 ? (
          <EmptyState title="Nothing to review">No signup on this filter looks like a second free trial.</EmptyState>
        ) : (
          <div className="table-wrap" tabIndex={0}>
            <table className="staff-table">
              <thead>
                <tr>
                  <th>What</th>
                  <th>Who</th>
                  <th>Matched</th>
                  <th>Notes</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const tenant = r.tenantId ? getTenant(r.tenantId) : undefined;
                  const who = venueName(r.locationId) ?? tenant?.name;
                  const matched = r.match ? getLocation(r.match.locationId) : undefined;
                  return (
                    <tr key={r.id} data-abuse={r.kind}>
                      <td>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>{FLAG_LABEL[r.kind]}</div>
                        <div className="sub">
                          {day(r.lastAt)}
                          {r.count > 1 ? ` · seen ${r.count} times` : ""}
                        </div>
                        <Pill>{r.status === "open" ? "To review" : r.status.replace(/^./, (c) => c.toUpperCase())}</Pill>
                      </td>
                      <td style={{ fontSize: 12.5 }}>
                        {who && tenant ? (
                          <Link href={`/sales/customers/${encodeURIComponent(tenant.id)}`} style={{ fontWeight: 600 }}>
                            {who}
                          </Link>
                        ) : (
                          who && <div style={{ fontWeight: 600 }}>{who}</div>
                        )}
                        {r.email && <div>{r.email}</div>}
                        {(r.ip ?? tenant?.signup?.ip) && <div className="sub">Network {r.ip ?? tenant?.signup?.ip}</div>}
                        {tenant?.abuse?.allowedAt && <div style={{ color: "var(--bl-success)" }}>Allowed by {tenant.abuse.allowedBy}</div>}
                        {tenant?.abuse?.trialSuspendedAt && <div style={{ color: "var(--bl-danger)" }}>Trial suspended by {tenant.abuse.trialSuspendedBy}</div>}
                      </td>
                      <td style={{ fontSize: 12.5 }}>
                        {r.match ? (
                          <>
                            <div>
                              Same {r.match.by === "domain" ? "website" : r.match.by}: {r.match.value}
                            </div>
                            <div className="sub">
                              {matched?.name ?? r.match.name} ({matched?.subscription?.status === "trialing" ? "on a trial" : matched?.subscription?.status ?? "account gone"})
                            </div>
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td style={{ fontSize: 12, maxWidth: 260 }}>
                        {r.notes.map((n) => (
                          <div key={n.at} style={{ marginBottom: 4 }}>
                            <span className="muted">{n.by}:</span> {n.text}
                          </div>
                        ))}
                      </td>
                      <td>
                        <AbuseActions id={r.id} status={r.status} canSuspend={Boolean(r.tenantId)} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel staff-section">
        <div className="panel-head">Emails not confirmed</div>
        {unconfirmed.length === 0 ? (
          <EmptyState title="All confirmed">Every self-serve owner has confirmed their email.</EmptyState>
        ) : (
          <div className="table-wrap" tabIndex={0}>
            <table className="staff-table">
              <thead>
                <tr>
                  <th>Owner</th>
                  <th>Signed up</th>
                  <th className="num">Codes sent</th>
                  <th>
                    <span className="sr-only">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {unconfirmed.map((u) => (
                  <tr key={u.id}>
                    <td style={{ fontSize: 12.5 }}>
                      <div style={{ fontWeight: 600 }}>{u.name}</div>
                      <div>{u.email}</div>
                    </td>
                    <td style={{ fontSize: 12.5 }}>{day(u.createdAt)}</td>
                    <td className="num">{u.emailVerification?.sends?.length ?? 0}</td>
                    <td>
                      <VerifyButton userId={u.id} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

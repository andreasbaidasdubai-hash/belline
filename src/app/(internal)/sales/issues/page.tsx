import Link from "next/link";
import { requireUser } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import { getLocation, getTenant, listUsersFor } from "@/lib/store";
import { EXCEPTION_KINDS, KIND_META, isExceptionKind, listExceptions, type ExceptionFilter } from "@/lib/exceptions";
import { seedIfEmpty } from "@/lib/seed";
import { ConsoleHeader, EmptyState, FilterChips, KeyValues, Pill, SearchBox, ago } from "../ui";
import ExceptionActions from "./ExceptionActions";

export const dynamic = "force-dynamic";

/**
 * Customers a person has to help.
 *
 * Every row says why it was opened, what to do next and who to contact, and
 * cannot be resolved without a note and the minutes it took: the human-touch
 * metric self-serve is measured on. What the system recorded about it is shown
 * as labelled lines, never as raw data. Staff only, checked here as well as in
 * the layout.
 */

const STATUSES = [
  { id: "unresolved", label: "Open" },
  { id: "waiting_customer", label: "Waiting on them" },
  { id: "resolved", label: "Resolved" },
  { id: "all", label: "All" },
] as const;

/** Words for the context keys the system writes. Anything else is shown with its key made readable. */
const CONTEXT_LABEL: Record<string, string> = {
  email: "Email",
  name: "Name",
  userId: "Account",
  endsOn: "Trial ends",
  extendedFrom: "Was due to end",
  day: "Day",
  number: "Number",
  phone: "Phone",
  reason: "Reason",
  error: "Error",
  attempts: "Attempts",
  url: "Address",
  pool: "Allowance",
};

function contextRows(context: Record<string, unknown>): [string, React.ReactNode][] {
  return Object.entries(context)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .slice(0, 12)
    .map(([k, v]) => {
      const label = CONTEXT_LABEL[k] ?? k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
      const value =
        typeof v === "string" || typeof v === "number" || typeof v === "boolean"
          ? String(v === true ? "yes" : v === false ? "no" : v)
          : Array.isArray(v)
            ? v.map((x) => (typeof x === "object" ? Object.values(x as object).join(" ") : String(x))).join(", ")
            : Object.entries(v as Record<string, unknown>).map(([a, b]) => `${a}: ${String(b)}`).join(", ");
      return [label, value.slice(0, 300)];
    });
}

export default async function IssuesPage({ searchParams }: { searchParams: Promise<{ status?: string; kind?: string; q?: string; ticket?: string }> }) {
  seedIfEmpty();
  const user = await requireUser();
  if (!isBellineStaff(user)) return <p className="muted">Belline staff only.</p>;

  const p = await searchParams;
  const status = STATUSES.some((s) => s.id === p.status) ? (p.status as ExceptionFilter["status"]) : p.ticket ? "all" : "unresolved";
  const filter: ExceptionFilter = { status, ...(isExceptionKind(p.kind) ? { kind: p.kind } : {}) };
  const q = (p.q ?? p.ticket ?? "").trim().toLowerCase();
  const rows = listExceptions(filter).filter((r) => {
    if (!q) return true;
    const tenant = getTenant(r.tenantId);
    return [r.ticket, r.reason, tenant?.name, getLocation(r.locationId ?? "")?.name].some((v) => v?.toLowerCase().includes(q));
  });
  const resolved = listExceptions({ status: "resolved" });
  const minutes = resolved.reduce((n, r) => n + (r.humanMinutes ?? 0), 0);
  const kindsSeen = EXCEPTION_KINDS.filter((k) => listExceptions({ status: "all", kind: k }).length > 0);
  const href = (next: { status?: string; kind?: string }) => {
    const merged = { status: filter.status, kind: filter.kind, q: p.q, ...next };
    const qs = new URLSearchParams(Object.entries(merged).filter(([, v]) => v) as [string, string][]).toString();
    return `/sales/issues${qs ? `?${qs}` : ""}`;
  };

  return (
    <>
      <ConsoleHeader title="Issues" subtitle={`${rows.length} shown · ${resolved.length} resolved so far, taking ${minutes} minutes of people's time`} />

      <FilterChips label="Status" items={STATUSES.map((s) => ({ label: s.label, href: href({ status: s.id }), on: filter.status === s.id }))} />
      {kindsSeen.length > 0 && (
        <FilterChips
          label="Kind"
          items={[{ label: "Any", href: href({ kind: undefined }), on: !filter.kind }, ...kindsSeen.map((k) => ({ label: KIND_META[k].label, href: href({ kind: k }), on: filter.kind === k }))]}
        />
      )}
      <SearchBox action="/sales/issues" q={p.q ?? p.ticket} keep={{ status: filter.status, kind: filter.kind }} placeholder="Search ticket, customer or reason" />

      <div className="panel">
        {rows.length === 0 ? (
          <EmptyState title="Nothing here">Every customer on this filter is getting on without a person.</EmptyState>
        ) : (
          <div className="table-wrap" tabIndex={0}>
            <table className="staff-table">
              <thead>
                <tr>
                  <th>Ticket</th>
                  <th>Customer</th>
                  <th>Why, and what next</th>
                  <th>What the system recorded</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const venue = r.locationId ? getLocation(r.locationId) : undefined;
                  const tenant = getTenant(r.tenantId);
                  const owner = listUsersFor(r.tenantId).find((u) => u.role === "owner");
                  const contact = typeof r.context.email === "string" ? r.context.email : owner?.email;
                  const meta = KIND_META[r.kind];
                  return (
                    <tr key={r.id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{r.ticket}</div>
                        <div className="sub">
                          {ago(r.openedAt)} · from {r.source === "belle" ? "Belle" : r.source === "owner" ? "the owner" : "the system"}
                          {r.count > 1 ? ` · raised ${r.count} times` : ""}
                        </div>
                        <Pill tone={r.status === "resolved" ? "ok" : r.status === "open" ? "warn" : undefined}>{r.status === "open" ? "Open" : r.status === "waiting_customer" ? "Waiting on them" : "Resolved"}</Pill>
                      </td>
                      <td style={{ minWidth: 150 }}>
                        {tenant && !tenant.internal ? (
                          <Link href={`/sales/customers/${encodeURIComponent(tenant.id)}`} style={{ fontWeight: 600 }}>
                            {venue?.name ?? tenant.name}
                          </Link>
                        ) : (
                          <div style={{ fontWeight: 600 }}>{venue?.name ?? tenant?.name ?? "Unknown customer"}</div>
                        )}
                        {contact && (
                          <div>
                            <a href={`mailto:${contact}`} className="sub">
                              {contact}
                            </a>
                          </div>
                        )}
                      </td>
                      <td style={{ maxWidth: 360 }}>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>{meta.label}</div>
                        <div style={{ fontSize: 13, marginTop: 2 }}>{r.reason}</div>
                        <div className="sub" style={{ marginTop: 6 }}>
                          Next: {meta.next}
                        </div>
                        {r.resolution && (
                          <div style={{ fontSize: 12, marginTop: 6, color: "var(--bl-success)" }}>
                            {r.resolvedBy}: {r.resolution} ({r.humanMinutes ?? 0} min)
                          </div>
                        )}
                      </td>
                      <td style={{ maxWidth: 300 }}>
                        <KeyValues rows={contextRows(r.context)} />
                      </td>
                      <td>{r.status !== "resolved" && <ExceptionActions id={r.id} waiting={r.status === "waiting_customer"} />}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

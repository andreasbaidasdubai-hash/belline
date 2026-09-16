import Link from "next/link";
import { requireUser } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import { PageHeader } from "@/components/LocationTabs";
import { getLocation, getTenant, listUsersFor } from "@/lib/store";
import { EXCEPTION_KINDS, KIND_META, isExceptionKind, listExceptions, type ExceptionFilter } from "@/lib/exceptions";
import { seedIfEmpty } from "@/lib/seed";
import ExceptionActions from "./ExceptionActions";

export const dynamic = "force-dynamic";

/**
 * Customers a person has to help.
 *
 * Every row says why it was opened, what to do next and who to contact, and
 * cannot be closed without a note and the minutes it took — the human-touch
 * metric self-serve is measured on. Staff only, checked here as well as in
 * the layout.
 */

const STATUSES = [
  { id: "unresolved", label: "Open" },
  { id: "waiting_customer", label: "Waiting" },
  { id: "resolved", label: "Resolved" },
  { id: "all", label: "All" },
] as const;

export default async function ExceptionsPage({ searchParams }: { searchParams: Promise<{ status?: string; kind?: string }> }) {
  seedIfEmpty();
  const user = await requireUser();
  if (!isBellineStaff(user)) return <p className="muted">Not available.</p>;

  const { status, kind } = await searchParams;
  const filter: ExceptionFilter = {
    status: STATUSES.some((s) => s.id === status) ? (status as ExceptionFilter["status"]) : "unresolved",
    ...(isExceptionKind(kind) ? { kind } : {}),
  };
  const rows = listExceptions(filter);
  const resolved = listExceptions({ status: "resolved" });
  const minutes = resolved.reduce((n, r) => n + (r.humanMinutes ?? 0), 0);
  const href = (s: string, k?: string) => `/sales/exceptions?status=${s}${k ? `&kind=${k}` : ""}`;

  return (
    <>
      <PageHeader
        title="Exceptions"
        subtitle={`${rows.length} shown · ${minutes} human minutes on ${resolved.length} resolved`}
      />

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14, alignItems: "center" }}>
        {STATUSES.map((s) => (
          <Link key={s.id} href={href(s.id, filter.kind)} className={`btn${filter.status === s.id ? " btn-accent" : ""}`}>
            {s.label}
          </Link>
        ))}
        <form method="get" style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
          <input type="hidden" name="status" value={filter.status} />
          <select name="kind" defaultValue={filter.kind ?? ""} aria-label="Kind">
            <option value="">Every kind</option>
            {EXCEPTION_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_META[k].label}
              </option>
            ))}
          </select>
          <button className="btn" type="submit">
            Filter
          </button>
        </form>
      </div>

      <div className="panel">
        {rows.length === 0 ? (
          <p className="muted" style={{ padding: "26px 16px", fontSize: 13, margin: 0 }}>
            Nothing here. Every customer on this filter is getting on without a person.
          </p>
        ) : (
          <div className="table-wrap" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>Ticket</th>
                  <th style={{ textAlign: "left" }}>Customer</th>
                  <th style={{ textAlign: "left" }}>Why, and what next</th>
                  <th style={{ textAlign: "left" }}>Context</th>
                  <th />
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
                    <tr key={r.id} style={{ verticalAlign: "top" }}>
                      <td>
                        <div className="mono" style={{ fontWeight: 600 }}>
                          {r.ticket}
                        </div>
                        <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>
                          {r.openedAt.slice(0, 16).replace("T", " ")} · {r.source}
                          {r.count > 1 ? ` · raised ${r.count}×` : ""}
                        </div>
                        <span className="pill" style={{ marginTop: 6, display: "inline-block" }}>
                          {r.status.replace("_", " ")}
                        </span>
                      </td>
                      <td>
                        <div style={{ fontWeight: 600 }}>{venue?.name ?? tenant?.name ?? r.tenantId}</div>
                        {contact && (
                          <a href={`mailto:${contact}`} className="muted" style={{ fontSize: 11.5 }}>
                            {contact}
                          </a>
                        )}
                        <div style={{ fontSize: 11.5, marginTop: 4 }}>
                          <Link href="/sales/clients">Clients</Link>
                        </div>
                      </td>
                      <td style={{ maxWidth: 360 }}>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>{meta.label}</div>
                        <div style={{ fontSize: 13, marginTop: 2 }}>{r.reason}</div>
                        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                          Next: {meta.next}
                        </div>
                        {r.resolution && (
                          <div style={{ fontSize: 12, marginTop: 6, color: "var(--ok)" }}>
                            {r.resolvedBy}: {r.resolution} ({r.humanMinutes ?? 0} min)
                          </div>
                        )}
                      </td>
                      <td style={{ maxWidth: 280 }}>
                        <pre className="mono" style={{ margin: 0, fontSize: 11, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                          {JSON.stringify(r.context, null, 1).slice(0, 800)}
                        </pre>
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

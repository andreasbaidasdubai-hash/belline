import Link from "next/link";
import type { ActivityRow } from "@/lib/sales/kpi/overview";

/**
 * The staff console's shared parts: one header, one filter chip, one empty
 * state, one stat tile. Every console page uses these rather than its own, so
 * the pages read as one tool. Styles are the `.staff-*` rules in globals.css,
 * on the `--bl-*` tokens.
 */

export function ConsoleHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <header className="staff-head">
      <div style={{ minWidth: 0 }}>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="staff-head-actions">{actions}</div>}
    </header>
  );
}

export interface ChipItem {
  label: string;
  href: string;
  on: boolean;
  count?: number;
}

/** A row of filter chips. Links, so a filter is a URL that can be shared and bookmarked. */
export function FilterChips({ label, items }: { label: string; items: ChipItem[] }) {
  return (
    <div className="staff-chips" role="group" aria-label={label}>
      <span className="staff-chips-label">{label}</span>
      {items.map((item) => (
        <Link key={item.href + item.label} href={item.href} className={`staff-chip${item.on ? " on" : ""}`} aria-current={item.on ? "true" : undefined}>
          {item.label}
          {item.count !== undefined && <span className="staff-chip-count">{item.count}</span>}
        </Link>
      ))}
    </div>
  );
}

/** A search box that keeps the other filters. */
export function SearchBox({ action, q, keep, placeholder }: { action: string; q?: string; keep: Record<string, string | undefined>; placeholder: string }) {
  return (
    <form method="get" action={action} className="staff-search" role="search">
      {Object.entries(keep)
        .filter(([, v]) => v)
        .map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
      <input type="search" name="q" defaultValue={q ?? ""} placeholder={placeholder} aria-label={placeholder} />
      <button className="btn btn-row" type="submit">
        Search
      </button>
    </form>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="staff-empty">
      <div className="staff-empty-title">{title}</div>
      {children && <div className="staff-empty-body">{children}</div>}
      {action && <div style={{ marginTop: 12 }}>{action}</div>}
    </div>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "ok" | "warn" }) {
  return (
    <div className="panel staff-stat">
      <div className="staff-stat-label">{label}</div>
      <div className={`staff-stat-value${tone ? ` ${tone}` : ""}`}>{value}</div>
      {hint && <div className="staff-stat-hint">{hint}</div>}
    </div>
  );
}

/** Label and value lines. Never raw JSON. */
export function KeyValues({ rows }: { rows: [string, React.ReactNode][] }) {
  const shown = rows.filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (shown.length === 0) return null;
  return (
    <dl className="staff-kv">
      {shown.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Pill({ children, tone }: { children: React.ReactNode; tone?: "ok" | "warn" | "bad" | "accent" }) {
  return <span className={`pill staff-pill${tone ? ` ${tone}` : ""}`}>{children}</span>;
}

/** Money on every console page is AED. */
export function aed(fils: number): string {
  return `AED ${Math.round(fils / 100).toLocaleString("en-AE")}`;
}

export function ago(at: Date | string | undefined | null): string {
  if (!at) return "";
  const then = typeof at === "string" ? new Date(at) : at;
  if (Number.isNaN(then.getTime())) return "";
  const seconds = Math.round((Date.now() - then.getTime()) / 1000);
  if (seconds < 0) return then.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)} d ago`;
  return then.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function day(at: string | undefined | null): string {
  if (!at) return "";
  const d = new Date(at.length === 10 ? `${at}T12:00:00Z` : at);
  return Number.isNaN(d.getTime()) ? at : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/**
 * Colour by consequence, not by category: something left the building, or
 * something came back. Everything else is progress.
 */
const ACTIVITY_TONE: Record<string, string> = {
  sent: "var(--bl-indigo)",
  replied: "var(--bl-success)",
  demo_used: "var(--bl-success)",
  agent_paused: "var(--bl-warning)",
  error: "var(--bl-warning)",
};

const ACTIVITY_WORDS: Record<string, string> = {
  discovered: "Found",
  researched: "Website read",
  scored: "Scored",
  drafted: "Email drafted",
  approved: "Draft approved",
  rejected: "Draft rejected",
  demo_issued: "Demo built",
  demo_used: "Demo used",
  agent_paused: "Agent paused",
  error: "Problem",
  sent: "Sent by hand",
  stage_changed: "Stage changed",
};

export function ActivityFeed({ rows, empty }: { rows: ActivityRow[]; empty: string }) {
  if (rows.length === 0) return <EmptyState title="Nothing yet">{empty}</EmptyState>;
  return (
    <div className="table-wrap">
      <table>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td style={{ width: 4, padding: 0 }}>
                <div style={{ width: 3, height: 30, borderRadius: 2, background: ACTIVITY_TONE[row.type] ?? "var(--bl-rule)" }} />
              </td>
              <td>
                <div style={{ fontSize: 13 }}>
                  {row.lead_id ? <Link href={`/sales/leads/${encodeURIComponent(`db:${row.lead_id}`)}`}>{row.summary}</Link> : row.summary}
                </div>
                <div className="muted" style={{ fontSize: 11.5, marginTop: 3 }}>
                  {ACTIVITY_WORDS[row.type] ?? row.type.replace(/_/g, " ")}
                  {row.company_name ? ` · ${row.company_name}` : ""}
                  {row.agent_name ? ` · ${row.agent_name}` : ""}
                  {" · "}
                  {row.actor.startsWith("user:") ? "a person" : row.actor.startsWith("agent:") ? "an agent" : "the system"}
                </div>
              </td>
              <td className="muted" style={{ width: 110, textAlign: "right", fontSize: 11.5, whiteSpace: "nowrap" }}>
                {ago(row.at)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

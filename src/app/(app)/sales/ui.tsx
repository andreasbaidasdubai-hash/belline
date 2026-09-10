import Link from "next/link";
import type { ActivityRow } from "@/lib/sales/kpi/overview";

/** Shared bits of the sales dashboard. Matches the venue pages' visual language. */

export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "ok" | "warn";
}) {
  return (
    <div className="panel" style={{ padding: "16px 18px" }}>
      <div
        className="muted"
        style={{
          fontSize: 10.5,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          fontWeight: 600,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 31,
          fontWeight: 300,
          marginTop: 9,
          letterSpacing: "-0.03em",
          fontVariantNumeric: "tabular-nums",
          color: tone === "ok" ? "var(--ok)" : tone === "warn" ? "var(--warn)" : "var(--text)",
        }}
      >
        {value}
      </div>
      {hint && (
        <div className="muted" style={{ fontSize: 11.5, marginTop: 5 }}>
          {hint}
        </div>
      )}
    </div>
  );
}

export function statusTone(status: string): React.CSSProperties {
  if (status === "active") return { color: "var(--ok)", borderColor: "var(--ok)" };
  if (status === "paused") return { color: "var(--warn)", borderColor: "var(--warn)" };
  return {};
}

/**
 * Colour by consequence, not by category.
 *
 * The two that matter at a glance are "something left the building" and
 * "something came back" — a sent message is irreversible and a reply is the
 * only event that actually moves a deal. Everything else is progress noise.
 */
const ACTIVITY_TONE: Record<string, string> = {
  sent: "var(--accent)",
  replied: "var(--ok)",
  meeting_booked: "var(--ok)",
  demo_used: "var(--ok)",
  suppressed: "var(--warn)",
  agent_paused: "var(--warn)",
  error: "var(--warn)",
};

export function ActivityFeed({ rows, empty }: { rows: ActivityRow[]; empty: string }) {
  if (rows.length === 0) {
    return (
      <p className="muted" style={{ padding: "26px 16px", fontSize: 13, margin: 0 }}>
        {empty}
      </p>
    );
  }
  return (
    <table>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            <td style={{ width: 4, padding: 0 }}>
              <div
                style={{
                  width: 3,
                  height: 30,
                  borderRadius: 2,
                  background: ACTIVITY_TONE[row.type] ?? "var(--border)",
                }}
              />
            </td>
            <td>
              <div style={{ fontSize: 13 }}>
                {row.lead_id ? (
                  <Link href={`/sales/leads/${row.lead_id}`}>{row.summary}</Link>
                ) : (
                  row.summary
                )}
              </div>
              <div className="muted" style={{ fontSize: 11.5, marginTop: 3 }}>
                {row.type.replace(/_/g, " ")}
                {row.company_name ? ` · ${row.company_name}` : ""}
                {row.agent_name ? ` · ${row.agent_name}` : ""}
                {" · "}
                {/* The actor is the point of an audit trail: whether a person
                    or an agent did this is the first question anyone asks. */}
                {row.actor.startsWith("user:") ? "you" : row.actor.startsWith("agent:") ? "agent" : row.actor}
              </div>
            </td>
            <td
              className="muted mono"
              style={{ width: 132, textAlign: "right", fontSize: 11.5, whiteSpace: "nowrap" }}
            >
              {relative(row.at)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function relative(at: Date | string): string {
  const then = typeof at === "string" ? new Date(at) : at;
  const seconds = Math.round((Date.now() - then.getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return then.toLocaleDateString();
}

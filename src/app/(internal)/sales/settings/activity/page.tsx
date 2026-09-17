import { requireUser } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import { agentSummaries, recentActivity, setupState } from "@/lib/sales/kpi/overview";
import { listAudit } from "@/lib/staff/audit";
import Setup from "../../Setup";
import { ActivityFeed, ConsoleHeader, EmptyState, FilterChips, ago } from "../../ui";
import SettingsTabs from "../SettingsTabs";

export const dynamic = "force-dynamic";

/**
 * The record of what was done, and by whom: every action the AI sales agents
 * took, and every change staff made in this console. Append-only.
 */

/**
 * Only the agent actions something actually writes. A filter that can never
 * match reads as "none yet" rather than "this cannot happen". `sent` is
 * written when a person marks a draft as sent by hand.
 */
const TYPES = ["discovered", "researched", "scored", "drafted", "approved", "rejected", "sent", "demo_issued", "demo_used", "agent_paused", "error"];

const TYPE_LABEL: Record<string, string> = {
  discovered: "Found",
  researched: "Website read",
  scored: "Scored",
  drafted: "Drafted",
  approved: "Approved",
  rejected: "Rejected",
  sent: "Sent by hand",
  demo_issued: "Demo built",
  demo_used: "Demo used",
  agent_paused: "Paused",
  error: "Problems",
};

export default async function ActivityPage({ searchParams }: { searchParams: Promise<{ agent?: string; type?: string; view?: string }> }) {
  const user = await requireUser();
  if (!isBellineStaff(user)) return <p className="muted">Belline staff only.</p>;

  const { agent, type, view } = await searchParams;
  const staffView = view === "staff";
  const state = await setupState();
  const agentId = agent ? Number(agent) : undefined;
  const [rows, agents] =
    state === "ready" && !staffView
      ? await Promise.all([recentActivity(200, { agentId: Number.isFinite(agentId) ? agentId : undefined, type: TYPES.includes(type ?? "") ? type : undefined }), agentSummaries()])
      : [[], []];
  const audit = staffView ? listAudit({ limit: 200 }) : [];

  const href = (next: { agent?: string; type?: string; view?: string }) => {
    const merged = { agent, type, view, ...next };
    const qs = new URLSearchParams(Object.entries(merged).filter(([, v]) => v) as [string, string][]).toString();
    return `/sales/settings/activity${qs ? `?${qs}` : ""}`;
  };

  return (
    <>
      <ConsoleHeader title="Settings" subtitle="Everything the agents did and everything staff changed. Nothing here is ever edited or removed." />
      <SettingsTabs active="/sales/settings/activity" />

      <FilterChips
        label="Whose"
        items={[
          { label: "AI sales agents", href: href({ view: undefined }), on: !staffView },
          { label: "Staff changes", href: href({ view: "staff", agent: undefined, type: undefined }), on: staffView },
        ]}
      />

      {staffView ? (
        <div className="panel">
          {audit.length === 0 ? (
            <EmptyState title="No staff changes yet">Every change made in the console is listed here with who made it and why.</EmptyState>
          ) : (
            <div className="table-wrap" tabIndex={0}>
              <table className="staff-table">
                <thead>
                  <tr>
                    <th>What</th>
                    <th>Who</th>
                    <th>Why</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.map((a) => (
                    <tr key={a.id}>
                      <td style={{ fontSize: 13 }}>
                        {a.action.replace(/_/g, " ").replace(/^./, (ch) => ch.toUpperCase())}
                        <div className="sub">
                          {a.entity} {a.entityId}
                        </div>
                      </td>
                      <td style={{ fontSize: 12.5 }}>{a.actorName}</td>
                      <td style={{ fontSize: 12.5, maxWidth: 320 }}>{a.reason ?? <span className="muted">—</span>}</td>
                      <td className="muted" style={{ fontSize: 12, whiteSpace: "nowrap" }} title={a.at}>
                        {ago(a.at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : state !== "ready" ? (
        <Setup state={state} />
      ) : (
        <>
          <FilterChips
            label="Agent"
            items={[
              { label: "All agents", href: href({ agent: undefined }), on: !agent },
              ...agents.filter((a) => a.kind === "vertical_agent").map((a) => ({ label: a.name.replace(/ Agent$/, ""), href: href({ agent: String(a.id) }), on: agent === String(a.id) })),
            ]}
          />
          <FilterChips label="Action" items={[{ label: "Everything", href: href({ type: undefined }), on: !type }, ...TYPES.map((t) => ({ label: TYPE_LABEL[t], href: href({ type: t }), on: type === t }))]} />
          <div className="panel">
            <ActivityFeed rows={rows} empty={agent || type ? "Nothing matches that filter." : "The agents have not done anything yet. Run one from AI sales agents."} />
          </div>
        </>
      )}
    </>
  );
}

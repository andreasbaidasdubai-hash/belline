import Link from "next/link";
import { requireUser } from "@/lib/auth-server";
import { canManageUsers } from "@/lib/auth";
import { PageHeader } from "@/components/LocationTabs";
import {
  agentSummaries,
  asTree,
  pipelineCounts,
  queueHealth,
  recentActivity,
  setupState,
  spendByCategory,
  STAGE_ORDER,
  type AgentSummary,
} from "@/lib/sales/kpi/overview";
import { recentRuns } from "@/lib/sales/kpi/leads";
import Setup from "./Setup";
import { ActivityFeed, Stat, statusTone } from "./ui";

export const dynamic = "force-dynamic";

/**
 * The Sales Director's view: every agent, what the queue is doing, what it is
 * all costing. Sales-side, so it sits behind the owner check rather than in a
 * venue manager's sidebar.
 */
export default async function SalesOverview() {
  const user = await requireUser();
  if (!canManageUsers(user)) {
    return <p className="muted">The sales engine is owner-only.</p>;
  }

  const state = await setupState();
  if (state !== "ready") {
    return (
      <>
        <PageHeader
          title="Sales engine"
          subtitle="Autonomous prospecting across UAE, Saudi Arabia and Switzerland."
        />
        <Setup state={state} />
      </>
    );
  }

  const [agents, queue, activity, spend, stages, runs] = await Promise.all([
    agentSummaries(),
    queueHealth(),
    recentActivity(12),
    spendByCategory(30),
    pipelineCounts(),
    recentRuns(8),
  ]);

  const workers = agents.filter((a) => a.kind === "vertical_agent");
  const active = workers.filter((a) => a.status === "active").length;
  const pendingApproval = agents.reduce((n, a) => n + a.pending_approval, 0);
  const totalLeads = workers.reduce((n, a) => n + a.leads, 0);
  const totalQualified = workers.reduce((n, a) => n + a.qualified, 0);
  const totalMeetings = workers.reduce((n, a) => n + a.meetings, 0);
  const spentMonth = spend.reduce((n, s) => n + Number(s.amount_usd), 0);
  const stageMap = new Map(stages.map((s) => [s.stage, s.n]));

  return (
    <>
      <PageHeader
        title="Sales engine"
        subtitle={`${workers.length} vertical agent${workers.length === 1 ? "" : "s"} across ${
          new Set(workers.map((a) => a.country_code)).size
        } countries · ${active} active`}
        right={
          pendingApproval > 0 ? (
            <Link href="/sales/approvals" className="btn btn-accent">
              Review {pendingApproval} message{pendingApproval === 1 ? "" : "s"}
            </Link>
          ) : undefined
        }
      />

      <div className="stats">
        <Stat label="Leads" value={String(totalLeads)} hint="all agents" />
        <Stat
          label="Qualified"
          value={String(totalQualified)}
          hint={totalLeads ? `${Math.round((totalQualified / totalLeads) * 100)}% of leads` : "none yet"}
          tone={totalQualified > 0 ? "ok" : undefined}
        />
        <Stat
          label="Awaiting approval"
          value={String(pendingApproval)}
          hint="drafted, not sent"
          tone={pendingApproval > 0 ? "warn" : undefined}
        />
        <Stat label="Meetings" value={String(totalMeetings)} hint="booked" />
        <Stat
          label="Spend"
          value={`$${spentMonth.toFixed(2)}`}
          hint="this month, all agents"
        />
      </div>

      <div className="split">
        <div className="panel">
          <div className="panel-head">Agents</div>
          {workers.length === 0 ? (
            <p className="muted" style={{ padding: "26px 16px", fontSize: 13, margin: 0 }}>
              No vertical agents yet.
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>Agent</th>
                  <th style={{ textAlign: "right", width: 60 }}>Leads</th>
                  <th style={{ textAlign: "right", width: 70 }}>Qual.</th>
                  <th style={{ textAlign: "right", width: 78 }}>Today</th>
                  <th style={{ width: 92 }} />
                </tr>
              </thead>
              <tbody>
                {asTree(agents).map(({ agent, depth }) => (
                  <AgentRow key={agent.id} agent={agent} depth={depth} />
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="panel">
          <div className="panel-head">
            Pipeline
            <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>
              {totalLeads} lead{totalLeads === 1 ? "" : "s"}
            </span>
          </div>
          {totalLeads === 0 ? (
            <p className="muted" style={{ padding: "26px 16px", fontSize: 13, margin: 0 }}>
              Nothing in the pipeline. Import companies to get started — the CRM
              stages fill in as agents work through them.
            </p>
          ) : (
            <table>
              <tbody>
                {STAGE_ORDER.filter((s) => (stageMap.get(s) ?? 0) > 0).map((stage) => {
                  const n = stageMap.get(stage) ?? 0;
                  return (
                    <tr key={stage}>
                      <td style={{ textTransform: "capitalize" }}>{stage.replace(/_/g, " ")}</td>
                      <td style={{ width: 160 }}>
                        {/* A bar rather than a number alone: the shape of the
                            funnel is the thing worth seeing at a glance. */}
                        <div
                          style={{
                            height: 6,
                            borderRadius: 3,
                            background: "var(--accent)",
                            opacity: stage === "lost" || stage === "do_not_contact" ? 0.3 : 1,
                            width: `${Math.max(4, (n / totalLeads) * 100)}%`,
                          }}
                        />
                      </td>
                      <td
                        className="mono"
                        style={{ width: 46, textAlign: "right", fontVariantNumeric: "tabular-nums" }}
                      >
                        {n}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="split" style={{ marginTop: 18 }}>
        <div>
          {/* What the agents have actually *done*, as discrete pieces of work
              with a cost and an outcome. The activity feed below shows events;
              this shows runs — the unit you judge an agent on. */}
          <div className="panel" style={{ marginBottom: 18 }}>
            <div className="panel-head">Agent runs</div>
            {runs.length === 0 ? (
              <p className="muted" style={{ padding: "22px 16px", fontSize: 13, margin: 0 }}>
                No runs yet.
              </p>
            ) : (
              <table>
                <tbody>
                  {runs.map((run) => {
                    const stats = run.stats as Record<string, number | undefined>;
                    const detail =
                      run.stage === "discover"
                        ? `${stats.found ?? 0} found · ${stats.created ?? 0} new · ${stats.merged ?? 0} known`
                        : run.stage === "research"
                          ? `${stats.researched ?? 0} researched · ${stats.unreadable ?? 0} unreadable`
                          : Object.entries(stats)
                              .filter(([, v]) => typeof v === "number")
                              .map(([k, v]) => `${k} ${v}`)
                              .join(" · ");
                    return (
                      <tr key={run.id}>
                        <td>
                          <div style={{ fontSize: 13, fontWeight: 600, textTransform: "capitalize" }}>
                            {run.stage}
                            <span className="muted" style={{ fontWeight: 400, marginLeft: 7, fontSize: 11.5 }}>
                              {run.agent_name}
                            </span>
                          </div>
                          <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>
                            {detail || "—"}
                            {stats.costUsd ? ` · $${Number(stats.costUsd).toFixed(3)}` : ""}
                          </div>
                          {run.error && (
                            <div style={{ fontSize: 11.5, marginTop: 3, color: "var(--warn)" }}>
                              {run.error.slice(0, 120)}
                            </div>
                          )}
                        </td>
                        <td style={{ width: 90, textAlign: "right", verticalAlign: "top" }}>
                          <span
                            className="pill"
                            style={
                              run.status === "done"
                                ? { color: "var(--ok)", borderColor: "var(--ok)" }
                                : run.status === "failed"
                                  ? { color: "var(--warn)", borderColor: "var(--warn)" }
                                  : {}
                            }
                          >
                            {run.status}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          <div className="panel">
            <div className="panel-head">
              Recent activity
              <Link href="/sales/activity" className="muted" style={{ fontWeight: 400, marginLeft: "auto", fontSize: 12 }}>
                See all
              </Link>
            </div>
            <ActivityFeed rows={activity} empty="Nothing has happened yet. Start the worker and run an agent." />
          </div>
        </div>

        <div>
          <div className="panel" style={{ marginBottom: 18 }}>
            <div className="panel-head">Worker</div>
            <div style={{ padding: "14px 16px", display: "grid", gap: 10 }}>
              <QueueLine label="Due now" value={queue.dueNow} />
              <QueueLine label="Pending" value={queue.pending} />
              <QueueLine label="Running" value={queue.running} />
              <QueueLine label="Dead" value={queue.dead} tone={queue.dead > 0 ? "warn" : undefined} />
              {/* Jobs due but nothing running is the signature of a worker that
                  is not up — the one failure that otherwise looks like an idle
                  system rather than a broken one. */}
              {queue.dueNow > 0 && queue.running === 0 && (
                <p className="muted" style={{ fontSize: 12, margin: "4px 0 0", lineHeight: 1.5 }}>
                  {queue.dueNow} job{queue.dueNow === 1 ? " is" : "s are"} due and nothing is
                  running. Start the worker: <code className="mono">npm run worker</code>
                </p>
              )}
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">Cost, 30 days</div>
            {spend.length === 0 ? (
              <p className="muted" style={{ padding: "22px 16px", fontSize: 13, margin: 0 }}>
                Nothing spent yet.
              </p>
            ) : (
              <table>
                <tbody>
                  {spend.map((s) => (
                    <tr key={s.category}>
                      <td style={{ textTransform: "capitalize" }}>
                        {s.category.replace(/_/g, " ")}
                        <span className="muted" style={{ fontSize: 11.5, marginLeft: 7 }}>
                          {s.events}
                        </span>
                      </td>
                      <td
                        className="mono"
                        style={{ textAlign: "right", width: 84, fontVariantNumeric: "tabular-nums" }}
                      >
                        ${Number(s.amount_usd).toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function QueueLine({ label, value, tone }: { label: string; value: number; tone?: "warn" }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
      <span className="muted">{label}</span>
      <span
        className="mono"
        style={{
          fontVariantNumeric: "tabular-nums",
          color: tone === "warn" && value > 0 ? "var(--warn)" : "var(--text)",
        }}
      >
        {value}
      </span>
    </div>
  );
}

function AgentRow({ agent, depth }: { agent: AgentSummary; depth: number }) {
  const isWorker = agent.kind === "vertical_agent";
  return (
    <tr>
      <td style={{ paddingLeft: 16 + depth * 18 }}>
        <Link href={`/sales/agents/${agent.id}`} style={{ fontWeight: isWorker ? 600 : 500 }}>
          {agent.name}
        </Link>
        <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>
          {agent.kind === "director"
            ? "director"
            : agent.kind === "country_manager"
              ? `country manager · ${agent.country_code}`
              : `${agent.vertical_slug} · ${agent.country_code} · mode ${
                  agent.autonomy_mode === "review" ? "1" : agent.autonomy_mode === "semi" ? "2" : "3"
                }`}
          {agent.paused_reason ? ` · ${agent.paused_reason}` : ""}
        </div>
      </td>
      <td className="mono" style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
        {isWorker ? agent.leads : ""}
      </td>
      <td className="mono" style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
        {isWorker ? agent.qualified : ""}
      </td>
      <td
        className="mono"
        style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontSize: 12 }}
      >
        ${Number(agent.spent_today).toFixed(2)}
        {agent.daily_budget !== null && (
          <span className="muted" style={{ fontSize: 10.5 }}>
            /{Number(agent.daily_budget).toFixed(0)}
          </span>
        )}
      </td>
      <td style={{ textAlign: "right" }}>
        <span className="pill" style={statusTone(agent.status)}>
          {agent.status}
        </span>
      </td>
    </tr>
  );
}

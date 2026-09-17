import Link from "next/link";
import { requireUser } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import { FILS_PER_USD } from "@/lib/billing/cost";
import { agentSummaries, asTree, queueHealth, setupState, spendByCategory, type AgentSummary } from "@/lib/sales/kpi/overview";
import { recentRuns } from "@/lib/sales/kpi/leads";
import Setup from "../Setup";
import { ConsoleHeader, EmptyState, Pill, aed, ago } from "../ui";
import SettingsTabs from "./SettingsTabs";

export const dynamic = "force-dynamic";

/**
 * The AI sales agents: who they are, what they have done, what they cost, and
 * how to run them.
 *
 * No "Run now" buttons. The background job queue has no handler for any
 * pipeline step, so a button could only queue work that nothing picks up.
 * The agents run from a terminal on the server, and this page says exactly
 * how, until real job handlers with cost guards exist.
 */

const usdToFils = (usd: number) => Math.round(Number(usd) * FILS_PER_USD);

const RUNS = [
  { what: "Find new businesses", command: 'npm run discover -- "UAE Dental"', note: "Searches maps listings for the agent's trade and country, and adds the new ones to Leads." },
  { what: "Find email addresses", command: 'npm run enrich -- "UAE Dental"', note: "Looks for a contact address on each business's own website." },
  { what: "Read their websites", command: 'npm run research -- "UAE Dental"', note: "Reads each website and writes what it found, with the page each point came from." },
  { what: "Score them", command: 'npm run score -- "UAE Dental"', note: "Scores each researched lead, so the best come first and the hot ones show on Today." },
  { what: "Build their demos", command: 'npm run demos -- "UAE Dental"', note: "Builds a demo line for each lead worth contacting." },
  { what: "Draft the first email", command: 'npm run draft -- "UAE Dental"', note: "Writes a draft for each qualified lead with a demo. Drafts wait on the lead's page; nothing is sent." },
];

function describe(a: AgentSummary): string {
  if (a.kind === "director") return "Sales director: sets the rules every agent inherits";
  if (a.kind === "country_manager") return `Country manager for ${a.country_code ?? "?"}: adds that country's rules`;
  return `Finds ${(a.vertical_slug ?? "businesses").replace(/_/g, " ")} in ${a.country_code ?? "?"}`;
}

export default async function SettingsPage() {
  const user = await requireUser();
  if (!isBellineStaff(user)) return <p className="muted">Belline staff only.</p>;

  const state = await setupState();
  const [agents, runs, spend, queue] = state === "ready" ? await Promise.all([agentSummaries(), recentRuns(10), spendByCategory(30), queueHealth()]) : [[], [], [], null];
  const spent30 = spend.reduce((n, s) => n + Number(s.amount_usd), 0);

  return (
    <>
      <ConsoleHeader title="Settings" subtitle="The AI sales agents, the video receptionist, the demo lines, the number pool and every agent action." />
      <SettingsTabs active="/sales/settings" />

      {state !== "ready" ? (
        <Setup state={state} />
      ) : (
        <div className="staff-grid">
          <div className="staff-stack">
            <section className="panel staff-section">
              <div className="panel-head">
                AI sales agents<span className="muted">{agents.filter((a) => a.kind === "vertical_agent" && a.status === "active").length} working</span>
              </div>
              {agents.length === 0 ? (
                <EmptyState title="No agents yet">Load them with the setup steps.</EmptyState>
              ) : (
                <div className="table-wrap" tabIndex={0}>
                  <table className="staff-table">
                    <thead>
                      <tr>
                        <th>Agent</th>
                        <th className="num">Leads</th>
                        <th className="num">Worth contacting</th>
                        <th className="num">Spent today</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {asTree(agents).map(({ agent, depth }) => (
                        <tr key={agent.id}>
                          <td style={{ paddingLeft: 16 + depth * 18 }}>
                            <Link href={`/sales/settings/agents/${agent.id}`} style={{ fontWeight: 600 }}>
                              {agent.name}
                            </Link>
                            <div className="sub">
                              {describe(agent)}
                              {agent.paused_reason ? ` · paused: ${agent.paused_reason}` : ""}
                            </div>
                          </td>
                          <td className="num">{agent.kind === "vertical_agent" ? agent.leads : ""}</td>
                          <td className="num">{agent.kind === "vertical_agent" ? agent.qualified : ""}</td>
                          <td className="num">
                            {aed(usdToFils(agent.spent_today))}
                            {agent.daily_budget !== null && <div className="sub">of {aed(usdToFils(agent.daily_budget))} a day</div>}
                          </td>
                          <td>
                            <Pill tone={agent.status === "active" ? "ok" : agent.status === "paused" ? "warn" : undefined}>{agent.status === "active" ? "Working" : agent.status === "paused" ? "Paused" : agent.status === "draft" ? "Not started" : agent.status}</Pill>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="panel staff-section">
              <div className="panel-head">Recent runs</div>
              {runs.length === 0 ? (
                <EmptyState title="No runs yet">Run an agent with one of the commands on the right.</EmptyState>
              ) : (
                <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                  {runs.map((run) => {
                    const stats = run.stats as Record<string, number | undefined>;
                    const detail = Object.entries(stats)
                      .filter(([k, v]) => typeof v === "number" && k !== "costUsd")
                      .map(([k, v]) => `${v} ${k.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()}`)
                      .join(", ");
                    return (
                      <li key={run.id} style={{ padding: "10px 18px", borderTop: "1px solid var(--bl-rule-soft)" }}>
                        <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                          <strong style={{ fontSize: 13, textTransform: "capitalize" }}>{run.stage}</strong>
                          <span className="muted" style={{ fontSize: 12 }}>{run.agent_name}</span>
                          <Pill tone={run.status === "done" ? "ok" : run.status === "failed" ? "bad" : undefined}>{run.status === "done" ? "Finished" : run.status === "failed" ? "Failed" : "Running"}</Pill>
                          <span className="muted" style={{ fontSize: 11.5, marginLeft: "auto" }}>{ago(run.started_at)}</span>
                        </div>
                        <div className="sub">
                          {detail || "No figures recorded"}
                          {stats.costUsd ? ` · cost ${aed(usdToFils(stats.costUsd))}` : ""}
                        </div>
                        {run.error && <div style={{ fontSize: 12, color: "var(--bl-danger)", marginTop: 3 }}>{run.error.split(/[{\n]/)[0].replace(/[:\s]+$/, "").slice(0, 140)}</div>}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>

          <div className="staff-stack">
            <section className="panel staff-section">
              <div className="panel-head">Running the agents</div>
              <div className="staff-body" style={{ display: "grid", gap: 12 }}>
                <p className="staff-note">
                  The agents run from a terminal on the server, one step at a time, in this order. There is no button here on
                  purpose: the background job queue does not carry these steps yet, so a button could only queue work nobody
                  picks up. Put the agent&apos;s name in quotes. Finding new businesses stops at the agent&apos;s daily spending cap; the
                  other steps check no cap yet, so watch the cost on the right.
                </p>
                {RUNS.map((r) => (
                  <div key={r.what}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{r.what}</div>
                    <div className="staff-note">{r.note}</div>
                    <pre className="mono" style={{ background: "var(--bl-ground)", border: "1px solid var(--bl-rule)", borderRadius: 8, padding: "6px 10px", fontSize: 12, margin: "4px 0 0", overflowX: "auto" }}>
                      {r.command}
                    </pre>
                  </div>
                ))}
                {queue && queue.dead > 0 && <p className="staff-note" style={{ color: "var(--bl-warning)" }}>{queue.dead} background job{queue.dead === 1 ? "" : "s"} failed for good and need a look.</p>}
              </div>
            </section>

            <section className="panel staff-section">
              <div className="panel-head">What the agents cost, last 30 days</div>
              {spend.length === 0 ? (
                <EmptyState title="Nothing spent yet" />
              ) : (
                <div className="staff-body">
                  {spend.map((s) => (
                    <div key={s.category} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "4px 0" }}>
                      <span style={{ textTransform: "capitalize" }}>{s.category.replace(/_/g, " ")}</span>
                      <span style={{ fontVariantNumeric: "tabular-nums" }}>{aed(usdToFils(s.amount_usd))}</span>
                    </div>
                  ))}
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "8px 0 0", borderTop: "1px solid var(--bl-rule-soft)", marginTop: 6, fontWeight: 600 }}>
                    <span>Total</span>
                    <span>{aed(usdToFils(spent30))}</span>
                  </div>
                </div>
              )}
            </section>
          </div>
        </div>
      )}
    </>
  );
}

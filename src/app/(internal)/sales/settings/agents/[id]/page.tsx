import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import { FILS_PER_USD } from "@/lib/billing/cost";
import { resolveAgentConfig, ConfigError } from "@/lib/sales/config/agents";
import { agentSummaries, recentActivity, setupState } from "@/lib/sales/kpi/overview";
import Setup from "../../../Setup";
import { ActivityFeed, ConsoleHeader, KeyValues, Pill, Stat, aed } from "../../../ui";
import SettingsTabs from "../../SettingsTabs";

export const dynamic = "force-dynamic";

/**
 * One AI sales agent, and what it will actually do.
 *
 * Each agent's settings are layered: the sales director's rules, then its
 * country manager's, then its own. What is shown is the result, because that
 * is what the agent acts on, and the two differ often: a Swiss agent asking
 * for four follow-ups gets two.
 */

const usdToFils = (usd: number) => Math.round(Number(usd) * FILS_PER_USD);

export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!isBellineStaff(user)) return <p className="muted">Belline staff only.</p>;

  const state = await setupState();
  if (state !== "ready") {
    return (
      <>
        <ConsoleHeader title="Settings" />
        <SettingsTabs active="/sales/settings" />
        <Setup state={state} />
      </>
    );
  }

  const id = Number((await params).id);
  if (!Number.isFinite(id)) notFound();
  const all = await agentSummaries();
  const agent = all.find((a) => a.id === id);
  if (!agent) notFound();

  const activity = await recentActivity(25, { agentId: id });
  let resolved: Awaited<ReturnType<typeof resolveAgentConfig>> | null = null;
  let problems: string[] | null = null;
  try {
    resolved = await resolveAgentConfig(id);
  } catch (err) {
    problems = err instanceof ConfigError ? [err.message, ...err.issues] : [(err as Error).message];
  }
  const children = all.filter((a) => a.parent_id === id);
  const c = resolved?.config;

  return (
    <>
      <p style={{ margin: "0 0 10px" }}>
        <Link href="/sales/settings" className="muted" style={{ fontSize: 12.5 }}>
          ← AI sales agents
        </Link>
      </p>
      <ConsoleHeader
        title={agent.name}
        subtitle={
          agent.kind === "vertical_agent"
            ? `Finds ${(agent.vertical_slug ?? "businesses").replace(/_/g, " ")} in ${agent.country_code}`
            : agent.kind === "country_manager"
              ? `Country manager for ${agent.country_code}`
              : "Sales director"
        }
        actions={<Pill tone={agent.status === "active" ? "ok" : agent.status === "paused" ? "warn" : undefined}>{agent.status === "active" ? "Working" : agent.status === "paused" ? "Paused" : agent.status === "draft" ? "Not started" : agent.status}</Pill>}
      />

      {agent.paused_reason && (
        <div className="panel staff-warning" style={{ padding: "12px 16px", marginBottom: 16 }}>
          <strong style={{ color: "var(--bl-warning)" }}>Paused:</strong> {agent.paused_reason}
        </div>
      )}

      {agent.kind === "vertical_agent" && (
        <div className="stats">
          <Stat label="Leads" value={String(agent.leads)} />
          <Stat label="Worth contacting" value={String(agent.qualified)} />
          <Stat label="Contacted" value={String(agent.contacted)} />
          <Stat label="Spent today" value={aed(usdToFils(agent.spent_today))} hint={agent.daily_budget ? `of ${aed(usdToFils(agent.daily_budget))} a day` : "no daily cap set"} />
        </div>
      )}

      {problems && (
        <div className="panel staff-warning" style={{ padding: "14px 18px", marginBottom: 16 }}>
          <div style={{ fontWeight: 600, color: "var(--bl-warning)", marginBottom: 6 }}>This agent cannot run</div>
          <ul className="staff-note" style={{ margin: 0, paddingLeft: 18 }}>
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="staff-grid">
        <div className="staff-stack">
          {resolved && c && (
            <section className="panel staff-section">
              <div className="panel-head">
                What this agent will do<span className="muted">its own settings on top of its managers&apos;</span>
              </div>
              <div className="staff-body">
                <KeyValues
                  rows={[
                    [
                      "Settings from",
                      resolved.chain.map((a, i) => (
                        <span key={a.id}>
                          {i > 0 && <span className="muted"> → </span>}
                          {a.id === id ? <strong>{a.name}</strong> : <Link href={`/sales/settings/agents/${a.id}`}>{a.name}</Link>}
                        </span>
                      )),
                    ],
                    ["Reaches out by", c.outreach_strategy.channels.join(", ")],
                    ["Languages", c.languages.join(", ")],
                    ["Regions", c.regions.length ? c.regions.join(", ") : "The whole country"],
                    ["Follow-ups", `${c.outreach_strategy.sequence}, at most ${c.compliance.max_sequence_steps} messages`],
                    ["Writes between", `${c.outreach_strategy.send_window.start} and ${c.outreach_strategy.send_window.end} (${c.outreach_strategy.send_window.tz}), at most ${c.outreach_strategy.daily_send_cap} a day`],
                    ["Worth contacting at", `a score of ${c.qualification_rules.min_score_to_contact} or more; hot from ${c.scoring.bands.hot}, warm from ${c.scoring.bands.warm}`],
                    ["Spending cap", `${aed(usdToFils(c.budget.daily_usd))} a day, ${aed(usdToFils(c.budget.monthly_usd))} a month`],
                    ["Sells", c.belline_services.map((s) => s.replace(/_/g, " ")).join(", ")],
                    // Resolved and shown, and read by nothing yet: none of these stops a draft being written.
                    ["Email consent", c.compliance.email_requires_prior_consent ? "Prior consent required: recorded, not enforced" : "Not required for business contacts"],
                    ["Who to write to", c.compliance.prefer_company_level_contact ? "The business rather than a named person (recorded, not enforced)" : "Named people allowed"],
                    ["How often", `At least ${c.compliance.min_days_between_touches} days apart, at most ${c.compliance.company_touch_cap_90d} per business in 90 days (recorded, not enforced)`],
                  ]}
                />
              </div>
            </section>
          )}
          {children.length > 0 && (
            <section className="panel staff-section">
              <div className="panel-head">Agents under this one</div>
              <div className="staff-body" style={{ display: "grid", gap: 8 }}>
                {children.map((ch) => (
                  <div key={ch.id} style={{ fontSize: 13 }}>
                    <Link href={`/sales/settings/agents/${ch.id}`} style={{ fontWeight: 600 }}>
                      {ch.name}
                    </Link>
                    <span className="muted"> · {ch.leads} leads</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
        <div className="staff-stack">
          <section className="panel staff-section">
            <div className="panel-head">
              What it has done
              <Link href={`/sales/settings/activity?agent=${id}`} className="muted" style={{ marginLeft: "auto" }}>
                See all
              </Link>
            </div>
            <ActivityFeed rows={activity} empty="This agent has not done anything yet." />
          </section>
        </div>
      </div>
    </>
  );
}

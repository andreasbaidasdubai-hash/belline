import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth-server";
import { canManageUsers } from "@/lib/auth";
import { PageHeader } from "@/components/LocationTabs";
import { resolveAgentConfig, ConfigError } from "@/lib/sales/config/agents";
import {
  agentSummaries,
  pipelineCounts,
  recentActivity,
  setupState,
  STAGE_ORDER,
} from "@/lib/sales/kpi/overview";
import Setup from "../../Setup";
import { ActivityFeed, Stat, statusTone } from "../../ui";

export const dynamic = "force-dynamic";

/**
 * One agent.
 *
 * The centrepiece is the resolved configuration — what this agent will
 * *actually* do after Director → Country → Vertical inheritance, rather than
 * what its own row says. Those two differ, deliberately and often: a Swiss
 * agent asking for four sequence steps gets two, and one asking for WhatsApp
 * gets nothing. Showing only the stored config would hide exactly the
 * behaviour the hierarchy exists to produce.
 */
export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!canManageUsers(user)) {
    return <p className="muted">The sales engine is owner-only.</p>;
  }

  const state = await setupState();
  if (state !== "ready") {
    return (
      <>
        <PageHeader title="Agent" />
        <Setup state={state} />
      </>
    );
  }

  const id = Number((await params).id);
  if (!Number.isFinite(id)) notFound();

  const all = await agentSummaries();
  const agent = all.find((a) => a.id === id);
  if (!agent) notFound();

  const [activity, stages] = await Promise.all([
    recentActivity(25, { agentId: id }),
    pipelineCounts(id),
  ]);

  let resolved: Awaited<ReturnType<typeof resolveAgentConfig>> | null = null;
  let configError: string[] | null = null;
  try {
    resolved = await resolveAgentConfig(id);
  } catch (err) {
    configError =
      err instanceof ConfigError ? [err.message, ...err.issues] : [(err as Error).message];
  }

  const stageMap = new Map(stages.map((s) => [s.stage, s.n]));
  const children = all.filter((a) => a.parent_id === id);

  return (
    <>
      <PageHeader
        title={agent.name}
        subtitle={
          agent.kind === "vertical_agent"
            ? `${agent.vertical_slug} · ${agent.country_code} · autonomy mode ${
                agent.autonomy_mode === "review" ? "1 (review)" : agent.autonomy_mode === "semi" ? "2 (semi)" : "3 (autonomous)"
              }`
            : agent.kind === "country_manager"
              ? `Country manager · ${agent.country_code}`
              : "Sales Director"
        }
        right={
          <span className="pill" style={statusTone(agent.status)}>
            {agent.status}
          </span>
        }
      />

      {agent.paused_reason && (
        <div
          className="panel"
          style={{ padding: "12px 16px", marginBottom: 16, borderColor: "var(--warn)" }}
        >
          <span style={{ color: "var(--warn)", fontWeight: 600, fontSize: 13 }}>Paused</span>
          <span className="muted" style={{ fontSize: 13, marginLeft: 8 }}>
            {agent.paused_reason}
          </span>
        </div>
      )}

      {agent.kind === "vertical_agent" && (
        <div className="stats">
          <Stat label="Leads" value={String(agent.leads)} />
          <Stat label="Qualified" value={String(agent.qualified)} tone={agent.qualified ? "ok" : undefined} />
          <Stat label="Contacted" value={String(agent.contacted)} />
          <Stat
            label="Awaiting approval"
            value={String(agent.pending_approval)}
            tone={agent.pending_approval > 0 ? "warn" : undefined}
          />
          <Stat
            label="Spend today"
            value={`$${Number(agent.spent_today).toFixed(2)}`}
            hint={agent.daily_budget ? `of $${Number(agent.daily_budget).toFixed(0)} cap` : "no cap set"}
          />
        </div>
      )}

      {configError && (
        <div className="panel" style={{ padding: "16px 18px", marginBottom: 18, borderColor: "var(--warn)" }}>
          <div style={{ fontWeight: 600, fontSize: 13.5, color: "var(--warn)", marginBottom: 8 }}>
            This agent cannot run
          </div>
          <ul className="muted" style={{ fontSize: 12.5, margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
            {configError.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="split">
        <div>
          {resolved && (
            <div className="panel" style={{ marginBottom: 18 }}>
              <div className="panel-head">
                Resolved configuration
                <span className="muted" style={{ fontWeight: 400, marginLeft: 8, fontSize: 11.5 }}>
                  after inheritance
                </span>
              </div>
              <div style={{ padding: "14px 16px", display: "grid", gap: 13 }}>
                <Field label="Inherits from">
                  {resolved.chain.map((a, i) => (
                    <span key={a.id}>
                      {i > 0 && <span className="muted"> → </span>}
                      {a.id === id ? (
                        <strong>{a.name}</strong>
                      ) : (
                        <Link href={`/sales/agents/${a.id}`}>{a.name}</Link>
                      )}
                    </span>
                  ))}
                </Field>
                <Field label="Channels">
                  {resolved.config.outreach_strategy.channels.join(", ")}
                </Field>
                <Field label="Languages">{resolved.config.languages.join(", ")}</Field>
                <Field label="Regions">
                  {resolved.config.regions.length ? resolved.config.regions.join(", ") : "—"}
                </Field>
                <Field label="Sequence">
                  {resolved.config.outreach_strategy.sequence}
                  <span className="muted">
                    {" "}
                    · max {resolved.config.compliance.max_sequence_steps} steps
                  </span>
                </Field>
                <Field label="Send window">
                  {resolved.config.outreach_strategy.send_window.start}–
                  {resolved.config.outreach_strategy.send_window.end}{" "}
                  <span className="muted">
                    {resolved.config.outreach_strategy.send_window.tz} · cap{" "}
                    {resolved.config.outreach_strategy.daily_send_cap}/day
                  </span>
                </Field>
                <Field label="Qualifies at">
                  score ≥ {resolved.config.qualification_rules.min_score_to_contact}
                  <span className="muted">
                    {" "}
                    · hot ≥ {resolved.config.scoring.bands.hot}, warm ≥{" "}
                    {resolved.config.scoring.bands.warm}
                  </span>
                </Field>
                <Field label="Budget">
                  ${resolved.config.budget.daily_usd}/day · $
                  {resolved.config.budget.monthly_usd}/month
                </Field>
                <Field label="Services">
                  {resolved.config.belline_services.map((s) => s.replace(/_/g, " ")).join(", ")}
                </Field>

                {/* Compliance is the half of the config a country manager
                    imposes, and the half you most need to be able to read
                    off a screen before an agent goes live. */}
                <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
                  <Field label="Email consent">
                    {resolved.config.compliance.email_requires_prior_consent ? (
                      <span style={{ color: "var(--warn)" }}>
                        prior consent required — cold email is gated
                      </span>
                    ) : (
                      "not required for business contacts"
                    )}
                  </Field>
                </div>
                <Field label="Contact level">
                  {resolved.config.compliance.prefer_company_level_contact
                    ? "company-level preferred"
                    : "named individuals allowed"}
                </Field>
                <Field label="Frequency">
                  ≥ {resolved.config.compliance.min_days_between_touches} days between touches ·
                  max {resolved.config.compliance.company_touch_cap_90d} per company / 90 days
                </Field>
              </div>
            </div>
          )}

          {children.length > 0 && (
            <div className="panel">
              <div className="panel-head">Reports to this agent</div>
              <table>
                <tbody>
                  {children.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <Link href={`/sales/agents/${c.id}`} style={{ fontWeight: 600 }}>
                          {c.name}
                        </Link>
                        <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>
                          {c.vertical_slug ?? c.kind.replace(/_/g, " ")}
                          {c.leads ? ` · ${c.leads} leads` : ""}
                        </div>
                      </td>
                      <td style={{ textAlign: "right", width: 92 }}>
                        <span className="pill" style={statusTone(c.status)}>
                          {c.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div>
          {agent.kind === "vertical_agent" && (
            <div className="panel" style={{ marginBottom: 18 }}>
              <div className="panel-head">Pipeline</div>
              {agent.leads === 0 ? (
                <p className="muted" style={{ padding: "22px 16px", fontSize: 13, margin: 0 }}>
                  No leads yet.
                </p>
              ) : (
                <table>
                  <tbody>
                    {STAGE_ORDER.filter((s) => (stageMap.get(s) ?? 0) > 0).map((stage) => (
                      <tr key={stage}>
                        <td style={{ textTransform: "capitalize" }}>{stage.replace(/_/g, " ")}</td>
                        <td className="mono" style={{ textAlign: "right", width: 50 }}>
                          {stageMap.get(stage)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          <div className="panel">
            <div className="panel-head">
              Activity
              <Link
                href={`/sales/activity?agent=${id}`}
                className="muted"
                style={{ fontWeight: 400, marginLeft: "auto", fontSize: 12 }}
              >
                See all
              </Link>
            </div>
            <ActivityFeed rows={activity} empty="This agent has not done anything yet." />
          </div>
        </div>
      </div>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "128px 1fr", gap: 12, fontSize: 13 }}>
      <div className="muted" style={{ fontSize: 12 }}>
        {label}
      </div>
      <div>{children}</div>
    </div>
  );
}

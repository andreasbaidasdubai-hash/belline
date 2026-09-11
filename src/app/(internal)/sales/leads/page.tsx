import Link from "next/link";
import { requireUser } from "@/lib/auth-server";
import { PageHeader } from "@/components/LocationTabs";
import { agentSummaries, setupState, STAGE_ORDER, pipelineCounts } from "@/lib/sales/kpi/overview";
import { listLeads } from "@/lib/sales/kpi/leads";
import Setup from "../Setup";
import { statusTone } from "../ui";

export const dynamic = "force-dynamic";

/**
 * The pipeline.
 *
 * Ordered by score, then by review count — so the most valuable prospect is
 * the first thing on screen rather than the most recently found. Research
 * summaries are shown inline: the point of this page is to see what the agents
 * concluded, not to click into thirty of them one at a time.
 */
export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ stage?: string; agent?: string }>;
}) {
  const user = await requireUser();
  if (user.role !== "owner") return null; // layout already refused; belt and braces

  const state = await setupState();
  if (state !== "ready") {
    return (
      <>
        <PageHeader title="Pipeline" />
        <Setup state={state} />
      </>
    );
  }

  const { stage, agent } = await searchParams;
  const agentId = agent ? Number(agent) : undefined;

  const [leads, agents, counts] = await Promise.all([
    listLeads({ stage, agentId: Number.isFinite(agentId) ? agentId : undefined }),
    agentSummaries(),
    pipelineCounts(),
  ]);

  const byStage = new Map(counts.map((c) => [c.stage, c.n]));
  const total = counts.reduce((n, c) => n + c.n, 0);
  const researched = leads.filter((l) => l.researched).length;

  const href = (s?: string) => {
    const p = new URLSearchParams();
    if (s) p.set("stage", s);
    if (agent) p.set("agent", agent);
    const q = p.toString();
    return q ? `/sales/leads?${q}` : "/sales/leads";
  };

  return (
    <>
      <PageHeader
        title="Pipeline"
        subtitle={`${total} lead${total === 1 ? "" : "s"} · ${researched} of ${leads.length} shown have been researched`}
      />

      <div className="loc-tabs" style={{ marginBottom: 16 }}>
        <Chip label={`All ${total}`} href={href()} on={!stage} />
        {STAGE_ORDER.filter((s) => (byStage.get(s) ?? 0) > 0).map((s) => (
          <Chip
            key={s}
            label={`${s.replace(/_/g, " ")} ${byStage.get(s)}`}
            href={href(s)}
            on={stage === s}
          />
        ))}
      </div>

      {leads.length === 0 ? (
        <div className="panel" style={{ padding: "30px 26px" }}>
          <p className="muted" style={{ fontSize: 13.5, margin: 0, lineHeight: 1.6 }}>
            Nothing here yet. Find companies with{" "}
            <code className="mono">npm run discover -- &quot;UAE Dental&quot;</code>, then research
            them with <code className="mono">npm run research -- &quot;UAE Dental&quot;</code>.
          </p>
        </div>
      ) : (
        <div className="panel">
          <table>
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Company</th>
                <th style={{ width: 70, textAlign: "right" }}>Score</th>
                <th style={{ width: 110 }}>Stage</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => (
                <tr key={lead.lead_id}>
                  <td>
                    <Link href={`/sales/leads/${lead.lead_id}`} style={{ fontWeight: 600 }}>
                      {lead.name}
                    </Link>
                    <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>
                      {[
                        lead.city,
                        lead.branches > 1 ? `${lead.branches} locations` : null,
                        lead.rating ? `${lead.rating}★ ${lead.review_count ?? 0}` : null,
                        lead.domain,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                    {lead.summary && (
                      // The first sentence of the research is the agent's own
                      // one-line answer to "why is this a good prospect" — the
                      // most useful thing that fits on a list row.
                      <div style={{ fontSize: 12.5, marginTop: 5, color: "var(--text)", opacity: 0.85 }}>
                        {lead.summary.split(". ")[0]}.
                      </div>
                    )}
                    {lead.use_cases && lead.use_cases.length > 0 && (
                      <div style={{ marginTop: 6, display: "flex", gap: 5, flexWrap: "wrap" }}>
                        {lead.use_cases.map((u) => (
                          <span
                            key={u}
                            className="pill"
                            style={{ fontSize: 10.5, padding: "2px 7px" }}
                          >
                            {u.replace(/_/g, " ")}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td
                    className="mono"
                    style={{
                      textAlign: "right",
                      verticalAlign: "top",
                      fontVariantNumeric: "tabular-nums",
                      color:
                        lead.priority === "hot"
                          ? "var(--ok)"
                          : lead.priority === "low"
                            ? "var(--muted)"
                            : "var(--text)",
                    }}
                  >
                    {lead.current_score ?? "—"}
                    {lead.priority && (
                      <div className="muted" style={{ fontSize: 10.5, marginTop: 2 }}>
                        {lead.priority}
                      </div>
                    )}
                  </td>
                  <td style={{ verticalAlign: "top", textAlign: "right" }}>
                    <span className="pill" style={statusTone(lead.stage)}>
                      {lead.stage.replace(/_/g, " ")}
                    </span>
                    {!lead.researched && (
                      <div className="muted" style={{ fontSize: 10.5, marginTop: 4 }}>
                        not researched
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Chip({ label, href, on }: { label: string; href: string; on: boolean }) {
  return (
    <Link
      href={href}
      className="pill"
      style={{
        padding: "5px 12px",
        fontSize: 11.5,
        textTransform: "capitalize",
        background: on ? "var(--accent)" : "var(--panel)",
        color: on ? "#fff" : "var(--muted)",
        borderColor: on ? "var(--accent)" : "var(--border)",
      }}
    >
      {label}
    </Link>
  );
}

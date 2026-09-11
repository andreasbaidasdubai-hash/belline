import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth-server";
import { PageHeader } from "@/components/LocationTabs";
import {
  getLead,
  getLocations,
  getResearch,
  getTimeline,
} from "@/lib/sales/kpi/leads";
import { ActivityFeed, statusTone } from "../../ui";

export const dynamic = "force-dynamic";

/**
 * One lead — and the place you can actually audit an agent.
 *
 * Everything a model concluded is shown beside the evidence it cited and a
 * link to the page that evidence came from. That is the whole point: a claim
 * you cannot check is a claim you should not put in an email, and this screen
 * is where checking happens before anything is sent.
 *
 * Signals are grouped present / absent / unknown rather than listed flat,
 * because for this product the absences are the pitch — "no online booking"
 * and "no after-hours cover" are the reasons to call a practice at all.
 */
export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (user.role !== "owner") return null;

  const id = Number((await params).id);
  if (!Number.isFinite(id)) notFound();

  const lead = await getLead(id);
  if (!lead) notFound();

  const [research, locations, timeline] = await Promise.all([
    getResearch(lead.company_id),
    getLocations(lead.company_id),
    getTimeline(id),
  ]);

  const signals = (research?.signals ?? {}) as Record<string, unknown>;
  const entries = Object.entries(signals);
  const present = entries.filter(
    ([, v]) => v !== null && v !== false && !(Array.isArray(v) && v.length === 0),
  );
  const absent = entries.filter(([, v]) => v === false);
  const unknown = entries.filter(([, v]) => v === null);

  return (
    <>
      <PageHeader
        title={lead.name}
        subtitle={[lead.city, lead.vertical_slug, lead.agent_name].filter(Boolean).join(" · ")}
        right={
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {lead.current_score !== null && (
              <span
                className="pill mono"
                style={{
                  color:
                    lead.priority === "hot"
                      ? "var(--ok)"
                      : lead.priority === "low"
                        ? "var(--muted)"
                        : "var(--text)",
                }}
              >
                {lead.current_score} {lead.priority}
              </span>
            )}
            <span className="pill" style={statusTone(lead.stage)}>
              {lead.stage.replace(/_/g, " ")}
            </span>
          </div>
        }
      />

      <div className="split">
        <div>
          {research ? (
            <>
              <div className="panel" style={{ marginBottom: 18 }}>
                <div className="panel-head">
                  Why this is a good prospect
                  <span className="muted" style={{ fontWeight: 400, marginLeft: 8, fontSize: 11.5 }}>
                    {research.model} · {research.pages_read.length} pages · $
                    {Number(research.cost_usd ?? 0).toFixed(3)}
                  </span>
                </div>
                <p style={{ padding: "16px 18px", margin: 0, fontSize: 13.5, lineHeight: 1.65 }}>
                  {research.summary}
                </p>
              </div>

              <div className="panel" style={{ marginBottom: 18 }}>
                <div className="panel-head">Evidence</div>
                {research.evidence.length === 0 ? (
                  <p className="muted" style={{ padding: "22px 18px", margin: 0, fontSize: 13 }}>
                    No evidence recorded.
                  </p>
                ) : (
                  <div style={{ padding: "6px 0" }}>
                    {research.evidence.map((e, i) => (
                      <div
                        key={i}
                        style={{
                          padding: "12px 18px",
                          borderBottom:
                            i === research.evidence.length - 1 ? "none" : "1px solid var(--border)",
                        }}
                      >
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{e.claim}</div>
                        <div
                          style={{
                            fontSize: 12.5,
                            margin: "5px 0",
                            paddingLeft: 11,
                            borderLeft: "2px solid var(--border)",
                            fontStyle: "italic",
                            opacity: 0.85,
                          }}
                        >
                          “{e.quote}”
                        </div>
                        {/* The link is the point. Every claim is one click from
                            the page it came from, so it can be checked. */}
                        <a
                          href={e.url}
                          target="_blank"
                          rel="noopener noreferrer nofollow"
                          className="muted mono"
                          style={{ fontSize: 11 }}
                        >
                          {e.url.replace(/^https?:\/\//, "").slice(0, 80)}
                        </a>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="panel" style={{ marginBottom: 18, padding: "26px 20px" }}>
              <div style={{ fontWeight: 600, fontSize: 13.5, marginBottom: 6 }}>
                Not researched yet
              </div>
              <p className="muted" style={{ fontSize: 13, margin: 0, lineHeight: 1.6 }}>
                Run <code className="mono">npm run research -- &quot;{lead.agent_name.replace(/ Agent$/, "")}&quot;</code>{" "}
                to have the agent read this company&apos;s website.
              </p>
            </div>
          )}

          <div className="panel">
            <div className="panel-head">Timeline</div>
            <ActivityFeed
              rows={timeline.map((t) => ({
                ...t,
                lead_id: null,
                agent_name: null,
                company_name: null,
                company_city: null,
              }))}
              empty="Nothing recorded yet."
            />
          </div>
        </div>

        <div>
          <div className="panel" style={{ marginBottom: 18 }}>
            <div className="panel-head">Company</div>
            <div style={{ padding: "14px 16px", display: "grid", gap: 11, fontSize: 13 }}>
              <Field label="Phone">{lead.phone_e164 ?? "—"}</Field>
              <Field label="Website">
                {lead.website ? (
                  <a href={lead.website} target="_blank" rel="noopener noreferrer nofollow">
                    {lead.domain}
                  </a>
                ) : (
                  "—"
                )}
              </Field>
              <Field label="Rating">
                {lead.rating ? `${lead.rating}★ from ${lead.review_count ?? 0}` : "—"}
              </Field>
              <Field label="WhatsApp">{lead.has_whatsapp ? "yes" : "—"}</Field>
              <Field label="Address">{lead.address ?? "—"}</Field>
              <Field label="Found via">
                {lead.sources?.map((s) => s.slug).join(", ") || "—"}
              </Field>
            </div>
          </div>

          {locations.length > 1 && (
            <div className="panel" style={{ marginBottom: 18 }}>
              <div className="panel-head">
                Locations
                <span className="muted" style={{ fontWeight: 400, marginLeft: 8, fontSize: 11.5 }}>
                  {locations.length} found
                </span>
              </div>
              <table>
                <tbody>
                  {locations.map((l, i) => (
                    <tr key={i}>
                      <td style={{ fontSize: 12.5 }}>{l.address ?? l.city ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {research && (
            <div className="panel">
              <div className="panel-head">Signals</div>
              <div style={{ padding: "14px 16px", display: "grid", gap: 14 }}>
                <SignalGroup label="Present" tone="var(--ok)" items={present} />
                {/* Absences are shown as prominently as presences: they are
                    why a practice needs this product. */}
                <SignalGroup label="Absent" tone="var(--accent)" items={absent} />
                <SignalGroup label="Could not tell" tone="var(--muted)" items={unknown} />
              </div>
            </div>
          )}
        </div>
      </div>

      <p style={{ marginTop: 20 }}>
        <Link href="/sales/leads" className="muted" style={{ fontSize: 12.5 }}>
          ← Back to pipeline
        </Link>
      </p>
    </>
  );
}

function SignalGroup({
  label,
  tone,
  items,
}: {
  label: string;
  tone: string;
  items: [string, unknown][];
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <div
        className="muted"
        style={{
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.07em",
          fontWeight: 700,
          marginBottom: 7,
          color: tone,
        }}
      >
        {label}
      </div>
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
        {items.map(([k, v]) => (
          <span key={k} className="pill" style={{ fontSize: 10.5, padding: "2px 7px" }}>
            {k.replace(/_/g, " ")}
            {typeof v === "number" || Array.isArray(v) ? (
              <span style={{ opacity: 0.7 }}>{Array.isArray(v) ? v.join("/") : ` ${v}`}</span>
            ) : null}
          </span>
        ))}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "82px 1fr", gap: 10 }}>
      <span className="muted" style={{ fontSize: 12 }}>
        {label}
      </span>
      <span style={{ wordBreak: "break-word" }}>{children}</span>
    </div>
  );
}

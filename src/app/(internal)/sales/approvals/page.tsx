import Link from "next/link";
import { requireUser } from "@/lib/auth-server";
import { PageHeader } from "@/components/LocationTabs";
import { isConfigured, query } from "@/lib/sales/db/client";
import { setupState } from "@/lib/sales/kpi/overview";
import Setup from "../Setup";
import ApprovalActions from "./ApprovalActions";

export const dynamic = "force-dynamic";

/**
 * The approval queue — MODE 1's centre of gravity.
 *
 * Everything the agents do converges here, and in the first weeks this is the
 * page you live in. It shows the message exactly as it will be sent, beside
 * the research that produced it, so the question "is this claim true?" can be
 * answered without leaving the screen.
 *
 * Flagged drafts are listed separately and cannot be approved in bulk. A guard
 * failure is a signal that the prompt has drifted, and burying it in a list of
 * twenty green rows is how it gets approved by reflex.
 */

interface Row {
  id: number;
  lead_id: number;
  company: string;
  city: string | null;
  to_address: string;
  subject: string;
  body: string;
  status: string;
  guard_flags: string[];
  personalisation: {
    observation?: string;
    problem?: string;
    solution?: string;
    cta?: string;
    subjects?: string[];
    words?: number;
    similarity?: number;
    demoUrl?: string;
  };
  score: number | null;
  priority: string | null;
  summary: string | null;
  evidence: { claim: string; url: string; quote: string }[] | null;
  created_at: Date;
}

async function load(): Promise<Row[]> {
  if (!isConfigured()) return [];
  try {
    return await query<Row>(
      `select m.id, m.lead_id, c.name as company, c.city, m.to_address, m.subject,
              m.body, m.status::text, m.guard_flags, m.personalisation,
              l.current_score as score, l.priority::text, m.created_at,
              r.summary, r.evidence
         from sales.message m
         join sales.lead l on l.id = m.lead_id
         join sales.company c on c.id = l.company_id
         left join lateral (
           select summary, evidence from sales.research_record rr
            where rr.company_id = c.id order by rr.created_at desc limit 1
         ) r on true
        where m.direction = 'outbound'
          and m.status in ('pending_approval', 'draft')
        order by (m.status = 'pending_approval') desc,
                 l.current_score desc nulls last, m.created_at
        limit 100`,
    );
  } catch {
    return [];
  }
}

export default async function ApprovalsPage() {
  const user = await requireUser();
  if (user.role !== "owner") return null;

  const state = await setupState();
  if (state !== "ready") {
    return (
      <>
        <PageHeader title="Approvals" />
        <Setup state={state} />
      </>
    );
  }

  const rows = await load();
  const ready = rows.filter((r) => r.status === "pending_approval");
  const flagged = rows.filter((r) => r.status === "draft");

  return (
    <>
      <PageHeader
        title="Approvals"
        subtitle={
          rows.length === 0
            ? "Nothing waiting."
            : `${ready.length} ready to send · ${flagged.length} held back by a guard`
        }
      />

      {rows.length === 0 && (
        <div className="panel" style={{ padding: "28px 24px" }}>
          <p className="muted" style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
            No drafts waiting. Generate some with{" "}
            <code className="mono">npm run draft -- &quot;UAE Dental&quot;</code> — it only drafts
            for qualified leads that already have a demo.
          </p>
        </div>
      )}

      {flagged.length > 0 && (
        <section style={{ marginBottom: 26 }}>
          <h2 style={{ fontSize: 13, fontWeight: 700, margin: "0 0 10px", color: "var(--warn)" }}>
            Held back — {flagged.length}
          </h2>
          <p className="muted" style={{ fontSize: 12.5, margin: "0 0 12px", maxWidth: "70ch" }}>
            A guard refused these. They are shown so you can see what the agent got wrong — a
            pattern here means the prompt needs changing, not that these need approving.
          </p>
          {flagged.map((row) => (
            <Draft key={row.id} row={row} />
          ))}
        </section>
      )}

      {ready.length > 0 && (
        <section>
          <h2 style={{ fontSize: 13, fontWeight: 700, margin: "0 0 12px" }}>
            Ready to send — {ready.length}
          </h2>
          {ready.map((row) => (
            <Draft key={row.id} row={row} />
          ))}
        </section>
      )}
    </>
  );
}

function Draft({ row }: { row: Row }) {
  const problems = (row.guard_flags ?? []).filter((f) => !f.startsWith("warning:"));
  const warnings = (row.guard_flags ?? []).filter((f) => f.startsWith("warning:"));

  return (
    <div
      className="panel"
      style={{
        marginBottom: 16,
        borderColor: problems.length ? "var(--warn)" : "var(--border)",
      }}
    >
      <div className="panel-head" style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
        <Link href={`/sales/leads/${row.lead_id}`} style={{ fontWeight: 600 }}>
          {row.company}
        </Link>
        <span className="muted" style={{ fontWeight: 400, fontSize: 11.5 }}>
          {row.to_address}
          {row.score !== null ? ` · ${row.score} ${row.priority ?? ""}` : ""}
          {row.personalisation?.words ? ` · ${row.personalisation.words} words` : ""}
        </span>
      </div>

      <div className="split" style={{ padding: "16px 18px", gap: 20 }}>
        <div>
          <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
            Subject
          </div>
          <div style={{ fontWeight: 600, fontSize: 13.5, marginBottom: 14 }}>{row.subject}</div>

          <pre
            style={{
              whiteSpace: "pre-wrap",
              fontFamily: "inherit",
              fontSize: 13.5,
              lineHeight: 1.6,
              margin: 0,
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: "14px 16px",
            }}
          >
            {row.body}
          </pre>

          {problems.length > 0 && (
            <ul style={{ margin: "12px 0 0", paddingLeft: 18, fontSize: 12.5, color: "var(--warn)" }}>
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          {warnings.length > 0 && (
            <ul className="muted" style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 12 }}>
              {warnings.map((w) => (
                <li key={w}>{w.replace(/^warning:\s*/, "")}</li>
              ))}
            </ul>
          )}

          <ApprovalActions messageId={row.id} blocked={problems.length > 0} />
        </div>

        <div>
          {/* The research sits beside the draft on purpose: "is this claim
              true?" should be answerable without opening another page. */}
          <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
            What the research found
          </div>
          <p style={{ fontSize: 12.5, lineHeight: 1.55, margin: "0 0 12px" }}>
            {row.summary ?? "No research on file."}
          </p>

          {row.evidence && row.evidence.length > 0 && (
            <>
              <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
                Evidence
              </div>
              {row.evidence.slice(0, 5).map((e, i) => (
                <div key={i} style={{ marginBottom: 9 }}>
                  <div style={{ fontSize: 12, fontWeight: 600 }}>{e.claim}</div>
                  <a
                    href={e.url}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="muted mono"
                    style={{ fontSize: 10.5 }}
                  >
                    {e.url.replace(/^https?:\/\//, "").slice(0, 52)}
                  </a>
                </div>
              ))}
            </>
          )}

          {row.personalisation?.demoUrl && (
            <a
              href={row.personalisation.demoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn"
              style={{ marginTop: 8, display: "inline-block", fontSize: 12 }}
            >
              Hear the demo
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

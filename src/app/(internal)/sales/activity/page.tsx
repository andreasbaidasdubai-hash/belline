import Link from "next/link";
import { requireUser } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import { PageHeader } from "@/components/LocationTabs";
import { agentSummaries, recentActivity, setupState } from "@/lib/sales/kpi/overview";
import Setup from "../Setup";
import { ActivityFeed } from "../ui";

export const dynamic = "force-dynamic";

/**
 * The audit trail, unfiltered.
 *
 * Every action any agent has taken, newest first. This is the page that
 * answers "why did this company get this message on this date" — the question
 * a regulator asks, and the one an annoyed prospect's reply forces you to
 * answer within the hour.
 */

/**
 * Only the types something actually writes.
 *
 * `sent`, `replied`, `meeting_booked` and `suppressed` were offered as filters
 * and can never match: nothing sends, nothing classifies a reply, nothing
 * inserts into `sales.meeting`, and suppressing a company writes a row to
 * `sales.suppression` plus an `approved`/`rejected` activity — never a
 * `suppressed` one. A filter that always returns nothing reads as "no replies
 * yet" rather than "this cannot happen", which is the more expensive of the
 * two misunderstandings. They come back when their writers do — the activity
 * types themselves still exist in the repo.
 */
const TYPES = [
  "discovered",
  "researched",
  "scored",
  "drafted",
  "approved",
  "rejected",
  "demo_issued",
  "demo_used",
  "agent_paused",
  "error",
];

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ agent?: string; type?: string }>;
}) {
  const user = await requireUser();
  // See isBellineStaff: owning a tenant is not working here.
  if (!isBellineStaff(user)) {
    return <p className="muted">Belline staff only.</p>;
  }

  const state = await setupState();
  if (state !== "ready") {
    return (
      <>
        <PageHeader title="Activity" />
        <Setup state={state} />
      </>
    );
  }

  const { agent, type } = await searchParams;
  const agentId = agent ? Number(agent) : undefined;

  const [rows, agents] = await Promise.all([
    recentActivity(200, {
      agentId: Number.isFinite(agentId) ? agentId : undefined,
      type,
    }),
    agentSummaries(),
  ]);

  const href = (next: { agent?: string; type?: string }) => {
    const params = new URLSearchParams();
    const a = next.agent ?? (agent || "");
    const t = next.type ?? (type || "");
    if (a) params.set("agent", a);
    if (t) params.set("type", t);
    const q = params.toString();
    return q ? `/sales/activity?${q}` : "/sales/activity";
  };

  return (
    <>
      <PageHeader
        title="Activity"
        subtitle="Every action every agent has taken. Append-only — nothing here is ever edited or removed."
      />

      <div className="loc-tabs" style={{ marginBottom: 6 }}>
        <Filter label="All agents" href={href({ agent: "" })} on={!agent} />
        {agents
          .filter((a) => a.kind === "vertical_agent")
          .map((a) => (
            <Filter
              key={a.id}
              label={a.name.replace(/ Agent$/, "")}
              href={href({ agent: String(a.id) })}
              on={agent === String(a.id)}
            />
          ))}
      </div>

      <div className="loc-tabs" style={{ marginBottom: 16 }}>
        <Filter label="Everything" href={href({ type: "" })} on={!type} />
        {TYPES.map((t) => (
          <Filter
            key={t}
            label={t.replace(/_/g, " ")}
            href={href({ type: t })}
            on={type === t}
          />
        ))}
      </div>

      <div className="panel">
        <div className="panel-head">
          {rows.length === 200 ? "Latest 200" : `${rows.length} event${rows.length === 1 ? "" : "s"}`}
        </div>
        <ActivityFeed
          rows={rows}
          empty={
            agent || type
              ? "Nothing matches that filter."
              : "Nothing has happened yet. Run an agent from the command line."
          }
        />
      </div>
    </>
  );
}

function Filter({ label, href, on }: { label: string; href: string; on: boolean }) {
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

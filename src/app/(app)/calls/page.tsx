import Link from "next/link";
import { listCalls } from "@/lib/store";
import { requireUser, resolveLocation } from "@/lib/auth-server";
import { callDurationSeconds, medianLatency } from "@/lib/calls";
import { seedIfEmpty } from "@/lib/seed";
import { LocationTabs, PageHeader } from "@/components/LocationTabs";

export const dynamic = "force-dynamic";

export default async function CallsPage({
  searchParams,
}: {
  searchParams: Promise<{ loc?: string }>;
}) {
  seedIfEmpty();
  const user = await requireUser();
  const { loc } = await searchParams;
  const location = await resolveLocation(user, loc);
  if (!location) return <p className="muted">No venues are assigned to your account yet.</p>;

  const calls = listCalls(location.id);

  return (
    <>
      <PageHeader
        title="Calls"
        subtitle="Every call, with the full transcript and the tool trace behind it."
      />
      <LocationTabs base="/calls" active={location.id} />

      <div className="panel">
        {calls.length === 0 ? (
          <p className="muted" style={{ padding: "30px 18px", margin: 0, fontSize: 13 }}>
            No calls yet. Make one in the <Link href="/test" style={{ color: "var(--accent)" }}>test console</Link>.
          </p>
        ) : (
          <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Started</th>
                <th>Summary</th>
                <th style={{ width: 96 }}>Channel</th>
                <th style={{ width: 84 }}>Length</th>
                <th style={{ width: 96 }}>Latency</th>
                <th style={{ width: 150 }}>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {calls.map((c) => {
                const p50 = medianLatency(c);
                return (
                  <tr key={c.id}>
                    <td className="mono muted" style={{ fontSize: 12 }}>
                      {new Date(c.startedAt).toLocaleString()}
                    </td>
                    <td>
                      <Link href={`/calls/${c.id}`} style={{ fontWeight: 600 }}>
                        {c.summary ??
                          c.transcript.find((t) => t.role === "caller")?.text ??
                          "(no exchange)"}
                      </Link>
                      {c.escalation && (
                        <div style={{ fontSize: 11.5, color: "var(--warn)", marginTop: 3 }}>
                          ⚑ {c.escalation}
                        </div>
                      )}
                    </td>
                    <td className="muted" style={{ fontSize: 12 }}>{c.channel}</td>
                    <td className="mono" style={{ fontSize: 12 }}>{callDurationSeconds(c)}s</td>
                    <td
                      className="mono"
                      style={{
                        fontSize: 12,
                        color: p50 === null ? "var(--muted)" : p50 < 1200 ? "var(--ok)" : "var(--warn)",
                      }}
                    >
                      {p50 === null ? "—" : `${p50} ms`}
                    </td>
                    <td>
                      <span className="pill">{c.outcome?.replace(/_/g, " ") ?? c.status}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </>
  );
}

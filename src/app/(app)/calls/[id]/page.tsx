import Link from "next/link";
import { notFound } from "next/navigation";
import { getBooking, getCall, getLocation } from "@/lib/store";
import { canSeeLocation } from "@/lib/auth";
import { requireUser } from "@/lib/auth-server";
import { callDurationSeconds, medianLatency } from "@/lib/calls";
import { describeBooking } from "@/lib/booking";
import { PageHeader } from "@/components/LocationTabs";

export const dynamic = "force-dynamic";

export default async function CallDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const call = getCall(id);
  // A call id is guessable enough that this page needs its own check — the
  // layout only proves you are signed in, not that this venue is yours.
  if (!call || !canSeeLocation(user, call.locationId)) notFound();
  const location = getLocation(call.locationId);
  const booking = call.bookingId ? getBooking(call.bookingId) : undefined;
  const p50 = medianLatency(call);

  return (
    <>
      <PageHeader
        title={call.summary ?? "Call"}
        subtitle={`${new Date(call.startedAt).toLocaleString()} · ${callDurationSeconds(call)}s · ${call.channel} · ${call.from}`}
        right={
          <Link href="/calls" className="btn">
            ← All calls
          </Link>
        }
      />

      <div style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
        <span className="pill">{call.outcome?.replace(/_/g, " ") ?? call.status}</span>
        <span className="pill mono">
          {call.transcript.filter((t) => t.role === "caller").length} caller turns
        </span>
        <span className="pill mono">{call.toolCalls.length} tool calls</span>
        {p50 !== null && <span className="pill mono">p50 {p50} ms</span>}
      </div>

      {call.escalation && (
        <div
          className="panel"
          style={{
            padding: "13px 16px",
            marginBottom: 16,
            borderColor: "var(--warn)",
            background: "var(--warn-soft)",
            fontSize: 13,
          }}
        >
          <strong style={{ color: "var(--warn)" }}>Needs a human</strong>
          <div style={{ marginTop: 5 }}>{call.escalation}</div>
        </div>
      )}

      {booking && location && (
        <div
          className="panel"
          style={{
            padding: "13px 16px",
            marginBottom: 16,
            fontSize: 13,
            borderColor: "var(--ok)",
            background: "var(--ok-soft)",
          }}
        >
          <strong style={{ color: "var(--ok)" }}>Booking {booking.status}</strong>
          <div style={{ marginTop: 5 }}>{describeBooking(location, booking)}</div>
        </div>
      )}

      <div className="split">
        <div className="panel">
          <div style={{ padding: "13px 16px", borderBottom: "1px solid var(--border)", fontWeight: 600, fontSize: 13 }}>
            Transcript
          </div>
          <div style={{ padding: 16 }}>
            {call.transcript.length === 0 && (
              <p className="muted" style={{ fontSize: 13, margin: 0 }}>
                Nothing was said.
              </p>
            )}
            {call.transcript.map((turn, i) => (
              <div key={i} style={{ marginBottom: 13 }}>
                <div
                  className="muted"
                  style={{
                    fontSize: 10.5,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    fontWeight: 600,
                    color: turn.role === "agent" ? "var(--accent)" : "var(--muted)",
                  }}
                >
                  {turn.role}
                  {turn.latencyMs !== undefined && turn.latencyMs > 0 && (
                    <span className="mono" style={{ marginLeft: 8, opacity: 0.7 }}>
                      {turn.latencyMs} ms
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 13.5, lineHeight: 1.55, marginTop: 3 }}>{turn.text}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <div style={{ padding: "13px 16px", borderBottom: "1px solid var(--border)", fontWeight: 600, fontSize: 13 }}>
            Tool trace
          </div>
          <div style={{ padding: 12 }}>
            {call.toolCalls.length === 0 && (
              <p className="muted" style={{ fontSize: 13, margin: "8px 4px" }}>
                No tools were called.
              </p>
            )}
            {call.toolCalls.map((trace, i) => (
              <details
                key={i}
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  marginBottom: 8,
                  background: "var(--panel-2)",
                  padding: "9px 11px",
                }}
              >
                <summary style={{ cursor: "pointer", display: "flex", gap: 8, alignItems: "center" }}>
                  <span
                    className="mono"
                    style={{ fontSize: 12, fontWeight: 600, color: trace.ok ? "var(--accent)" : "var(--bad)" }}
                  >
                    {trace.name}
                  </span>
                  <span className="muted mono" style={{ fontSize: 11, marginLeft: "auto" }}>
                    {trace.ms} ms
                  </span>
                </summary>
                <pre
                  className="mono muted"
                  style={{
                    fontSize: 11,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    marginTop: 9,
                    marginBottom: 0,
                    lineHeight: 1.45,
                  }}
                >
                  {JSON.stringify({ in: trace.input, out: trace.output }, null, 2)}
                </pre>
              </details>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

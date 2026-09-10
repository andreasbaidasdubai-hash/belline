import Link from "next/link";
import { listBookings, listCalls } from "@/lib/store";
import { requireUser, resolveLocation } from "@/lib/auth-server";
import { callDurationSeconds } from "@/lib/calls";
import { describeBookingShort } from "@/lib/booking";
import { minutesToSpoken, todayIn } from "@/lib/time";
import { seedIfEmpty } from "@/lib/seed";
import { LocationTabs, PageHeader } from "@/components/LocationTabs";

export const dynamic = "force-dynamic";

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "ok" | "warn";
}) {
  return (
    <div className="panel" style={{ padding: "16px 18px" }}>
      <div className="muted" style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>
        {label}
      </div>
      <div
        style={{
          fontSize: 31,
          fontWeight: 300,
          marginTop: 9,
          letterSpacing: "-0.03em",
          fontVariantNumeric: "tabular-nums",
          color: tone === "ok" ? "var(--ok)" : tone === "warn" ? "var(--warn)" : "var(--text)",
        }}
      >
        {value}
      </div>
      {hint && (
        <div className="muted" style={{ fontSize: 11.5, marginTop: 5 }}>
          {hint}
        </div>
      )}
    </div>
  );
}

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ loc?: string }>;
}) {
  seedIfEmpty();
  const user = await requireUser();
  const { loc } = await searchParams;
  const location = await resolveLocation(user, loc);

  if (!location) {
    return <p className="muted">No venues are assigned to your account yet.</p>;
  }

  const today = todayIn(location.timezone);
  const calls = listCalls(location.id);
  const completed = calls.filter((c) => c.status === "completed");
  const bookings = listBookings({ locationId: location.id, status: "confirmed" });
  const todays = bookings
    .filter((b) => b.date === today)
    .sort((a, b) => a.startMin - b.startMin);

  const voiceBookings = bookings.filter((b) => b.source === "voice");
  const handled = completed.filter(
    (c) => c.outcome && c.outcome !== "transferred" && c.outcome !== "abandoned",
  );
  const containment = completed.length
    ? Math.round((handled.length / completed.length) * 100)
    : null;

  const latencies = calls.flatMap((c) => c.latenciesMs).sort((a, b) => a - b);
  const p50 = latencies.length ? latencies[Math.floor(latencies.length / 2)] : null;
  const p90 = latencies.length
    ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.9))]
    : null;

  const covers = todays.reduce((n, b) => n + (b.partySize ?? 1), 0);

  return (
    <>
      <PageHeader
        title={location.name}
        subtitle={`${location.address} · ${location.phone} · agent "${location.agent.displayName}"`}
        right={
          <Link href={`/test?loc=${location.id}`} className="btn btn-accent">
            Call the agent
          </Link>
        }
      />
      <LocationTabs base="/" active={location.id} />

      <div className="stats">
        <Stat label="Calls handled" value={String(completed.length)} hint="all time" />
        <Stat
          label="Contained"
          value={containment === null ? "—" : `${containment}%`}
          hint="resolved without a human"
          tone={containment !== null && containment >= 70 ? "ok" : undefined}
        />
        <Stat
          label="Bookings by voice"
          value={String(voiceBookings.length)}
          hint={`${bookings.length} total on the book`}
        />
        <Stat
          label="Response p50"
          value={p50 === null ? "—" : `${p50} ms`}
          hint={p90 === null ? "no turns yet" : `p90 ${p90} ms`}
          tone={p50 !== null && p50 < 1200 ? "ok" : p50 !== null ? "warn" : undefined}
        />
        <Stat
          label={location.vertical === "restaurant" ? "Covers today" : "Appointments today"}
          value={String(location.vertical === "restaurant" ? covers : todays.length)}
          hint={todays.length ? `first at ${minutesToSpoken(todays[0].startMin)}` : "nothing booked"}
        />
      </div>

      <div className="split">
        <div className="panel">
          <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)", fontWeight: 600, fontSize: 13 }}>
            Today&apos;s book
            <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>
              {today}
            </span>
          </div>
          {todays.length === 0 ? (
            <p className="muted" style={{ padding: "26px 16px", fontSize: 13, margin: 0 }}>
              Nothing booked today. Open the test console and make a reservation — it lands here.
            </p>
          ) : (
            <table>
              <tbody>
                {todays.map((b) => (
                  <tr key={b.id}>
                    <td
                      className="mono"
                      style={{ width: 84, color: "var(--accent)", whiteSpace: "nowrap" }}
                    >
                      {minutesToSpoken(b.startMin)}
                    </td>
                    <td>
                      <div style={{ fontWeight: 600 }}>{b.guestName}</div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {describeBookingShort(location, b)}
                      </div>
                    </td>
                    <td style={{ width: 78, textAlign: "right" }}>
                      <span className="pill mono">{b.ref}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="panel">
          <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)", fontWeight: 600, fontSize: 13 }}>
            Recent calls
          </div>
          {calls.length === 0 ? (
            <p className="muted" style={{ padding: "26px 16px", fontSize: 13, margin: 0 }}>
              No calls yet.
            </p>
          ) : (
            <table>
              <tbody>
                {calls.slice(0, 8).map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link href={`/calls/${c.id}`} style={{ fontWeight: 600 }}>
                        {c.summary ?? c.transcript.find((t) => t.role === "caller")?.text ?? "—"}
                      </Link>
                      <div className="muted" style={{ fontSize: 11.5, marginTop: 3 }}>
                        {new Date(c.startedAt).toLocaleString()} · {callDurationSeconds(c)}s ·{" "}
                        {c.channel}
                      </div>
                    </td>
                    <td style={{ width: 130, textAlign: "right" }}>
                      <span className="pill">{c.outcome?.replace(/_/g, " ") ?? c.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}

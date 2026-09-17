import Link from "next/link";
import { isBellineStaff, visibleLocations } from "@/lib/auth";
import { requireUser } from "@/lib/auth-server";
import { listCalls } from "@/lib/store";
import { callsToday, demoLocations, maxCallSeconds } from "@/lib/demo";
import { callDurationSeconds } from "@/lib/calls";
import { seedIfEmpty } from "@/lib/seed";
import { venueChip } from "@/lib/verticals";
import { FILS_PER_USD } from "@/lib/billing/cost";
import { ConsoleHeader, EmptyState, Pill, Stat, aed, ago } from "../../ui";
import SettingsTabs from "../SettingsTabs";

export const dynamic = "force-dynamic";

/** Cost per answered minute, all four vendors. Approximate, deliberately high. */
const COST_PER_MINUTE_USD = 0.09;

/**
 * The demo lines: the numbers a prospect can ring to hear Belline for
 * themselves. Capped, disclosed and self-cleaning, because anybody can dial
 * them and every minute costs money. Moved here from the customer dashboard.
 */
export default async function DemoLinesPage() {
  seedIfEmpty();
  const user = await requireUser();
  if (!isBellineStaff(user)) return <p className="muted">Belline staff only.</p>;

  // Belline's own demo venues only: scoped to the staff member's tenants.
  const lines = demoLocations(visibleLocations(user));
  const mine = new Set(lines.map((l) => l.id));
  const calls = listCalls().filter((c) => c.isDemo && mine.has(c.locationId));
  const minutes = calls.reduce((n, c) => n + callDurationSeconds(c) / 60, 0);

  return (
    <>
      <ConsoleHeader title="Settings" subtitle="Demo lines: the numbers a prospect can ring to hear Belline answer as their own trade." />
      <SettingsTabs active="/sales/settings/demo-lines" />

      <div className="stats">
        <Stat label="Demo calls" value={String(calls.length)} hint="all time" />
        <Stat label="Spent on demo calls" value={aed(Math.round(minutes * COST_PER_MINUTE_USD * FILS_PER_USD))} hint={`${minutes.toFixed(0)} min, estimated on the high side`} />
        <Stat label="Details left" value={String(calls.filter((c) => c.escalation).length)} hint="callers who left their details" tone="ok" />
      </div>

      <section className="panel staff-section" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          Lines<span className="muted">one per trade, so a prospect hears their own</span>
        </div>
        {lines.length === 0 ? (
          <EmptyState title="No demo lines">A demo line is a location with the demo setting on and a Belline number.</EmptyState>
        ) : (
          <div className="table-wrap" tabIndex={0}>
            <table className="staff-table">
              <thead>
                <tr>
                  <th>Line</th>
                  <th>Number to dial</th>
                  <th>Today</th>
                  <th>Longest call</th>
                  <th>Opens with</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => {
                  const used = callsToday(l);
                  const limit = l.demo!.maxCallsPerDay;
                  return (
                    <tr key={l.id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{l.name}</div>
                        <div className="sub">{venueChip(l)}</div>
                      </td>
                      <td className="mono" style={{ fontSize: 13 }}>
                        {l.bellineNumber?.number ?? <span className="muted">no number yet</span>}
                      </td>
                      <td>
                        {used} of {limit}
                        {used >= limit && (
                          <div>
                            <Pill tone="bad">closed for today</Pill>
                          </div>
                        )}
                      </td>
                      <td>{Math.round(maxCallSeconds(l, "phone") / 60)} min</td>
                      <td className="sub" style={{ maxWidth: 320 }}>
                        {l.demo!.disclosure}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel staff-section">
        <div className="panel-head">Recent demo calls</div>
        {calls.length === 0 ? (
          <EmptyState title="Nobody has rung a demo line yet">
            Give each line a real phone number that points at Belline, and the line answers: calls are routed by the number dialled.
          </EmptyState>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {calls.slice(0, 15).map((c) => (
              <li key={c.id} style={{ padding: "10px 18px", borderTop: "1px solid var(--bl-rule-soft)" }}>
                <Link href={`/calls/${c.id}`} style={{ fontWeight: 600, fontSize: 13 }}>
                  {c.summary ?? "No summary"}
                </Link>
                {c.escalation && <div style={{ fontSize: 12, color: "var(--bl-success)", marginTop: 3 }}>{c.escalation}</div>}
                <div className="sub">
                  {ago(c.startedAt)} · {c.from} · {Math.round(callDurationSeconds(c))} s
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

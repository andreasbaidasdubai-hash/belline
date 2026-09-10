import Link from "next/link";
import { notFound } from "next/navigation";
import { canManageUsers } from "@/lib/auth";
import { requireUser } from "@/lib/auth-server";
import { listCalls, listLocations } from "@/lib/store";
import { callsToday, demoLocations, maxCallSeconds } from "@/lib/demo";
import { callDurationSeconds } from "@/lib/calls";
import { seedIfEmpty } from "@/lib/seed";
import { PageHeader } from "@/components/LocationTabs";

export const dynamic = "force-dynamic";

/** Cost per answered minute, all four vendors. Approximate, deliberately high. */
const COST_PER_MINUTE = 0.09;

export default async function DemoPage() {
  seedIfEmpty();
  const user = await requireUser();
  if (!canManageUsers(user)) notFound();

  const lines = demoLocations(listLocations());
  const allDemoCalls = listCalls().filter((c) => c.isDemo);
  const minutes = allDemoCalls.reduce(
    (n, c) => n + callDurationSeconds(c) / 60,
    0,
  );

  return (
    <>
      <PageHeader
        title="Demo line"
        subtitle="The numbers a prospect can ring to hear it themselves. Capped, disclosed, and self-cleaning — anyone can dial these, so they spend your money."
      />

      <div className="stats">
        <div className="panel" style={{ padding: "16px 18px" }}>
          <div className="muted" style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>
            Demo calls
          </div>
          <div style={{ fontSize: 31, fontWeight: 300, marginTop: 9, letterSpacing: "-0.03em" }}>
            {allDemoCalls.length}
          </div>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 5 }}>all time</div>
        </div>
        <div className="panel" style={{ padding: "16px 18px" }}>
          <div className="muted" style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>
            Spent on demos
          </div>
          <div style={{ fontSize: 31, fontWeight: 300, marginTop: 9, letterSpacing: "-0.03em" }}>
            ${(minutes * COST_PER_MINUTE).toFixed(2)}
          </div>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 5 }}>
            {minutes.toFixed(0)} min at ~${COST_PER_MINUTE.toFixed(2)}/min
          </div>
        </div>
        <div className="panel" style={{ padding: "16px 18px" }}>
          <div className="muted" style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>
            Messages captured
          </div>
          <div style={{ fontSize: 31, fontWeight: 300, marginTop: 9, letterSpacing: "-0.03em", color: "var(--ok)" }}>
            {allDemoCalls.filter((c) => c.escalation).length}
          </div>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 5 }}>
            prospects who left details
          </div>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          Lines
          <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>
            one per vertical, so a prospect hears their own trade
          </span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Venue</th>
                <th style={{ width: 168 }}>Number to dial</th>
                <th style={{ width: 130 }}>Today</th>
                <th style={{ width: 110 }}>Max call</th>
                <th>Opens with</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const used = callsToday(l);
                const limit = l.demo!.maxCallsPerDay;
                const spent = used >= limit;
                return (
                  <tr key={l.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{l.name}</div>
                      <div className="muted" style={{ fontSize: 12 }}>{l.vertical}</div>
                    </td>
                    <td className="mono" style={{ fontSize: 13 }}>{l.phone}</td>
                    <td>
                      <span
                        className="mono"
                        style={{ color: spent ? "var(--bad)" : "var(--text)" }}
                      >
                        {used} / {limit}
                      </span>
                      {spent && (
                        <div style={{ fontSize: 11, color: "var(--bad)" }}>closed today</div>
                      )}
                    </td>
                    <td className="mono" style={{ fontSize: 12.5 }}>
                      {Math.round(maxCallSeconds(l) / 60)} min
                    </td>
                    <td className="muted" style={{ fontSize: 12 }}>
                      {l.demo!.disclosure}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">Recent demo calls</div>
        {allDemoCalls.length === 0 ? (
          <p className="muted" style={{ padding: "26px 18px", margin: 0, fontSize: 13 }}>
            Nobody has rung a demo line yet. Set each venue&apos;s phone number to a
            real Twilio number, point its voice webhook at{" "}
            <span className="mono">/api/twilio/voice</span>, and the line is live —
            the webhook already routes by the number dialled.
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <tbody>
                {allDemoCalls.slice(0, 15).map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link href={`/calls/${c.id}`} style={{ fontWeight: 600 }}>
                        {c.summary ?? "(no summary)"}
                      </Link>
                      {c.escalation && (
                        <div style={{ fontSize: 12, color: "var(--ok)", marginTop: 3 }}>
                          ✦ {c.escalation}
                        </div>
                      )}
                      <div className="muted" style={{ fontSize: 11.5, marginTop: 3 }}>
                        {new Date(c.startedAt).toLocaleString()} · {c.from} ·{" "}
                        {callDurationSeconds(c)}s
                      </div>
                    </td>
                    <td style={{ width: 150, textAlign: "right" }}>
                      <span className="pill">{c.outcome?.replace(/_/g, " ") ?? c.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

import Link from "next/link";
import { requireUser, resolveLocation } from "@/lib/auth-server";
import { seedIfEmpty } from "@/lib/seed";
import { overviewFor, summarise } from "@/lib/overview";
import { readiness } from "@/lib/onboarding";
import { callDurationSeconds } from "@/lib/calls";
import { isRestaurant, terms } from "@/lib/verticals";
import { LocationTabs, PageHeader } from "@/components/LocationTabs";

export const dynamic = "force-dynamic";

/**
 * Home.
 *
 * The question an owner opens this to ask is "did it earn its keep, and does
 * anything need me?" — so the page answers those two, in that order, and
 * nothing else competes for the top of the screen. It used to open with a
 * latency percentile, which is true, measurable, and answers neither.
 */

function Did({ n, label, tone }: { n: number; label: string; tone?: "good" | "quiet" }) {
  if (n === 0 && tone === "quiet") return null;
  return (
    <div style={{ minWidth: 92 }}>
      <div
        style={{
          fontSize: 27,
          fontWeight: 300,
          letterSpacing: "-0.035em",
          lineHeight: 1.05,
          fontVariantNumeric: "tabular-nums",
          color: tone === "good" && n > 0 ? "var(--ok)" : "var(--text)",
        }}
      >
        {n}
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginTop: 3 }}>
        {label}
      </div>
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
  if (!location) return <p className="muted">No venues are assigned to your account yet.</p>;

  const { did, worth, health, needsYou, recent } = overviewFor(location);
  const t = terms(location);
  const unwell = health.filter((h) => !h.ok);
  // A venue with no number, no services and no staff cannot answer anybody,
  // and the summary used to say it was listening. The missing list already
  // existed for the setup screen; the home page is where it is needed.
  const setup = readiness(location);

  return (
    <>
      <PageHeader
        title={location.name}
        subtitle={[location.address, location.phone || "no number yet"].filter(Boolean).join(" · ")}
        right={
          <Link href={`/calendar?loc=${location.id}`} className="btn btn-accent">
            Today&apos;s diary
          </Link>
        }
      />
      <LocationTabs base="/" active={location.id} />

      {/* What it did. One sentence first, because that is what gets read. */}
      <div className="panel" style={{ padding: "20px 22px", marginBottom: 14 }}>
        <p style={{ fontSize: 16, lineHeight: 1.5, margin: 0, maxWidth: "58ch", color: "var(--text)" }}>
          {setup.ready || did.answered > 0
            ? summarise(location, did)
            : `Belline can't answer for ${location.name} yet — a few things to finish first.`}
        </p>
        {!setup.ready && (
          <ul style={{ margin: "14px 0 0", padding: 0, listStyle: "none", display: "grid", gap: 8 }}>
            {setup.missing.map((m) => (
              <li key={m.label} style={{ fontSize: 13.5 }}>
                <Link href={`${m.where}?loc=${location.id}`} style={{ color: "var(--accent)", textDecoration: "underline" }}>
                  {m.label}
                </Link>
              </li>
            ))}
          </ul>
        )}

        {did.answered > 0 && (
          <div
            style={{
              display: "flex",
              gap: 30,
              flexWrap: "wrap",
              marginTop: 20,
              paddingTop: 18,
              borderTop: "1px solid var(--border-soft)",
            }}
          >
            <Did n={did.booked} label={t.booking === "reservation" ? "booked" : "appointments"} tone="good" />
            <Did n={did.moved} label="moved" tone="quiet" />
            <Did n={did.cancelled} label="cancelled" tone="quiet" />
            <Did n={did.questions} label="questions answered" tone="quiet" />
            <Did n={did.messages} label="messages taken" tone="quiet" />
            <Did n={did.escalated} label="sent to a person" tone="quiet" />
            <Did n={did.abandoned} label="rang off" tone="quiet" />
          </div>
        )}
      </div>

      {/* Anything broken goes above anything good. */}
      {unwell.length > 0 && (
        <div
          className="panel"
          style={{
            padding: "15px 18px",
            marginBottom: 14,
            borderColor: "var(--bad)",
            background: "var(--bad-soft)",
          }}
        >
          <div style={{ fontWeight: 600, fontSize: 13.5, color: "var(--bad)" }}>
            {unwell.length === 1 ? "One thing needs fixing" : `${unwell.length} things need fixing`}
          </div>
          {unwell.map((h) => (
            <div key={h.label} style={{ fontSize: 13, marginTop: 6, lineHeight: 1.5 }}>
              <strong>{h.label}.</strong> <span className="muted">{h.detail}</span>
              {h.fix && <span className="muted"> {h.fix}</span>}
            </div>
          ))}
        </div>
      )}

      {/*
        Says the venue's name because the sidebar badge counts every venue this
        user can see — without it, the same words carry two different numbers on
        the same screen. And "things", not "calls": a freed slot with somebody
        waiting for it has no call attached.
      */}
      {needsYou.total > 0 && (
        <Link
          href={`/attention?loc=${location.id}`}
          className="panel"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "15px 18px",
            marginBottom: 14,
          }}
        >
          <span
            style={{
              minWidth: 26,
              height: 26,
              padding: "0 8px",
              borderRadius: 999,
              background: "var(--bad)",
              color: "#fff",
              fontSize: 13,
              fontWeight: 700,
              display: "grid",
              placeItems: "center",
              fontVariantNumeric: "tabular-nums",
              flexShrink: 0,
            }}
          >
            {needsYou.total}
          </span>
          <span style={{ minWidth: 0 }}>
            <span style={{ fontSize: 14, fontWeight: 600, display: "block" }}>
              {needsYou.total === 1 ? "One thing needs you" : `${needsYou.total} things need you`} at{" "}
              {location.name}
            </span>
            {needsYou.top && (
              <span className="muted" style={{ fontSize: 12.5, display: "block", marginTop: 3 }}>
                Most urgent — {needsYou.top.who}: {needsYou.top.todo}
              </span>
            )}
          </span>
          <span className="muted" style={{ fontSize: 12.5, marginLeft: "auto", flexShrink: 0 }}>
            Open →
          </span>
        </Link>
      )}

      <div className="split">
        <div className="panel">
          <div className="panel-head">Recent calls</div>
          {recent.length === 0 ? (
            <p className="muted" style={{ padding: "26px 16px", fontSize: 13, margin: 0 }}>
              No calls yet. Ring the number, or use the{" "}
              <Link href="/test" style={{ color: "var(--accent)" }}>test console</Link>.
            </p>
          ) : (
            <table>
              <tbody>
                {recent.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link href={`/calls/${c.id}`} style={{ fontWeight: 600 }}>
                        {c.summary ?? c.transcript.find((tr) => tr.role === "caller")?.text ?? "—"}
                      </Link>
                      <div className="muted" style={{ fontSize: 11.5, marginTop: 3 }}>
                        {new Date(c.startedAt).toLocaleString()} · {callDurationSeconds(c)}s
                      </div>
                    </td>
                    <td style={{ width: 128, textAlign: "right" }}>
                      <span className="pill">{c.outcome?.replace(/_/g, " ") ?? c.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div>
          <div className="panel" style={{ marginBottom: 14 }}>
            <div className="panel-head">
              Bookings taken by Belline
              <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>
                last {worth.days} days
              </span>
            </div>
            <div style={{ padding: "18px 18px 20px" }}>
              <div
                style={{
                  fontSize: 34,
                  fontWeight: 300,
                  letterSpacing: "-0.035em",
                  lineHeight: 1,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {worth.bookings}
              </div>

              {worth.estimate === null ? (
                <p className="muted" style={{ fontSize: 12.5, margin: "12px 0 0", lineHeight: 1.55 }}>
                  Tell us what a{" "}
                  {isRestaurant(location) ? "cover" : t.booking} is typically worth and this will
                  show an estimate of what they came to. We will not guess it for you.
                </p>
              ) : (
                <>
                  <div style={{ fontSize: 15, marginTop: 12, fontWeight: 600 }}>
                    ≈ {worth.currency} {worth.estimate.toLocaleString()}
                  </div>
                  <p className="muted" style={{ fontSize: 11.5, margin: "6px 0 0", lineHeight: 1.5 }}>
                    An estimate, from the average you entered — not measured revenue.
                  </p>
                </>
              )}
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">Belline health</div>
            <div style={{ padding: "12px 18px 16px" }}>
              {health.map((h) => (
                <div
                  key={h.label}
                  style={{ display: "flex", gap: 9, alignItems: "baseline", padding: "6px 0" }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: "50%",
                      background: h.ok ? "var(--ok)" : "var(--bad)",
                      flexShrink: 0,
                      marginTop: 5,
                    }}
                  />
                  <span style={{ fontSize: 13, minWidth: 116 }}>{h.label}</span>
                  <span className="muted" style={{ fontSize: 11.5, lineHeight: 1.45 }}>
                    {h.detail}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

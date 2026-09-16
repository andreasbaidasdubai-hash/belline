import Link from "next/link";
import { requireUser, resolveLocation } from "@/lib/auth-server";
import { seedIfEmpty } from "@/lib/seed";
import { overviewFor, summarise, visibleHealth } from "@/lib/overview";
import { isBellineStaff } from "@/lib/auth";
import { readiness } from "@/lib/onboarding";
import { channelStatuses, checklistOf, factsFrom, isActivated, journeyFor } from "@/lib/onboarding/journey";
import { testsStale } from "@/lib/onboarding/selftest-state";
import { ownerNotice } from "@/lib/billing/entitlement";
import { raisePacksHeldIfPaymentsClosed, raiseTrialCapIfPaymentsClosed } from "@/lib/billing/trial-end";
import { todayIn } from "@/lib/time";
import { callDurationSeconds } from "@/lib/calls";
import { listCalls } from "@/lib/store";
import { bellineNumberOf } from "@/lib/telephony/number";
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

  const overview = overviewFor(location);
  const { did, worth, needsYou, recent } = overview;
  // Staff see every line and the panel; an owner sees only what is theirs.
  const staff = isBellineStaff(user);
  const health = visibleHealth(overview.health, staff);
  const t = terms(location);
  const unwell = health.filter((h) => !h.ok);
  // A venue with no number, no services and no staff cannot answer anybody,
  // and the summary used to say it was listening. The missing list already
  // existed for the setup screen; the home page is where it is needed.
  const setup = readiness(location);
  const today = todayIn(location.timezone);
  // Before the sentence that says the team has been told, so it is true.
  raiseTrialCapIfPaymentsClosed(location, today);
  raisePacksHeldIfPaymentsClosed(location, today);
  const notice = ownerNotice(location, today);
  // Before going live the home page leads with what is left of setup, as a
  // checklist: every item opens its step, in any order. A live venue keeps the
  // page it had. `path` is null once live.
  const path = isActivated(location) ? null : journeyFor(location);
  const checklist = path ? checklistOf(path) : null;
  const channels = location.demo?.enabled ? [] : channelStatuses(location, factsFrom(location, listCalls(location.id)));

  return (
    <>
      <PageHeader
        title={location.name}
        subtitle={[location.address, location.businessPhone || "no number yet"].filter(Boolean).join(" · ")}
        right={
          <Link href={`/calendar?loc=${location.id}`} className="btn btn-accent">
            Today&apos;s diary
          </Link>
        }
      />
      <LocationTabs base="/" active={location.id} />

      {/* The two things that stop a real call arriving, above everything else. */}
      {(notice || (!path && !bellineNumberOf(location))) && !location.demo?.enabled && (
        <div className="panel" role={notice?.stopped ? "alert" : undefined} style={{ padding: "15px 18px", marginBottom: 14, borderColor: notice ? "var(--bad)" : "var(--warn)" }}>
          <div style={{ fontSize: 13.5, lineHeight: 1.5 }}>
            {notice ? notice.sentence : "No phone line points at Belline yet, so no real call can reach it."}{" "}
            {notice ? (
              notice.choosePlan && (
                <Link href="/checkout" style={{ color: "var(--accent)", textDecoration: "underline" }}>
                  Choose a plan
                </Link>
              )
            ) : (
              <Link href={`/golive?loc=${location.id}`} style={{ color: "var(--accent)", textDecoration: "underline" }}>
                Go live
              </Link>
            )}
          </div>
        </div>
      )}

      {/* Live, and the setup changed after the checks. Worth a look, never a block. */}
      {!path && testsStale(location) && (
        <div className="panel" role="status" style={{ padding: "13px 18px", marginBottom: 14, fontSize: 13.5, lineHeight: 1.5 }}>
          You changed your setup since the last checks.{" "}
          <Link href="/setup/test" style={{ color: "var(--accent)", textDecoration: "underline" }}>
            Re-run checks
          </Link>
        </div>
      )}

      {/* What it did. One sentence first, because that is what gets read. */}
      <div className="panel" style={{ padding: "20px 22px", marginBottom: 14 }}>
        <p style={{ fontSize: 16, lineHeight: 1.5, margin: 0, maxWidth: "58ch", color: "var(--text)" }}>
          {setup.ready || did.answered > 0
            ? summarise(location, did)
            : `Belline can't answer for ${location.name} yet — a few things to finish first.`}
        </p>
        {checklist && (
          <div style={{ marginTop: 16 }} data-testid="setup-checklist">
            <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
              <strong style={{ fontSize: 14 }}>
                Setup: {checklist.done} of {checklist.total} done
              </strong>
              {checklist.next ? (
                <Link href={checklist.next.url} className="btn btn-accent" data-testid="journey-next">
                  Next: {checklist.next.title}
                </Link>
              ) : (
                path?.canGoLive && (
                  <Link href="/setup/golive" className="btn btn-accent" data-testid="journey-next">
                    Next: Go live
                  </Link>
                )
              )}
            </div>
            <p className="muted" style={{ fontSize: 12.5, margin: "6px 0 0", lineHeight: 1.5, maxWidth: "60ch" }}>
              Do them in any order, or come back later. Your dashboard works meanwhile; Belline answers real customers only
              once the checks pass and you go live.
            </p>
            <ol style={{ listStyle: "none", margin: "12px 0 0", padding: 0, display: "grid", gap: 6 }}>
              {checklist.items.map((s) => (
                <li key={s.id} style={{ fontSize: 13.5, display: "flex", gap: 8, alignItems: "baseline" }}>
                  <span aria-hidden="true" style={{ width: 18, color: s.done ? "var(--ok)" : "var(--text-2)" }}>
                    {s.done ? "✓" : "○"}
                  </span>
                  <Link href={s.url} style={{ color: s.done ? "var(--text-2)" : "var(--accent)", textDecoration: s.done ? "none" : "underline" }}>
                    {s.title}
                  </Link>
                  <span className="sr-only">{s.done ? " (done)" : " (not done)"}</span>
                </li>
              ))}
            </ol>
          </div>
        )}
        {!path && !setup.ready && (
          <Link href={`/setup/assistant?loc=${location.id}`} className="btn btn-accent" style={{ marginTop: 14, display: "inline-block" }}>
            Set it up with Belle
          </Link>
        )}
        {!path && !setup.ready && (
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

      {/* Where it answers, channel by channel, and nothing shown as live that is not. */}
      {channels.length > 0 && (
        <div className="panel" style={{ padding: "15px 18px", marginBottom: 14 }} data-testid="today-channels">
          <div style={{ fontWeight: 600, fontSize: 13.5, marginBottom: 8 }}>Where Belline answers</div>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
            {channels.map((c) => (
              <li key={c.id} data-channel={c.id} data-state={c.state} style={{ fontSize: 13, lineHeight: 1.5 }}>
                <Link href={c.href} style={{ fontWeight: 600 }}>
                  {c.label}
                </Link>{" "}
                <span className="pill" style={{ marginLeft: 6, color: c.state === "live" ? "var(--ok)" : c.state === "waiting" ? "var(--warn)" : "var(--text-2)" }}>
                  {c.state === "live" ? "Live" : c.state === "waiting" ? "Waiting" : "Not set up"}
                </span>
                <span style={{ color: "var(--text-2)", display: "block" }}>{c.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

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
            // --text-2, not .muted: grey on --bad-soft measured 4.15:1.
            <div key={h.label} style={{ fontSize: 13, marginTop: 6, lineHeight: 1.5 }}>
              <strong>{h.label}.</strong> <span style={{ color: "var(--text-2)" }}>{h.detail}</span>
              {h.fix && <span style={{ color: "var(--text-2)" }}> {h.fix}</span>}
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

          {staff && (
          <div className="panel" data-testid="health-panel">
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
          )}
        </div>
      </div>
    </>
  );
}

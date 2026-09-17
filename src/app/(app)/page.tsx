import Link from "next/link";
import { requireUser, resolveLocation } from "@/lib/auth-server";
import { seedIfEmpty } from "@/lib/seed";
import { handledOver, overviewFor, summarise, visibleHealth } from "@/lib/overview";
import { isBellineStaff } from "@/lib/auth";
import { attentionFor, KIND_LABEL } from "@/lib/attention";
import { channelStatuses, checklistOf, factsFrom, isActivated, journeyFor } from "@/lib/onboarding/journey";
import { testsStale } from "@/lib/onboarding/selftest-state";
import { ownerNotice } from "@/lib/billing/entitlement";
import { raisePacksHeldIfPaymentsClosed, raiseTrialCapIfPaymentsClosed } from "@/lib/billing/trial-end";
import { takesRequestsOnly } from "@/lib/booking/destination";
import { usesDiary } from "@/lib/nav";
import { todayIn } from "@/lib/time";
import { callDurationSeconds } from "@/lib/calls";
import { listCalls } from "@/lib/store";
import { isRestaurant, terms } from "@/lib/verticals";
import { LocationTabs, PageHeader } from "@/components/LocationTabs";
import Inbox from "./attention/Inbox";

export const dynamic = "force-dynamic";

/**
 * Home.
 *
 * The questions an owner opens this to ask are "does anything need me?", "did
 * it earn its keep?" and, until it is live, "what is left to set up?" — so the
 * page answers those, in that order, and nothing else competes for the top of
 * the screen. It used to open with a latency percentile, which is true,
 * measurable, and answers none of them.
 *
 * The numbers that were worth reading on the old Reports page are here now,
 * said as what Belline handled rather than how many calls "ended in a
 * booking": for a business that takes requests that number is always nought,
 * and it read as failure.
 */

const PERIODS = [7, 30] as const;

function Tile({ n, label }: { n: number; label: string }) {
  return (
    <div style={{ minWidth: 110 }}>
      <div style={{ fontSize: 27, fontWeight: 300, letterSpacing: "-0.035em", lineHeight: 1.05, fontVariantNumeric: "tabular-nums" }}>{n}</div>
      <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
        {label}
      </div>
    </div>
  );
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ loc?: string; days?: string }>;
}) {
  seedIfEmpty();
  const user = await requireUser();
  const { loc, days: rawDays } = await searchParams;
  const location = await resolveLocation(user, loc);
  if (!location) return <p className="muted">No venues are assigned to your account yet.</p>;

  const overview = overviewFor(location);
  const { did, worth, recent } = overview;
  // Staff see every line and the panel; an owner sees only what is theirs.
  const staff = isBellineStaff(user);
  const health = visibleHealth(overview.health, staff);
  const t = terms(location);
  const unwell = health.filter((h) => !h.ok);
  const today = todayIn(location.timezone);
  // Before the sentence that says the team has been told, so it is true.
  raiseTrialCapIfPaymentsClosed(location, today);
  raisePacksHeldIfPaymentsClosed(location, today);
  const notice = ownerNotice(location, today);
  // Until the venue goes live, Home carries what is left of setup as a
  // checklist: every item opens its step, in any order. `path` is null once live.
  const path = isActivated(location) ? null : journeyFor(location);
  const checklist = path ? checklistOf(path) : null;
  const facts = factsFrom(location, listCalls(location.id));
  const channels = location.demo?.enabled ? [] : channelStatuses(location, facts);
  // Live, and no way in connected: nothing can reach it, and that is said first.
  const unreachable = !path && channels.length > 0 && !channels.some((c) => c.state === "live");

  const needs = attentionFor(location);
  const waitingRequests = needs.filter((i) => i.kind === "booking_request").length;
  const days = PERIODS.find((d) => String(d) === rawDays) ?? 7;
  const handled = handledOver(location, days);
  const books = !takesRequestsOnly(location);
  const manager = user.role !== "staff";
  const locQuery = `loc=${location.id}`;

  return (
    <>
      <PageHeader
        title={location.name}
        subtitle={[location.address, location.businessPhone].filter(Boolean).join(" · ") || undefined}
        right={
          usesDiary(location) ? (
            <Link href={`/calendar?${locQuery}`} className="btn btn-accent">
              Today&apos;s diary
            </Link>
          ) : (
            <Link href={`/requests?${locQuery}`} className="btn btn-accent">
              Open Inbox
            </Link>
          )
        }
      />
      <LocationTabs base="/" active={location.id} />

      {/* The two things that stop a real customer getting through, above everything else. */}
      {(notice || unreachable) && !location.demo?.enabled && (
        <div className="panel" role={notice?.stopped ? "alert" : undefined} style={{ padding: "15px 18px", marginBottom: 14, borderColor: notice ? "var(--bad)" : "var(--warn)" }}>
          <div style={{ fontSize: 13.5, lineHeight: 1.5 }}>
            {notice ? notice.sentence : "Belline is live, but no channel is connected yet, so no customer can reach it."}{" "}
            {notice ? (
              notice.choosePlan && (
                <Link href="/checkout" style={{ color: "var(--accent)", textDecoration: "underline" }}>
                  Choose a plan
                </Link>
              )
            ) : (
              <Link href={`/channels?${locQuery}`} style={{ color: "var(--accent)", textDecoration: "underline" }}>
                Connect a channel
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

      {/* Setup, until it is done. The menu has no "Setup journey": this is where it lives. */}
      {checklist && path && (
        <div className="panel" style={{ padding: "18px 20px", marginBottom: 14 }} data-testid="setup-checklist">
          <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
            <strong style={{ fontSize: 15 }}>
              Setup: {checklist.done} of {checklist.total} done
            </strong>
            {checklist.next ? (
              <Link href={checklist.next.url} className="btn btn-accent" data-testid="journey-next" style={{ marginLeft: "auto" }}>
                Next: {checklist.next.title}
              </Link>
            ) : (
              <Link href="/setup/golive" className="btn btn-accent" data-testid="journey-next" style={{ marginLeft: "auto" }}>
                {path.canGoLive ? "Next: Go live" : "See what is left before going live"}
              </Link>
            )}
          </div>
          <p className="muted" style={{ fontSize: 12.5, margin: "6px 0 0", lineHeight: 1.5, maxWidth: "60ch" }}>
            Do them in any order, or come back later. Your dashboard works meanwhile; Belline answers real customers only once
            the checks pass and you go live.
          </p>
          <ol style={{ listStyle: "none", margin: "12px 0 0", padding: 0, display: "grid", gap: 6 }}>
            {checklist.items.map((s) => (
              <li key={s.id} style={{ fontSize: 13.5, display: "flex", gap: 8, alignItems: "baseline" }}>
                <span aria-hidden="true" style={{ width: 18, color: s.done ? "var(--ok)" : "var(--text-2)" }}>
                  {s.done ? "✓" : s.optional ? "–" : "○"}
                </span>
                <Link href={s.url} style={{ color: s.done ? "var(--text-2)" : "var(--accent)", textDecoration: s.done ? "none" : "underline" }}>
                  {s.title}
                </Link>
                {s.optional && (
                  <span className="muted" style={{ fontSize: 12 }}>
                    optional, you have another way in
                  </span>
                )}
                <span className="sr-only">{s.done ? " (done)" : s.optional ? " (optional)" : " (not done)"}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* What needs you. The only thing on this page that is ever urgent. */}
      <section className="panel" style={{ marginBottom: 14 }} data-testid="home-needs-you">
        <div className="panel-head" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          {needs.length === 0 ? "Nothing needs you" : needs.length === 1 ? "One thing needs you" : `${needs.length} things need you`}
          {waitingRequests > 0 && (
            <Link href={`/requests?${locQuery}`} className="pill" style={{ fontWeight: 500 }}>
              {waitingRequests === 1 ? "1 request waiting" : `${waitingRequests} requests waiting`}
            </Link>
          )}
          {needs.length > 5 && (
            <Link href={`/attention?${locQuery}`} style={{ marginLeft: "auto", fontWeight: 400, fontSize: 13 }}>
              See all {needs.length}
            </Link>
          )}
        </div>
        <div style={{ padding: needs.length ? "12px 16px 14px" : "14px 18px" }}>
          {needs.length === 0 ? (
            <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>
              You are up to date. Anything Belline could not finish on its own, such as a request to confirm or a message to call
              back, appears here.
            </p>
          ) : (
            <Inbox items={needs.slice(0, 5)} labels={KIND_LABEL} />
          )}
        </div>
      </section>

      {/* What it handled. */}
      <section className="panel" style={{ marginBottom: 14 }} data-testid="home-handled">
        <div className="panel-head" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          Handled by Belline
          <nav aria-label="Period" className="plan-switch" style={{ marginLeft: "auto" }}>
            {PERIODS.map((d) => (
              <Link key={d} href={`/?${locQuery}&days=${d}`} className={d === days ? "is-on" : ""} aria-current={d === days ? "page" : undefined}>
                <span>Last {d} days</span>
              </Link>
            ))}
          </nav>
        </div>
        <div style={{ padding: "16px 20px 18px" }}>
          <div style={{ display: "flex", gap: 30, flexWrap: "wrap" }}>
            <Tile n={handled.calls} label={handled.calls === 1 ? "call handled" : "calls handled"} />
            <Tile n={handled.chats} label={handled.chats === 1 ? "website chat handled" : "website chats handled"} />
            <Tile n={handled.requests} label={handled.requests === 1 ? "booking request taken" : "booking requests taken"} />
            <Tile n={handled.toPerson} label="put through to a person" />
          </div>
          <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.55, margin: "14px 0 0", maxWidth: "70ch" }}>
            Today: {did.answered > 0 ? summarise(location, did) : "nothing yet."}
            {handled.rangOff > 0 && ` Over the ${days} days, ${handled.rangOff} ${handled.rangOff === 1 ? "caller" : "callers"} rang off part-way.`}{" "}
            Tests, demos and your own conversations in Try it are not counted. WhatsApp threads are in{" "}
            <Link href={`/conversations?${locQuery}`}>Conversations</Link>.
          </p>
        </div>
      </section>

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

      <div className="split">
        <div className="panel">
          <div className="panel-head">Recent conversations</div>
          {recent.length === 0 ? (
            <p className="muted" style={{ padding: "26px 16px", fontSize: 13, margin: 0 }}>
              No conversations yet. Try it yourself under{" "}
              <Link href={`/channels?${locQuery}`} style={{ color: "var(--accent)" }}>
                Channels
              </Link>
              .
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
          {/* A booking count only where Belline books. A venue that takes requests
              would see a nought here every day. */}
          {books && (
            <div className="panel" style={{ marginBottom: 14 }}>
              <div className="panel-head">
                Bookings taken by Belline
                <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>
                  last {worth.days} days
                </span>
              </div>
              <div style={{ padding: "18px 18px 20px" }}>
                <div style={{ fontSize: 34, fontWeight: 300, letterSpacing: "-0.035em", lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>{worth.bookings}</div>
                {worth.estimate === null ? (
                  <p className="muted" style={{ fontSize: 12.5, margin: "12px 0 0", lineHeight: 1.55 }}>
                    Tell us what a {isRestaurant(location) ? "cover" : t.booking} is typically worth and this will show an estimate of
                    what they came to. We will not guess it for you.
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
          )}

          {/* The spreadsheets the old Reports page offered, one click each. */}
          {manager && (
            <div className="panel" style={{ marginBottom: 14 }} data-testid="home-exports">
              <div className="panel-head">Download</div>
              <div style={{ padding: "12px 18px 16px", display: "flex", gap: 8, flexWrap: "wrap" }}>
                <a className="btn" href={`/api/reports/export?${locQuery}&kind=calls`} download>
                  Conversations (CSV)
                </a>
                <a className="btn" href={`/api/reports/export?${locQuery}&kind=customers`} download>
                  Customers (CSV)
                </a>
                {books && (
                  <a className="btn" href={`/api/reports/export?${locQuery}&kind=bookings`} download>
                    Bookings (CSV)
                  </a>
                )}
              </div>
            </div>
          )}

          {staff && (
          <div className="panel" data-testid="health-panel">
            <div className="panel-head">Belline health</div>
            <div style={{ padding: "12px 18px 16px" }}>
              {health.map((h) => (
                <div key={h.label} style={{ display: "flex", gap: 9, alignItems: "baseline", padding: "6px 0" }}>
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

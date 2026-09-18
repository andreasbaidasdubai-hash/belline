import Link from "next/link";
import { requireUser } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import { seedIfEmpty } from "@/lib/seed";
import { engineStatus, statusSentence } from "@/lib/sales/sending/engine";
import { observe } from "@/lib/sales/sending/watch";
import { sendingStore } from "@/lib/sales/sending/store";
import { capacities } from "@/lib/sales/sending/batch";
import { warmupWeek } from "@/lib/sales/sending/warmup";
import { DEFAULT_STEPS } from "@/lib/sales/sending/sequence";
import { ConsoleHeader, EmptyState, KeyValues, Pill, Stat, ago } from "../ui";
import OutreachTabs from "./OutreachTabs";

export const dynamic = "force-dynamic";

/**
 * Today, for the outreach engine.
 *
 * The first thing on the page is whether anything can send at all, and with
 * nothing configured it says so in one sentence and lists what to do. That is
 * the honest state of this machine for as long as the domains have not been
 * bought, and a screen that dressed it up as "ready" would be the single most
 * damaging thing in this console.
 */
export default async function OutreachToday() {
  seedIfEmpty();
  const user = await requireUser();
  if (!isBellineStaff(user)) return <p className="muted">Belline staff only.</p>;

  const store = sendingStore();
  const now = new Date();
  const [status, stats, caps, batches, replies, sequences] = await Promise.all([
    engineStatus(),
    observe({ store, days: 30, now }),
    capacities(store, now),
    store.listBatches(5),
    store.listReplies({ handled: false, limit: 5 }),
    store.listSequences({ status: "active", limit: 500 }),
  ]);

  const roomToday = caps.filter((c) => c.unusable === null).reduce((sum, c) => sum + c.remaining, 0);
  const plannedToday = (await store.listItems({ status: ["queued", "planned"], limit: 1000 })).length;
  const openCountries = status.countries.filter((c) => c.enabled);

  return (
    <>
      <ConsoleHeader
        title="Outreach"
        subtitle={statusSentence(status)}
        actions={
          <Link href="/sales/outreach/batches" className="btn btn-accent">
            Approve a batch
          </Link>
        }
      />
      <OutreachTabs active="/sales/outreach" />

      {status.inert && (
        <div className="panel staff-section">
          <div className="panel-head">
            <h2>Nothing can be sent yet</h2>
          </div>
          <div className="staff-body">
            <p className="muted">
              This is not a warning to be cleared. Until every line below is done, the engine will refuse
              every send and say why — it will not half-work, and it will not queue anything up hoping the
              credentials arrive later.
            </p>
            {status.todo.length === 0 ? (
              <p className="muted">Add a sending domain to begin.</p>
            ) : (
              <ol className="staff-note">
                {status.todo.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ol>
            )}
          </div>
        </div>
      )}

      <div className="stats">
        <Stat label="Room left today" value={String(roomToday)} hint="across every warm mailbox" />
        <Stat label="Scheduled" value={String(plannedToday)} hint="approved and waiting for their minute" />
        <Stat label="Sequences running" value={String(sequences.length)} />
        <Stat
          label="Replies to read"
          value={String(replies.length)}
          tone={replies.length > 0 ? "warn" : undefined}
        />
      </div>

      <div className="staff-grid">
        <div className="staff-stack">
          <div className="panel staff-section">
            <div className="panel-head">
              <h2>Mailboxes today</h2>
            </div>
            {caps.length === 0 ? (
              <EmptyState title="No mailboxes yet">
                <p className="muted">
                  Add a sending domain and its mailboxes under Domains. Cold mail never leaves belline.ai.
                </p>
              </EmptyState>
            ) : (
              <div className="table-wrap">
                <table className="staff-table">
                  <thead>
                    <tr>
                      <th>Mailbox</th>
                      <th>Warm-up</th>
                      <th>Today</th>
                      <th>Health</th>
                    </tr>
                  </thead>
                  <tbody>
                    {caps.map((c) => (
                      <tr key={c.mailbox.id}>
                        <td>
                          {c.mailbox.address}
                          {c.unusable && <div className="sub">{c.unusable}</div>}
                        </td>
                        <td>
                          {c.mailbox.warmupStartedOn
                            ? (() => {
                                const week = warmupWeek(c.mailbox, now.toISOString().slice(0, 10));
                                return week === "warm" ? "Warm" : `Week ${week}`;
                              })()
                            : "Not started"}
                        </td>
                        <td>
                          {c.sentToday} / {c.capToday}
                        </td>
                        <td>
                          <Pill tone={c.health.verdict === "ok" ? "ok" : c.health.verdict === "watch" ? "warn" : "bad"}>
                            {c.health.verdict === "ok" ? "Fine" : c.health.verdict === "watch" ? "Watch" : "Stopped"}
                          </Pill>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="panel staff-section">
            <div className="panel-head">
              <h2>The sequence</h2>
            </div>
            <div className="staff-body">
              <p className="muted">
                Every step stops immediately on a reply, a click into the demo, an unsubscribe or a bounce.
                A lead that responds in any way is a lead the machine stops writing to.
              </p>
              <div className="table-wrap">
                <table className="staff-table">
                  <thead>
                    <tr>
                      <th>Step</th>
                      <th>Gap</th>
                      <th>What it is</th>
                    </tr>
                  </thead>
                  <tbody>
                    {DEFAULT_STEPS.map((step) => (
                      <tr key={step.step}>
                        <td>{step.label}</td>
                        <td>{step.step === 1 ? "—" : `+${step.spacingDays} days`}</td>
                        <td className="sub">{step.purpose}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        <div className="staff-stack">
          <div className="panel staff-section">
            <div className="panel-head">
              <h2>Last 30 days</h2>
            </div>
            <div className="staff-body">
              <KeyValues
                rows={[
                  ["Sent", String(stats.totals.sent)],
                  ["Bounced", String(stats.totals.bounces)],
                  ["Complaints", String(stats.totals.complaints)],
                  ["Replies", String(stats.totals.replies)],
                  ["Demo views", String(stats.totals.demoViews)],
                ]}
              />
            </div>
          </div>

          <div className="panel staff-section">
            <div className="panel-head">
              <h2>Countries open</h2>
            </div>
            <div className="staff-body">
              {openCountries.length === 0 ? (
                <p className="muted">No country is switched on, so nothing is eligible to be written to.</p>
              ) : (
                <KeyValues
                  rows={openCountries.map((c) => [
                    c.label,
                    `${c.effectiveDailyCap}/day · ${c.maxSequenceSteps} messages max · ${c.language.toUpperCase()}`,
                  ])}
                />
              )}
              <p className="staff-note">
                Turning a country on is a legal decision, and the engine will still refuse it if our own
                sender identity is not complete enough for that country&apos;s law.
              </p>
            </div>
          </div>

          <div className="panel staff-section">
            <div className="panel-head">
              <h2>Recent batches</h2>
            </div>
            {batches.length === 0 ? (
              <EmptyState title="No batches yet">
                <p className="muted">A batch is the only thing that can become a send.</p>
              </EmptyState>
            ) : (
              <div className="table-wrap">
                <table className="staff-table">
                  <tbody>
                    {batches.map((b) => (
                      <tr key={b.id}>
                        <td>
                          <Link href={`/sales/outreach/batches/${b.id}`}>#{b.id}</Link>
                          <div className="sub">{b.planned.leads ?? 0} leads · {ago(b.createdAt)}</div>
                        </td>
                        <td>
                          <Pill tone={b.status === "approved" ? "ok" : b.status === "cancelled" ? "bad" : "accent"}>
                            {b.status === "draft" ? "Waiting for approval" : b.status}
                          </Pill>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

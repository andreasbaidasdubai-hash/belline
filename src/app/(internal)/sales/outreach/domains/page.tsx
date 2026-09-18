import { requireUser } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import { seedIfEmpty } from "@/lib/seed";
import { engineStatus } from "@/lib/sales/sending/engine";
import { observe } from "@/lib/sales/sending/watch";
import { sendingStore } from "@/lib/sales/sending/store";
import { WARMUP_WEEKS, warmupWeek } from "@/lib/sales/sending/warmup";
import { ConsoleHeader, EmptyState, KeyValues, Pill, Stat } from "../../ui";
import Action from "../../Actions";
import OutreachTabs from "../OutreachTabs";

export const dynamic = "force-dynamic";

/**
 * Sending domains and the mailboxes on them.
 *
 * Each domain is a separate reputation, which is the entire reason for having
 * several. belline.ai is not among them and cannot be added: it carries
 * customers' verification codes and booking confirmations, and one complaint
 * rate must never be allowed to ruin the other.
 */
export default async function Domains() {
  seedIfEmpty();
  const user = await requireUser();
  if (!isBellineStaff(user)) return <p className="muted">Belline staff only.</p>;

  const store = sendingStore();
  const [status, stats, mailboxes] = await Promise.all([engineStatus(), observe({ store }), store.listMailboxes()]);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <ConsoleHeader
        title="Domains"
        subtitle="Separate lookalike domains only. belline.ai carries customers' transactional email and never sends cold mail."
        actions={
          <Action
            endpoint="/api/sales/outreach"
            body={{ action: "domain.add" }}
            label="Add a domain"
            tone="primary"
            fields={[
              { name: "domain", label: "Domain", type: "text", placeholder: "try-belline.com", required: true },
              { name: "dailyCap", label: "Ceiling for the whole domain, per day", type: "number", defaultValue: "120", min: 1, max: 400 },
            ]}
            submitLabel="Add"
          />
        }
      />
      <OutreachTabs active="/sales/outreach/domains" />

      <div className="stats">
        <Stat label="Sent, 30 days" value={String(stats.totals.sent)} />
        <Stat label="Bounces" value={String(stats.totals.bounces)} tone={stats.totals.bounces > 0 ? "warn" : undefined} />
        <Stat label="Complaints" value={String(stats.totals.complaints)} tone={stats.totals.complaints > 0 ? "warn" : undefined} />
        <Stat label="Replies" value={String(stats.totals.replies)} />
      </div>

      {status.domains.length === 0 ? (
        <EmptyState title="No sending domain yet">
          <p className="muted">
            Register a lookalike domain, verify it in Amazon SES with SPF, DKIM and DMARC, then add it here
            with its own credentials. Nothing can send until one exists.
          </p>
        </EmptyState>
      ) : (
        status.domains.map((entry) => {
          const own = mailboxes.filter((m) => m.domainId === entry.domain.id);
          const health = stats.perDomain.find((d) => d.domain === entry.domain.domain);
          return (
            <div className="panel staff-section" key={entry.domain.id}>
              <div className="panel-head">
                <h2>{entry.domain.domain}</h2>
                <Pill tone={entry.ready ? "ok" : "warn"}>{entry.ready ? "Can send" : "Cannot send"}</Pill>
              </div>
              <div className="staff-body">
                {!entry.ready && entry.reason && <p className="staff-note">{entry.reason}</p>}
                <KeyValues
                  rows={[
                    ["Provider", entry.domain.provider.toUpperCase()],
                    ["Status", entry.domain.status],
                    ["Ceiling", `${entry.domain.dailyCap} a day across the domain`],
                    ["Sent, 30 days", String(health?.sent ?? 0)],
                    [
                      "Bounces / complaints",
                      `${health?.bounces ?? 0} / ${health?.complaints ?? 0}`,
                    ],
                    ...(entry.missing.length > 0
                      ? ([["Missing", entry.missing.join(", ")]] as [string, React.ReactNode][])
                      : []),
                  ]}
                />

                <div className="table-wrap">
                  <table className="staff-table">
                    <thead>
                      <tr>
                        <th>Mailbox</th>
                        <th>Warm-up</th>
                        <th>Cap</th>
                        <th>Health</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {own.length === 0 && (
                        <tr>
                          <td colSpan={5} className="muted">
                            No mailboxes yet. About 30 a day each once warm, so six to ten across three or
                            four domains reaches 200–300.
                          </td>
                        </tr>
                      )}
                      {own.map((mailbox) => {
                        const box = stats.perMailbox.find((m) => m.address === mailbox.address);
                        const week = warmupWeek(mailbox, today);
                        return (
                          <tr key={mailbox.id}>
                            <td>
                              {mailbox.address}
                              <div className="sub">{mailbox.displayName}</div>
                            </td>
                            <td className="sub">
                              {mailbox.warmupStartedOn
                                ? week === "warm"
                                  ? "Warm"
                                  : `Week ${week} of ${WARMUP_WEEKS.length}`
                                : "Not started"}
                            </td>
                            <td className="sub">{mailbox.dailyCap}/day</td>
                            <td>
                              <Pill tone={box?.verdict === "ok" ? "ok" : box?.verdict === "watch" ? "warn" : "bad"}>
                                {mailbox.status === "paused" ? "Paused" : (box?.verdict ?? "ok")}
                              </Pill>
                              {mailbox.pausedReason && <div className="sub">{mailbox.pausedReason}</div>}
                            </td>
                            <td>
                              <div className="staff-row-actions">
                                {!mailbox.warmupStartedOn && (
                                  <Action
                                    endpoint="/api/sales/outreach"
                                    body={{ action: "mailbox.warmup", mailboxId: mailbox.id }}
                                    label="Start warm-up"
                                    small
                                  />
                                )}
                                {mailbox.status === "paused" ? (
                                  <Action
                                    endpoint="/api/sales/outreach"
                                    body={{ action: "mailbox.resume", mailboxId: mailbox.id }}
                                    label="Resume"
                                    small
                                    confirm="Resume this mailbox? Check what it was sending before its health dropped."
                                  />
                                ) : (
                                  <Action
                                    endpoint="/api/sales/outreach"
                                    body={{ action: "mailbox.pause", mailboxId: mailbox.id }}
                                    label="Pause"
                                    small
                                    tone="danger"
                                    reason="Why is this mailbox being paused?"
                                  />
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="staff-row-actions">
                  <Action
                    endpoint="/api/sales/outreach"
                    body={{ action: "mailbox.add", domainId: entry.domain.id }}
                    label="Add a mailbox"
                    small
                    fields={[
                      { name: "address", label: "Address", type: "email", placeholder: `andreas@${entry.domain.domain}`, required: true },
                      { name: "displayName", label: "Name the recipient sees", type: "text", required: true },
                      { name: "replyTo", label: "Reply-to (optional)", type: "email" },
                      { name: "dailyCap", label: "Ceiling once warm", type: "number", defaultValue: "30", min: 1, max: 50 },
                    ]}
                    submitLabel="Add mailbox"
                  />
                  {entry.domain.status === "paused" ? (
                    <Action
                      endpoint="/api/sales/outreach"
                      body={{ action: "domain.resume", domainId: entry.domain.id }}
                      label="Resume domain"
                      small
                      confirm="Resume this domain?"
                    />
                  ) : (
                    <Action
                      endpoint="/api/sales/outreach"
                      body={{ action: "domain.pause", domainId: entry.domain.id }}
                      label="Pause domain"
                      small
                      tone="danger"
                      reason="Why is this domain being paused?"
                    />
                  )}
                </div>
              </div>
            </div>
          );
        })
      )}

      <div className="panel staff-section">
        <div className="panel-head">
          <h2>The warm-up timetable</h2>
        </div>
        <div className="staff-body">
          <p className="muted">
            A new address sends five a day in its first week and roughly doubles each week to its own
            ceiling. A brand-new mailbox that sends thirty on its first morning is a spam trap with extra
            steps, and there is no way to hurry this.
          </p>
          <KeyValues rows={WARMUP_WEEKS.map((cap, i) => [`Week ${i + 1}`, `${cap} a day`])} />
        </div>
      </div>
    </>
  );
}

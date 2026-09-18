import Link from "next/link";
import { requireUser } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import { seedIfEmpty } from "@/lib/seed";
import { sendingStore } from "@/lib/sales/sending/store";
import { DEFAULT_STEPS, STOP_WORDS } from "@/lib/sales/sending/sequence";
import { leadHref } from "@/lib/staff/leads";
import { ConsoleHeader, EmptyState, Pill, Stat, ago } from "../../ui";
import OutreachTabs from "../OutreachTabs";

export const dynamic = "force-dynamic";

/**
 * Where every lead is in its sequence.
 *
 * One column per stage, as the founder asked — "Demo sent", then the three
 * follow-ups — plus the leads that have stopped and why. A lead is visible in
 * exactly one place, which is the point: the question this screen answers is
 * "what has this business heard from us so far", and a lead appearing twice
 * would make that unanswerable.
 */
export default async function Stages() {
  seedIfEmpty();
  const user = await requireUser();
  if (!isBellineStaff(user)) return <p className="muted">Belline staff only.</p>;

  const store = sendingStore();
  const [sequences, items] = await Promise.all([
    store.listSequences({ limit: 1000 }),
    store.listItems({ limit: 2000 }),
  ]);

  const sentByLead = new Map<number, { step: number; at: string | null; subject: string }[]>();
  for (const item of items) {
    if (item.status !== "sent") continue;
    const list = sentByLead.get(item.leadId) ?? [];
    list.push({ step: item.step, at: item.sentAt, subject: item.subject });
    sentByLead.set(item.leadId, list);
  }

  const active = sequences.filter((s) => s.status === "active" && s.step > 0);
  const stopped = sequences.filter((s) => s.status === "stopped");
  const completed = sequences.filter((s) => s.status === "completed");

  return (
    <>
      <ConsoleHeader
        title="Stages"
        subtitle="Where each business is in the sequence, and what stopped the ones that stopped."
      />
      <OutreachTabs active="/sales/outreach/stages" />

      <div className="stats">
        {DEFAULT_STEPS.map((definition) => (
          <Stat
            key={definition.step}
            label={definition.label}
            value={String(active.filter((s) => s.step === definition.step).length)}
            hint={definition.step === 1 ? "first email out, nothing back yet" : undefined}
          />
        ))}
      </div>

      {DEFAULT_STEPS.map((definition) => {
        const rows = active.filter((s) => s.step === definition.step);
        return (
          <div className="panel staff-section" key={definition.step}>
            <div className="panel-head">
              <h2>{definition.label}</h2>
            </div>
            {rows.length === 0 ? (
              <EmptyState title="Nobody at this stage" />
            ) : (
              <div className="table-wrap">
                <table className="staff-table">
                  <thead>
                    <tr>
                      <th>Lead</th>
                      <th>Last message</th>
                      <th>Next due</th>
                      <th>Country</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((s) => (
                      <tr key={s.leadId}>
                        <td>
                          <Link href={leadHref(`db:${s.leadId}`)}>Lead {s.leadId}</Link>
                          <div className="sub">
                            {(sentByLead.get(s.leadId) ?? []).map((m) => m.subject).slice(-1)[0] ?? "—"}
                          </div>
                        </td>
                        <td className="sub">{s.lastSentAt ? ago(s.lastSentAt) : "—"}</td>
                        <td className="sub">
                          {s.nextDueAt
                            ? new Date(s.nextDueAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })
                            : "nothing scheduled"}
                        </td>
                        <td className="sub">{s.countryCode ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}

      <div className="panel staff-section">
        <div className="panel-head">
          <h2>Stopped</h2>
        </div>
        {stopped.length === 0 && completed.length === 0 ? (
          <EmptyState title="Nothing has stopped yet" />
        ) : (
          <div className="table-wrap">
            <table className="staff-table">
              <thead>
                <tr>
                  <th>Lead</th>
                  <th>Why</th>
                  <th>When</th>
                  <th>Messages sent</th>
                </tr>
              </thead>
              <tbody>
                {[...stopped, ...completed].map((s) => (
                  <tr key={s.leadId}>
                    <td>
                      <Link href={leadHref(`db:${s.leadId}`)}>Lead {s.leadId}</Link>
                    </td>
                    <td>
                      <Pill tone={s.stopReason === "replied" || s.stopReason === "demo_clicked" ? "ok" : "warn"}>
                        {s.stopReason ? STOP_WORDS[s.stopReason] : "stopped"}
                      </Pill>
                    </td>
                    <td className="sub">{s.stoppedAt ? ago(s.stoppedAt) : "—"}</td>
                    <td className="sub">{(sentByLead.get(s.leadId) ?? []).length}</td>
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

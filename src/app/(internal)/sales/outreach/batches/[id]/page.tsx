import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import { seedIfEmpty } from "@/lib/seed";
import { sendingStore } from "@/lib/sales/sending/store";
import { stepLabel } from "@/lib/sales/sending/sequence";
import { ConsoleHeader, KeyValues, Pill, Stat, aed, ago } from "../../../ui";
import Action from "../../../Actions";
import OutreachTabs from "../../OutreachTabs";

export const dynamic = "force-dynamic";

/**
 * One batch, and the button.
 *
 * Everything an approver needs in order to be responsible for what leaves: the
 * recipients, the mailbox and minute each is scheduled for, the country rule
 * that was applied, the sender identity it will carry, and what it costs in
 * demo minutes. Approving is a named act, recorded in the audit log, and it is
 * the only thing in this codebase that makes a message sendable.
 */
export default async function BatchPage({ params }: { params: Promise<{ id: string }> }) {
  seedIfEmpty();
  const user = await requireUser();
  if (!isBellineStaff(user)) return <p className="muted">Belline staff only.</p>;

  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();

  const store = sendingStore();
  const batch = await store.getBatch(id);
  if (!batch) notFound();
  const items = await store.listItems({ batchId: id, limit: 500 });

  const identity = items[0]?.identitySnapshot ?? null;

  return (
    <>
      <ConsoleHeader
        title={`Batch #${batch.id}`}
        subtitle={
          batch.status === "approved"
            ? `Approved by ${batch.approvedBy} ${ago(batch.approvedAt)}. Each message leaves at its own minute.`
            : batch.status === "cancelled"
              ? `Cancelled by ${batch.cancelledBy} ${ago(batch.cancelledAt)}.`
              : "Nothing in this batch can be sent until somebody approves it."
        }
        actions={<Link href="/sales/outreach/batches" className="btn">All batches</Link>}
      />
      <OutreachTabs active="/sales/outreach/batches" />

      <div className="stats">
        <Stat label="Messages" value={String(items.filter((i) => i.status !== "cancelled").length)} />
        <Stat label="Demo minutes" value={String(batch.planned.demoMinutes ?? 0)} hint={`about ${aed(batch.planned.demoCostFils ?? 0)}`} />
        <Stat label="Mailboxes" value={String(batch.planned.perMailbox?.length ?? 0)} />
        <Stat label="Sent" value={String(items.filter((i) => i.status === "sent").length)} />
      </div>

      {batch.status === "draft" && (
        <div className="panel staff-section">
          <div className="panel-head">
            <h2>Approve</h2>
          </div>
          <div className="staff-body">
            <p className="muted">
              Approving queues every message below. Each one is screened again in the second before it is
              handed to the provider, so an unsubscribe that arrives between now and then still stops it.
            </p>
            <div className="staff-row-actions">
              <Action
                endpoint="/api/sales/outreach"
                body={{ action: "approve", batchId: batch.id }}
                label={`Approve and queue ${items.length} messages`}
                tone="primary"
                confirm={`${items.length} businesses will receive an email today. This cannot be taken back once a message has left.`}
                submitLabel="Approve"
              />
              <Action
                endpoint="/api/sales/outreach"
                body={{ action: "cancel", batchId: batch.id }}
                label="Cancel"
                tone="danger"
                small
                confirm="Cancel this batch and everything in it?"
                submitLabel="Cancel batch"
              />
            </div>
          </div>
        </div>
      )}

      {identity && (
        <div className="panel staff-section">
          <div className="panel-head">
            <h2>Sender identity on every message</h2>
          </div>
          <div className="staff-body">
            <KeyValues
              rows={[
                ["Entity", identity.entity || <span className="muted">not filled in</span>],
                ["Address", identity.address || <span className="muted">not filled in</span>],
                ["Represented by", identity.managingDirector || <span className="muted">not filled in</span>],
                ["Register", identity.registration || <span className="muted">not filled in</span>],
                ["Contact", identity.email || <span className="muted">not filled in</span>],
              ]}
            />
            <p className="staff-note">
              Recorded against each message as sent, so a complaint can be answered with what was actually
              in the footer rather than what the code says today.
            </p>
          </div>
        </div>
      )}

      <div className="panel staff-section">
        <div className="panel-head">
          <h2>What goes out</h2>
        </div>
        <div className="table-wrap">
          <table className="staff-table">
            <thead>
              <tr>
                <th>To</th>
                <th>Step</th>
                <th>Mailbox</th>
                <th>At</th>
                <th>Country rule</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    {item.toAddress}
                    <div className="sub">{item.subject}</div>
                  </td>
                  <td>{stepLabel(item.step)}</td>
                  <td className="sub">
                    {batch.planned.perMailbox?.find((m) => m.count)?.mailbox && item.mailboxId
                      ? `#${item.mailboxId}`
                      : "—"}
                  </td>
                  <td className="sub">
                    {item.scheduledFor
                      ? new Date(item.scheduledFor).toLocaleString("en-GB", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short" })
                      : "—"}
                  </td>
                  <td className="sub">{item.countryRule ?? "—"}</td>
                  <td>
                    <Pill tone={item.status === "sent" ? "ok" : item.status === "failed" || item.status === "blocked" ? "bad" : "accent"}>
                      {item.status}
                    </Pill>
                    {item.blockedReason && <div className="sub">{item.blockedReason}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

import Link from "next/link";
import { requireUser } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import { seedIfEmpty } from "@/lib/seed";
import { sendingStore } from "@/lib/sales/sending/store";
import { leadHref } from "@/lib/staff/leads";
import { ConsoleHeader, EmptyState, Pill, ago } from "../../ui";
import Action from "../../Actions";
import OutreachTabs from "../OutreachTabs";

export const dynamic = "force-dynamic";

/**
 * Replies, against the lead they belong to.
 *
 * A reply halts that lead's sequence everywhere the moment it is recorded —
 * the state, the items already on today's clock, and any other step planned
 * for it. Recording one is therefore not an administrative act; it is the
 * stop. Which is why this page also lets staff paste a reply in by hand: until
 * an inbound connector is wired, the shared mailbox is where replies land, and
 * a reply nobody records is a follow-up that goes out to somebody who already
 * answered.
 */
export default async function Replies() {
  seedIfEmpty();
  const user = await requireUser();
  if (!isBellineStaff(user)) return <p className="muted">Belline staff only.</p>;

  const store = sendingStore();
  const replies = await store.listReplies({ limit: 100 });
  const open = replies.filter((r) => r.handledAt === null);

  return (
    <>
      <ConsoleHeader
        title="Replies"
        subtitle="Anything back from a prospect stops that lead's sequence, whatever it says."
        actions={
          <Action
            endpoint="/api/sales/outreach"
            body={{ action: "reply.record" }}
            label="Record a reply"
            tone="primary"
            fields={[
              { name: "leadId", label: "Lead id (the number after db: on the lead page)", type: "number" },
              { name: "from", label: "From", type: "email", required: true },
              { name: "subject", label: "Subject", type: "text" },
              { name: "body", label: "What they wrote", type: "textarea", required: true },
            ]}
            submitLabel="Record and stop the sequence"
            done="Recorded. That lead's sequence has stopped."
          />
        }
      />
      <OutreachTabs active="/sales/outreach/replies" />

      <div className="panel staff-section">
        <div className="panel-head">
          <h2>{open.length > 0 ? `${open.length} to read` : "Nothing waiting"}</h2>
        </div>
        {replies.length === 0 ? (
          <EmptyState title="No replies yet">
            <p className="muted">
              Replies to the sending mailboxes land here once an inbound connector is wired. Until then,
              paste them in — recording a reply is what stops the follow-ups.
            </p>
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="staff-table">
              <thead>
                <tr>
                  <th>From</th>
                  <th>What they said</th>
                  <th>When</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {replies.map((reply) => (
                  <tr key={reply.id}>
                    <td>
                      {reply.fromAddress}
                      {reply.leadId !== null && (
                        <div className="sub">
                          <Link href={leadHref(`db:${reply.leadId}`)}>Lead {reply.leadId}</Link>
                        </div>
                      )}
                    </td>
                    <td>
                      {reply.subject && <div>{reply.subject}</div>}
                      <div className="sub">{reply.body.slice(0, 220)}</div>
                      {reply.isOptOut && (
                        <Pill tone="bad">Asked to stop — company suppressed for good</Pill>
                      )}
                    </td>
                    <td className="sub">{ago(reply.receivedAt)}</td>
                    <td>
                      {reply.handledAt ? (
                        <Pill tone="ok">Read</Pill>
                      ) : (
                        <Action
                          endpoint="/api/sales/outreach"
                          body={{ action: "reply.handled", replyId: reply.id }}
                          label="Mark read"
                          small
                          tone="plain"
                        />
                      )}
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

import Link from "next/link";
import { requireUser } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import { seedIfEmpty } from "@/lib/seed";
import { sendingStore, type InboundKind, type InboundReply } from "@/lib/sales/sending/store";
import { leadHref } from "@/lib/staff/leads";
import { ConsoleHeader, EmptyState, FilterChips, Pill, ago, day } from "../../ui";
import Action from "../../Actions";
import OutreachTabs from "../OutreachTabs";

export const dynamic = "force-dynamic";

/**
 * Everything that came back, against the lead it came from.
 *
 * The page is an inbox, but the important column is not what they wrote — it
 * is **what it did**. A member of staff reading this needs to know, at a
 * glance, whether a sequence stopped, whether one is standing still until
 * somebody is back from holiday, and whether anything is waiting on their
 * judgement. Those three are different rows here because they are different
 * things in the engine:
 *
 *  - **Stopped** is final. A person answered and the machine is out of it.
 *  - **Paused** is temporary and reversible and resumes by itself. An
 *    out-of-office must never read as a stop, on this screen least of all —
 *    somebody seeing "stopped" against a lead who is merely in Greece is how a
 *    working pipeline gets quietly written off.
 *  - **Needs a look** is the honest answer to a phrase that might mean stop.
 *    We do not guess; a person decides, and until they do nothing is
 *    suppressed and nothing is sent.
 *
 * Staff can still paste a reply in by hand. Inbound mail arrives by itself
 * now, but a reply that reached somebody's personal inbox, or a phone call,
 * still has to be recordable — and recording one is what stops the follow-ups.
 */

const KINDS: { key: string; label: string; match: InboundKind[] }[] = [
  { key: "", label: "Everything", match: [] },
  { key: "reply", label: "Replies", match: ["reply"] },
  { key: "auto", label: "Out of office", match: ["auto_reply"] },
  { key: "bounce", label: "Bounces", match: ["bounce", "complaint"] },
  { key: "review", label: "Needs a look", match: [] },
];

export default async function Replies({
  searchParams,
}: {
  searchParams?: Promise<{ kind?: string }>;
}) {
  seedIfEmpty();
  const user = await requireUser();
  if (!isBellineStaff(user)) return <p className="muted">Belline staff only.</p>;

  const params = (await searchParams) ?? {};
  const active = KINDS.find((k) => k.key === (params.kind ?? "")) ?? KINDS[0];

  const store = sendingStore();
  const all = await store.listReplies({ limit: 200 });
  const rows =
    active.key === "review"
      ? all.filter((r) => r.needsReview)
      : active.match.length === 0
        ? all
        : all.filter((r) => active.match.includes(r.kind));

  const open = all.filter((r) => r.handledAt === null && r.kind === "reply").length;
  const review = all.filter((r) => r.needsReview).length;
  const paused = all.filter((r) => r.kind === "auto_reply" && stillPaused(r)).length;

  return (
    <>
      <ConsoleHeader
        title="Replies"
        subtitle={
          <>
            Anything a person writes back stops that lead&rsquo;s sequence, whatever it says. An
            out-of-office does not: it pauses the sequence and it resumes by itself.
          </>
        }
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

      <FilterChips
        label="Show"
        items={KINDS.map((k) => ({
          label: k.label,
          href: k.key ? `/sales/outreach/replies?kind=${k.key}` : "/sales/outreach/replies",
          on: k.key === active.key,
          count:
            k.key === "review"
              ? review
              : k.key === "reply"
                ? open
                : k.key === "auto"
                  ? paused
                  : undefined,
        }))}
      />

      {review > 0 && (
        <div className="panel staff-section">
          <p className="muted" style={{ margin: 0 }}>
            {review === 1 ? "One message needs" : `${review} messages need`} a person to decide. Each of
            them might be somebody asking to be left alone — nothing has been suppressed and nothing
            will be sent to them until you say which it is.
          </p>
        </div>
      )}

      <div className="panel staff-section">
        <div className="panel-head">
          <h2>{rows.length > 0 ? `${rows.length} ${active.label.toLowerCase()}` : "Nothing here"}</h2>
        </div>
        {rows.length === 0 ? (
          <EmptyState title="Nothing yet">
            <p className="muted">
              Replies to the sending mailboxes arrive here by themselves once the SES receipt rule and
              its SNS topic are wired to <code>/api/sales/inbound</code>. Until then, paste them in —
              recording a reply is what stops the follow-ups.
            </p>
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="staff-table">
              <thead>
                <tr>
                  <th>From</th>
                  <th>What it said</th>
                  <th>What it did</th>
                  <th>When</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((reply) => (
                  <tr key={reply.id}>
                    <td>
                      {reply.fromAddress}
                      <div className="sub">
                        {reply.leadId !== null ? (
                          <Link href={leadHref(`db:${reply.leadId}`)}>Lead {reply.leadId}</Link>
                        ) : (
                          "matched to no lead"
                        )}
                        {reply.matchedBy !== "none" && ` · by ${matchWords(reply.matchedBy)}`}
                      </div>
                    </td>
                    <td>
                      {reply.subject && <div>{reply.subject}</div>}
                      <div className="sub">{reply.body.slice(0, 220)}</div>
                    </td>
                    <td>{outcome(reply)}</td>
                    <td className="sub">{ago(reply.receivedAt)}</td>
                    <td>
                      {reply.needsReview ? (
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          <Action
                            endpoint="/api/sales/outreach"
                            body={{ action: "reply.optout", replyId: reply.id, optOut: true }}
                            label="They asked to stop"
                            small
                            tone="plain"
                          />
                          <Action
                            endpoint="/api/sales/outreach"
                            body={{ action: "reply.optout", replyId: reply.id, optOut: false }}
                            label="They did not"
                            small
                            tone="plain"
                          />
                        </div>
                      ) : reply.handledAt ? (
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

function stillPaused(reply: InboundReply): boolean {
  return reply.pausedUntil !== null && reply.pausedUntil > new Date().toISOString();
}

/**
 * What this message did to the sequence, in one cell.
 *
 * The wording is deliberate on the paused case: it names the date and says the
 * sequence comes back by itself, so nobody has to remember to restart
 * anything and nobody reads it as a stop.
 */
function outcome(reply: InboundReply) {
  if (reply.needsReview && reply.kind !== "auto_reply" && reply.leadId === null) {
    return <Pill tone="warn">Matched no lead — nothing stopped</Pill>;
  }
  if (reply.kind === "auto_reply") {
    return (
      <>
        <Pill tone="accent">Out of office — paused, not stopped</Pill>
        {reply.pausedUntil && (
          <div className="sub">
            {stillPaused(reply)
              ? `Resumes by itself on ${day(reply.pausedUntil)}`
              : `Resumed on ${day(reply.pausedUntil)}`}
          </div>
        )}
        {reply.needsReview && <div className="sub">It may also be an opt-out — worth reading</div>}
      </>
    );
  }
  if (reply.kind === "bounce") {
    return <Pill tone="warn">Bounced</Pill>;
  }
  if (reply.kind === "complaint") {
    return <Pill tone="bad">Marked as spam — company suppressed for good</Pill>;
  }
  if (reply.isOptOut) {
    return <Pill tone="bad">Asked to stop — company suppressed for good</Pill>;
  }
  if (reply.needsReview) {
    return (
      <>
        <Pill tone="warn">Sequence stopped — may be an opt-out</Pill>
        <div className="sub">Nothing suppressed until somebody says so</div>
      </>
    );
  }
  return <Pill tone="ok">Sequence stopped</Pill>;
}

function matchWords(matchedBy: InboundReply["matchedBy"]): string {
  return matchedBy === "thread"
    ? "the thread"
    : matchedBy === "plus_address"
      ? "the reply address"
      : "their email address";
}

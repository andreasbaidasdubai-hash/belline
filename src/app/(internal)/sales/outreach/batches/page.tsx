import Link from "next/link";
import { requireUser } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import { seedIfEmpty } from "@/lib/seed";
import { engineStatus } from "@/lib/sales/sending/engine";
import { sendingStore } from "@/lib/sales/sending/store";
import { buildBatch } from "@/lib/sales/sending/batch";
import { pipelineSource } from "@/lib/sales/sending/candidates";
import { ConsoleHeader, EmptyState, Pill, Stat, aed, ago } from "../../ui";
import Action from "../../Actions";
import OutreachTabs from "../OutreachTabs";

export const dynamic = "force-dynamic";

/**
 * Approve a batch.
 *
 * Staff see every lead that has had no first email, with the demo already
 * prepared for it, what the batch costs in demo minutes and how it spreads
 * across mailboxes and countries. Nothing here sends: building a batch writes
 * rows in `draft`, and a second, separate action by a named person is what
 * makes them sendable.
 */
export default async function Batches() {
  seedIfEmpty();
  const user = await requireUser();
  if (!isBellineStaff(user)) return <p className="muted">Belline staff only.</p>;

  const store = sendingStore();
  const status = await engineStatus();
  const batches = await store.listBatches(25);

  // A preview of what a batch would contain right now. Read-only — it writes
  // nothing, so opening this page cannot create anything.
  const origin = (process.env.PUBLIC_ORIGIN ?? "https://app.belline.ai").replace(/\/+$/, "");
  const preview = await buildBatch({
    source: pipelineSource({ origin, store }),
    limit: 50,
    origin,
    store,
  }).catch(() => null);

  return (
    <>
      <ConsoleHeader
        title="Approve a batch"
        subtitle="Nothing is sent without somebody pressing approve. Building a batch is not approving it."
      />
      <OutreachTabs active="/sales/outreach/batches" />

      {status.inert && (
        <p className="staff-note">
          The engine is inert — no sending credentials are configured — so a batch built now would sit
          waiting. You can still build and approve one; nothing will leave until the credentials exist.
        </p>
      )}

      <div className="panel staff-section">
        <div className="panel-head">
          <h2>Waiting for a first email</h2>
        </div>
        {!preview || (preview.sendable.length === 0 && preview.blocked.length === 0) ? (
          <EmptyState title="Nothing is waiting">
            <p className="muted">
              A lead is eligible once it has been researched, scored, drafted, approved as copy, and had a
              personalised video demo prepared for it. Without the demo there is nothing for the email to
              link to, so it is not a candidate.
            </p>
          </EmptyState>
        ) : (
          <div className="staff-body">
            <div className="stats">
              <Stat label="Ready" value={String(preview.sendable.length)} />
              <Stat label="Blocked" value={String(preview.blocked.length)} tone={preview.blocked.length ? "warn" : undefined} />
              <Stat label="Demo minutes" value={String(preview.plan.demoMinutes)} hint={`about ${aed(preview.plan.demoCostFils)}`} />
              <Stat label="Mailboxes used" value={String(preview.plan.perMailbox.length)} />
            </div>

            {preview.plan.perMailbox.length > 0 && (
              <div className="table-wrap">
                <table className="staff-table">
                  <thead>
                    <tr>
                      <th>Mailbox</th>
                      <th>Messages</th>
                      <th>Spread</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.plan.perMailbox.map((m) => (
                      <tr key={m.mailbox}>
                        <td>{m.mailbox}</td>
                        <td>{m.count}</td>
                        <td className="sub">
                          {m.firstAt && m.lastAt
                            ? `${new Date(m.firstAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} – ${new Date(m.lastAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {preview.plan.perCountry.length > 0 && (
              <div className="table-wrap">
                <table className="staff-table">
                  <thead>
                    <tr>
                      <th>Country</th>
                      <th>Messages</th>
                      <th>Rule applied</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.plan.perCountry.map((c) => (
                      <tr key={c.code}>
                        <td>{c.label}</td>
                        <td>{c.count}</td>
                        <td className="sub">{c.rule}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {preview.blocked.length > 0 && (
              <div className="table-wrap">
                <table className="staff-table">
                  <thead>
                    <tr>
                      <th>Not going out</th>
                      <th>Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.blocked.slice(0, 40).map((item, i) => (
                      <tr key={`${item.candidate.leadId}-${i}`}>
                        <td>{item.candidate.companyName}</td>
                        <td className="sub">{item.blocks[0]?.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="staff-row-actions">
              <Action
                endpoint="/api/sales/outreach"
                body={{ action: "build" }}
                label="Build this batch"
                tone="primary"
                fields={[
                  { name: "limit", label: "How many leads", type: "number", defaultValue: String(Math.min(preview.sendable.length, 50)), min: 1, max: 300, required: true },
                  { name: "notes", label: "Note (optional)", type: "textarea" },
                ]}
                submitLabel="Build"
                done="Built. Open it to approve."
              />
            </div>
          </div>
        )}
      </div>

      <div className="panel staff-section">
        <div className="panel-head">
          <h2>Batches</h2>
        </div>
        {batches.length === 0 ? (
          <EmptyState title="No batches yet" />
        ) : (
          <div className="table-wrap">
            <table className="staff-table">
              <thead>
                <tr>
                  <th>Batch</th>
                  <th>Leads</th>
                  <th>Status</th>
                  <th>Approved by</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.id}>
                    <td>
                      <Link href={`/sales/outreach/batches/${b.id}`}>#{b.id}</Link>
                      <div className="sub">{ago(b.createdAt)}</div>
                    </td>
                    <td>{b.planned.leads ?? 0}</td>
                    <td>
                      <Pill tone={b.status === "approved" ? "ok" : b.status === "cancelled" ? "bad" : "accent"}>
                        {b.status === "draft" ? "Waiting for approval" : b.status}
                      </Pill>
                    </td>
                    <td className="sub">{b.approvedBy ?? "—"}</td>
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

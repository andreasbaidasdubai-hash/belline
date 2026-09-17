import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import { seedIfEmpty } from "@/lib/seed";
import { getLead as getJsonLead } from "@/lib/store";
import { MARKETS } from "@/lib/markets";
import { getLead as getDbLead, getResearch, getTimeline } from "@/lib/sales/kpi/leads";
import { SOURCE_LABEL, crmFor, eventLabel, fromDb, fromJson, leadHref, mergeTimeline, parseLeadId, staffUsers, type UnifiedLead } from "@/lib/staff/leads";
import { STAGES, STAGE_LABEL } from "@/lib/staff/stages";
import { draftForLead } from "@/lib/staff/drafts";
import Action from "../../Actions";
import { ConsoleHeader, EmptyState, KeyValues, Pill, ago, day } from "../../ui";
import EmailDraft from "./EmailDraft";
import VideoDemoSlot from "./VideoDemoSlot";
import CopyButton from "./CopyButton";
import { ensureStubProspect } from "@/lib/sales/video-demo/fixture";
import { demoStore, isHot, type VideoDemoLink } from "@/lib/sales/video-demo/store";

export const dynamic = "force-dynamic";

/**
 * One lead: who they are, where they are, what happens next, and everything
 * that has happened so far.
 *
 * Works the same for an enquiry and for a researched prospect. What differs is
 * shown only where it exists: the agents' research and email draft belong to
 * researched prospects, the form's answers to enquiries.
 */
export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  seedIfEmpty();
  const user = await requireUser();
  if (!isBellineStaff(user)) return <p className="muted">Belline staff only.</p>;

  const raw = decodeURIComponent((await params).id);
  // Old links were the bare Postgres id.
  if (/^\d+$/.test(raw)) redirect(leadHref(`db:${raw}`));
  const parsed = parseLeadId(raw);
  if (!parsed) notFound();

  let lead: UnifiedLead;
  let facts: [string, React.ReactNode][] = [];
  let research: Awaited<ReturnType<typeof getResearch>> = undefined;
  let dbActivity: Awaited<ReturnType<typeof getTimeline>> = [];
  let draft: Awaited<ReturnType<typeof draftForLead>> = null;
  let demos: VideoDemoLink[] = [];

  if (parsed.store === "json") {
    const row = getJsonLead(parsed.id);
    if (!row) notFound();
    lead = fromJson(row, crmFor(raw));
    facts = [
      ["Wants", row.intent],
      ["Trade", row.vertical],
      ["Country", row.market ? MARKETS[row.market]?.name : undefined],
      ["Locations", row.venues],
      ["Calls a day", row.callVolume],
      ["Free to talk", row.availability],
      ["Timezone", row.timezone],
      ["Email check", row.emailCheck.mx === null ? "Domain could not be checked when this came in" : row.emailCheck.role ? "A shared mailbox, not a person" : undefined],
      // The form's page name says which button they pressed; Belle's and the waitlist's are already the source tag.
      ["Came from", lead.source === "enquiry" ? `The website form (${row.source})` : SOURCE_LABEL[lead.source]],
    ];
  } else {
    const demoLinks = demoStore();
    // The demos' own rows. With the sales database they are already in
    // `getTimeline` (sales.activity); a stubbed run keeps them in memory.
    await ensureStubProspect();
    const [row, demoList, demoTimeline] = await Promise.all([
      getDbLead(parsed.id),
      demoLinks.list({ leadId: parsed.id, limit: 20 }).catch(() => []),
      demoLinks.kind === "memory" ? demoLinks.timeline(parsed.id).catch(() => []) : Promise.resolve([]),
    ]);
    demos = demoList;
    if (!row) {
      // A stubbed local run has no sales database: the made-up prospect lives in the demo store only.
      const stub = demoLinks.kind === "memory" ? await demoLinks.loadSource(parsed.id) : null;
      if (!stub) notFound();
      dbActivity = demoTimeline.map((a) => ({ ...a, at: new Date(a.at) }));
      lead = fromDb(
        {
          id: stub.leadId,
          company_id: stub.companyId ?? 0,
          name: stub.company.name,
          email: stub.contact?.email ?? stub.company.email ?? null,
          phone_e164: null,
          website: stub.company.website ?? null,
          country_code: stub.company.country_code ?? null,
          city: stub.company.city ?? null,
          stage: "researched",
          current_score: null,
          priority: null,
          created_at: new Date(stub.research?.created_at ?? Date.now()),
          updated_at: new Date(stub.research?.created_at ?? Date.now()),
          last_activity_at: demoTimeline[0]?.at ?? null,
          drafts: 0,
          summary: stub.research?.summary ?? null,
        },
        crmFor(raw),
      );
      facts = [["Found by", "Made-up prospect for a local run"]];
    } else {
      const [r, timeline, d] = await Promise.all([getResearch(row.company_id), getTimeline(parsed.id), draftForLead(parsed.id)]);
      research = r;
      dbActivity = timeline;
      draft = d;
      lead = fromDb(
        {
          id: row.lead_id,
          company_id: row.company_id,
          name: row.name,
          email: row.email,
          phone_e164: row.phone_e164,
          website: row.website,
          country_code: null,
          city: row.city,
          stage: row.stage,
          current_score: row.current_score,
          priority: row.priority,
          created_at: row.created_at,
          updated_at: row.created_at,
          last_activity_at: timeline[0]?.at ?? null,
          drafts: d && ["draft", "pending_approval"].includes(d.status) ? 1 : 0,
          summary: r?.summary ?? null,
        },
        crmFor(raw),
      );
      facts = [
        ["Address", row.address],
        ["Rating", row.rating ? `${row.rating} stars from ${row.review_count ?? 0} reviews` : undefined],
        ["WhatsApp", row.has_whatsapp ? "They use WhatsApp" : undefined],
        ["Found by", row.agent_name],
        ["Found on", row.sources?.map((s) => s.slug.replace(/_/g, " ")).join(", ")],
      ];
    }
  }

  // A demo link that turned Hot records `demo_watched` on the lead (service.ts);
  // links that turned Hot before that hook existed still count here.
  const hot = lead.hot || demos.some((d) => isHot(d.stats));
  const staff = staffUsers();
  const timeline = mergeTimeline(raw, { createdAt: lead.createdAt, source: lead.source, dbActivity, viewer: user });
  const signals = Object.entries((research?.signals ?? {}) as Record<string, unknown>);
  const has = signals.filter(([, v]) => v !== null && v !== false && !(Array.isArray(v) && v.length === 0));
  const lacks = signals.filter(([, v]) => v === false);
  const unknown = signals.filter(([, v]) => v === null);
  const words = (k: string) => k.replace(/_/g, " ");

  return (
    <>
      <p style={{ margin: "0 0 10px" }}>
        <Link href="/sales/leads" className="muted" style={{ fontSize: 12.5 }}>
          ← Leads
        </Link>
      </p>
      <ConsoleHeader
        title={lead.name}
        subtitle={
          <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <Pill>{SOURCE_LABEL[lead.source]}</Pill>
            <Pill tone="accent">{STAGE_LABEL[lead.stage]}</Pill>
            {hot && <Pill tone="warn">Hot</Pill>}
            {lead.score !== null && <Pill>Score {lead.score}</Pill>}
            {[lead.contactName, lead.city, lead.countryName].filter(Boolean).join(" · ")}
          </span>
        }
        actions={
          <>
            {lead.email && (
              <>
                <a className="btn btn-row btn-accent" href={`mailto:${lead.email}`}>
                  Email {lead.email}
                </a>
                <CopyButton value={lead.email} label="Copy email" />
              </>
            )}
            {lead.phone && (
              <>
                <a className="btn btn-row" href={`tel:${lead.phone}`}>
                  Call {lead.phone}
                </a>
                <CopyButton value={lead.phone} label="Copy number" />
              </>
            )}
            {lead.website && (
              <a className="btn btn-row" href={/^https?:\/\//.test(lead.website) ? lead.website : `https://${lead.website}`} target="_blank" rel="noopener noreferrer nofollow">
                Website
              </a>
            )}
          </>
        }
      />

      <div className="staff-grid">
        <div className="staff-stack">
          {parsed.store === "db" && (
            <section id="email-draft" className="panel staff-section">
              <div className="panel-head">Email draft</div>
              <div className="staff-body">
                {draft ? (
                  <EmailDraft
                    draft={{
                      id: draft.id,
                      company: lead.name,
                      status: draft.status,
                      toAddress: draft.toAddress,
                      subject: draft.subject,
                      body: draft.body,
                      parts: draft.parts,
                      problems: draft.problems,
                      warnings: draft.warnings,
                      demoUrl: draft.demoUrl,
                      sentAt: draft.sentAt,
                    }}
                  />
                ) : (
                  <EmptyState title="No draft for this lead">
                    The drafting agent writes one for a qualified lead once it has a demo. Run drafting from Settings, or
                    write to them yourself with the Email button above.
                  </EmptyState>
                )}
              </div>
            </section>
          )}

          <section id="video-demo" className="staff-section" aria-label="Video demo">
            <VideoDemoSlot lead={lead} demos={demos} />
          </section>

          {parsed.store === "db" && (
            <section className="panel staff-section">
              <div className="panel-head">
                What the research found
                {research && <span className="muted">read {day(new Date(research.created_at).toISOString())} from {research.pages_read.length} page{research.pages_read.length === 1 ? "" : "s"}</span>}
              </div>
              {research ? (
                <div className="staff-body" style={{ display: "grid", gap: 14 }}>
                  <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.65 }}>{research.summary}</p>
                  {has.length > 0 && <KeyValues rows={[["They have", has.map(([k, v]) => (typeof v === "number" || Array.isArray(v) ? `${words(k)} (${Array.isArray(v) ? v.join(", ") : v})` : words(k))).join(", ")]]} />}
                  {lacks.length > 0 && <KeyValues rows={[["They don't have", lacks.map(([k]) => words(k)).join(", ")]]} />}
                  {unknown.length > 0 && <KeyValues rows={[["Could not tell", unknown.map(([k]) => words(k)).join(", ")]]} />}
                  {research.evidence.length > 0 && (
                    <div>
                      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                        Where each point came from
                      </div>
                      {research.evidence.map((e, i) => (
                        <div key={i} style={{ padding: "8px 0", borderTop: i ? "1px solid var(--bl-rule-soft)" : "none" }}>
                          <div style={{ fontSize: 13, fontWeight: 600 }}>{e.claim}</div>
                          <div style={{ fontSize: 12.5, margin: "4px 0", color: "var(--bl-text-2)" }}>&ldquo;{e.quote}&rdquo;</div>
                          <a href={e.url} target="_blank" rel="noopener noreferrer nofollow" className="muted" style={{ fontSize: 11.5 }}>
                            {e.url.replace(/^https?:\/\//, "").slice(0, 80)}
                          </a>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <EmptyState title="Not researched yet">The research agent has not read this company&apos;s website. Run research from Settings.</EmptyState>
              )}
            </section>
          )}

          <section className="panel staff-section">
            <div className="panel-head">Timeline</div>
            {timeline.length === 0 ? (
              <EmptyState title="Nothing recorded yet" />
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {timeline.map((t) => (
                  <li key={t.id} style={{ padding: "10px 18px", borderTop: "1px solid var(--bl-rule-soft)" }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                      <strong style={{ fontSize: 13 }}>{eventLabel(t.type)}</strong>
                      <span className="muted" style={{ fontSize: 12 }}>{t.who}</span>
                      <span className="muted" style={{ fontSize: 11.5, marginLeft: "auto" }} title={t.at}>
                        {ago(t.at)}
                      </span>
                    </div>
                    {t.type !== "note" && <div style={{ fontSize: 13, marginTop: 2 }}>{t.summary}</div>}
                    {t.body && <div style={{ fontSize: 13, marginTop: 4, whiteSpace: "pre-wrap", lineHeight: 1.55 }}>{t.body}</div>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div className="staff-stack">
          <section className="panel staff-section">
            <div className="panel-head">Next step</div>
            <div className="staff-body" style={{ display: "grid", gap: 12 }}>
              <KeyValues
                rows={[
                  ["Stage", STAGE_LABEL[lead.stage]],
                  ["Owner", lead.ownerName ?? "Nobody yet"],
                  ["Next step", lead.nextAction ? `${lead.nextAction}${lead.nextActionDue ? `, by ${day(lead.nextActionDue)}` : ""}` : "None set"],
                ]}
              />
              <div className="staff-row-actions">
                <Action
                  endpoint="/api/sales/leads"
                  body={{ leadId: raw, action: "stage" }}
                  label="Change stage"
                  small
                  fields={[
                    { name: "stage", label: "Stage", type: "select", defaultValue: lead.stage, options: STAGES.map((s) => ({ value: s, label: STAGE_LABEL[s] })) },
                    { name: "reason", label: "Why (needed for Lost and Do not contact)", type: "textarea" },
                  ]}
                  submitLabel="Save stage"
                />
                <Action
                  endpoint="/api/sales/leads"
                  body={{ leadId: raw, action: "owner" }}
                  label="Assign"
                  small
                  fields={[
                    {
                      name: "ownerUserId",
                      label: "Owner",
                      type: "select",
                      defaultValue: lead.ownerUserId ?? "",
                      options: [{ value: "", label: "Nobody" }, ...staff.map((s) => ({ value: s.id, label: s.id === user.id ? `${s.name || s.email} (you)` : s.name || s.email }))],
                    },
                  ]}
                  submitLabel="Save owner"
                />
                <Action
                  endpoint="/api/sales/leads"
                  body={{ leadId: raw, action: "next" }}
                  label="Set next step"
                  small
                  fields={[
                    { name: "nextAction", label: "What happens next", type: "text", defaultValue: lead.nextAction ?? "", placeholder: "Call back about pricing" },
                    { name: "due", label: "By", type: "date", defaultValue: lead.nextActionDue ?? "" },
                  ]}
                  submitLabel="Save next step"
                />
              </div>
            </div>
          </section>

          <section className="panel staff-section">
            <div className="panel-head">Notes</div>
            <div className="staff-body" style={{ display: "grid", gap: 10 }}>
              {(crmFor(raw)?.notes.length ?? 0) === 0 && <p className="staff-note">No notes yet. Notes are for the team, never shown to the lead.</p>}
              <Action
                endpoint="/api/sales/leads"
                body={{ leadId: raw, action: "note" }}
                label="Add a note"
                small
                fields={[{ name: "text", label: "Note", type: "textarea", required: true }]}
                submitLabel="Save note"
                done="Note saved."
              />
            </div>
          </section>

          <section className="panel staff-section">
            <div className="panel-head">Details</div>
            <div className="staff-body">
              <KeyValues rows={[["Email", lead.email], ["Phone", lead.phone], ["Website", lead.website], ["Came in", day(lead.createdAt)], ...facts]} />
              {lead.notes && (
                <p style={{ fontSize: 13, lineHeight: 1.6, margin: "12px 0 0", whiteSpace: "pre-wrap" }}>
                  <span className="muted">What they said: </span>
                  {lead.notes}
                </p>
              )}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

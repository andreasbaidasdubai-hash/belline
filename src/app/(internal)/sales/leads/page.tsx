import Link from "next/link";
import { requireUser } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import { seedIfEmpty } from "@/lib/seed";
import { SOURCE_LABEL, allLeads, filterLeads, leadHref, staffUsers, type LeadFilter, type SourceTag } from "@/lib/staff/leads";
import { STAGES, STAGE_LABEL, isStage } from "@/lib/staff/stages";
import { ConsoleHeader, EmptyState, FilterChips, Pill, SearchBox, ago, day } from "../ui";
import DemoBuilder from "./DemoBuilder";

export const dynamic = "force-dynamic";

/**
 * Every lead, from every source, in one list.
 *
 * Enquiries, Belle's leads, the DACH waitlist and the prospects the agents
 * researched used to be three pages over two stores. They are one list now
 * (lib/staff/leads.ts), filtered by chips that are links, so any view can be
 * bookmarked. "Drafts to review" is the old approval queue.
 */

type Params = { source?: string; stage?: string; country?: string; owner?: string; hot?: string; view?: string; q?: string; build?: string };

const SOURCES = Object.keys(SOURCE_LABEL) as SourceTag[];

export default async function LeadsPage({ searchParams }: { searchParams: Promise<Params> }) {
  seedIfEmpty();
  const user = await requireUser();
  if (!isBellineStaff(user)) return <p className="muted">Belline staff only.</p>;

  const p = await searchParams;
  const { leads, pipelineRead } = await allLeads();
  const staff = staffUsers();
  const filter: LeadFilter = {
    source: SOURCES.includes(p.source as SourceTag) ? (p.source as SourceTag) : undefined,
    stage: isStage(p.stage) ? p.stage : undefined,
    country: p.country || undefined,
    owner: p.owner === "me" ? user.id : p.owner || undefined,
    hot: p.hot === "1",
    drafts: p.view === "drafts",
    q: p.q,
  };
  const shown = filterLeads(leads, filter);

  const href = (next: Partial<Params>) => {
    const merged: Params = { source: p.source, stage: p.stage, country: p.country, owner: p.owner, hot: p.hot, view: p.view, q: p.q, ...next };
    const qs = new URLSearchParams(Object.entries(merged).filter(([, v]) => v) as [string, string][]).toString();
    return qs ? `/sales/leads?${qs}` : "/sales/leads";
  };
  const countries = [...new Map(leads.filter((l) => l.country).map((l) => [l.country!.toUpperCase(), l.countryName ?? l.country!])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const anyFilter = Boolean(filter.source || filter.stage || filter.country || filter.owner || filter.hot || filter.drafts || filter.q);

  return (
    <>
      <ConsoleHeader
        title="Leads"
        subtitle={`${shown.length} of ${leads.length} lead${leads.length === 1 ? "" : "s"}${pipelineRead ? "" : " · researched prospects hidden: the sales database is not connected"}`}
        actions={
          p.build ? (
            <Link href={href({})} className="btn">
              Close demo builder
            </Link>
          ) : (
            <Link href={href({ build: "1" })} className="btn btn-accent">
              Build demo from website
            </Link>
          )
        }
      />

      {p.build && <DemoBuilder />}

      <FilterChips
        label="Show"
        items={[
          { label: "All", href: href({ hot: undefined, view: undefined }), on: !filter.hot && !filter.drafts },
          { label: "Hot", href: href({ hot: "1", view: undefined }), on: Boolean(filter.hot), count: leads.filter((l) => l.hot).length },
          { label: "Drafts to review", href: href({ view: "drafts", hot: undefined }), on: Boolean(filter.drafts), count: leads.filter((l) => l.drafts > 0).length },
        ]}
      />
      <FilterChips
        label="Stage"
        items={[
          { label: "Any", href: href({ stage: undefined }), on: !filter.stage },
          ...STAGES.map((s) => ({ label: STAGE_LABEL[s], href: href({ stage: s }), on: filter.stage === s, count: leads.filter((l) => l.stage === s).length })),
        ]}
      />
      <FilterChips
        label="Source"
        items={[
          { label: "Any", href: href({ source: undefined }), on: !filter.source },
          ...SOURCES.filter((s) => leads.some((l) => l.source === s) || filter.source === s).map((s) => ({ label: SOURCE_LABEL[s], href: href({ source: s }), on: filter.source === s, count: leads.filter((l) => l.source === s).length })),
        ]}
      />
      <FilterChips
        label="Owner"
        items={[
          { label: "Anyone", href: href({ owner: undefined }), on: !p.owner },
          { label: "Me", href: href({ owner: "me" }), on: p.owner === "me" },
          { label: "Nobody yet", href: href({ owner: "none" }), on: p.owner === "none" },
          ...staff.filter((s) => s.id !== user.id).map((s) => ({ label: s.name || s.email, href: href({ owner: s.id }), on: p.owner === s.id })),
        ]}
      />
      {countries.length > 1 && (
        <FilterChips
          label="Country"
          items={[{ label: "Any", href: href({ country: undefined }), on: !filter.country }, ...countries.map(([code, name]) => ({ label: name, href: href({ country: code }), on: filter.country?.toUpperCase() === code }))]}
        />
      )}
      <SearchBox action="/sales/leads" q={p.q} keep={{ source: p.source, stage: p.stage, country: p.country, owner: p.owner, hot: p.hot, view: p.view }} placeholder="Search name, email, phone or website" />

      <div className="panel">
        {shown.length === 0 ? (
          anyFilter ? (
            <EmptyState title="No lead matches these filters" action={<Link href="/sales/leads" className="btn btn-row">Clear filters</Link>} />
          ) : (
            <EmptyState title="No leads yet">
              Enquiries from the website, people Belle talks to and the DACH waitlist land here on their own. To add
              researched prospects, run discovery from Settings, or build a demo from a prospect&apos;s website above.
            </EmptyState>
          )
        ) : (
          <div className="table-wrap" tabIndex={0}>
            <table className="staff-table">
              <thead>
                <tr>
                  <th>Lead</th>
                  <th>Source</th>
                  <th>Country</th>
                  <th>Stage</th>
                  <th className="num">Score</th>
                  <th>Owner</th>
                  <th>Next step</th>
                  <th>Last activity</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((l) => (
                  <tr key={l.id}>
                    <td style={{ minWidth: 200 }}>
                      <Link href={leadHref(l.id)} style={{ fontWeight: 600 }}>
                        {l.name}
                      </Link>
                      {l.hot && (
                        <>
                          {" "}
                          <Pill tone="warn">Hot</Pill>
                        </>
                      )}
                      <div className="sub">{[l.contactName, l.email, l.city].filter(Boolean).join(" · ")}</div>
                      {l.drafts > 0 && (
                        <div className="sub">
                          <Link href={`${leadHref(l.id)}#email-draft`}>Email draft waiting</Link>
                        </div>
                      )}
                    </td>
                    <td>
                      <Pill>{SOURCE_LABEL[l.source]}</Pill>
                    </td>
                    <td style={{ fontSize: 12.5 }}>{l.countryName ?? <span className="muted">—</span>}</td>
                    <td>
                      <Pill tone={l.stage === "customer" ? "ok" : l.stage === "demo_watched" ? "warn" : l.stage === "lost" || l.stage === "do_not_contact" ? undefined : "accent"}>{STAGE_LABEL[l.stage]}</Pill>
                    </td>
                    <td className="num">{l.score ?? <span className="muted">—</span>}</td>
                    <td style={{ fontSize: 12.5 }}>{l.ownerName ?? <span className="muted">Nobody</span>}</td>
                    <td style={{ fontSize: 12.5, minWidth: 140 }}>
                      {l.nextAction ? (
                        <>
                          {l.nextAction}
                          {l.nextActionDue && <div className="sub">by {day(l.nextActionDue)}</div>}
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="muted" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
                      {ago(l.lastActivityAt)}
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

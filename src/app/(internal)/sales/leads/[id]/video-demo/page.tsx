import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import { leadHref, parseLeadId } from "@/lib/staff/leads";
import { ensureStubProspect } from "@/lib/sales/video-demo/fixture";
import { demoLimits, linkView, previewVideoDemo } from "@/lib/sales/video-demo/service";
import { demoStore } from "@/lib/sales/video-demo/store";
import { ConsoleHeader, EmptyState } from "../../../ui";
import { requestDemoOrigin } from "../../demo-origin";
import VideoDemoPanel from "./VideoDemoPanel";

export const dynamic = "force-dynamic";

/**
 * "Create video demo" for one lead: the opening Belle will say (editable,
 * checked against the research before a link can exist), the link, the email
 * draft, and every link this lead has had, with what the prospect did on it.
 *
 * Video demos are for researched prospects, so the id is a `db:` lead; the
 * bare number of the old links still works.
 */
export default async function LeadVideoDemoPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!isBellineStaff(user)) return <p className="muted">Belline staff only.</p>;

  const raw = decodeURIComponent((await params).id);
  const parsed = /^\d+$/.test(raw) ? parseLeadId(`db:${raw}`) : parseLeadId(raw);
  if (!parsed) notFound();
  const back = leadHref(parsed.store === "db" ? `db:${parsed.id}` : `json:${parsed.id}`);
  if (parsed.store !== "db") {
    return (
      <>
        <ConsoleHeader title="Video demo" />
        <div className="panel">
          <EmptyState title="Only for researched prospects" action={<Link href={back} className="btn btn-row">Back to lead</Link>}>
            Belle&apos;s pitch is written from the research on a prospect&apos;s website, and this lead has none.
          </EmptyState>
        </div>
      </>
    );
  }
  const leadId = parsed.id;
  await ensureStubProspect();

  const origin = await requestDemoOrigin();
  if (!origin.ok) return <p className="muted">{origin.error}</p>;

  const store = demoStore();
  const [preview, links, timeline] = await Promise.all([previewVideoDemo(leadId), store.list({ leadId }), store.timeline(leadId)]);
  if (!preview.ok && preview.status === 404) notFound();

  return (
    <>
      <p style={{ margin: "0 0 10px" }}>
        <Link href={back} className="muted" style={{ fontSize: 12.5 }}>
          ← Back to lead
        </Link>
      </p>
      <ConsoleHeader
        title={preview.ok ? `Video demo · ${preview.facts.businessName}` : "Video demo"}
        subtitle="A personal video pitch by Belle, from this lead's research, and the email that links to it"
      />
      <VideoDemoPanel
        leadId={leadId}
        preview={preview.ok ? { facts: preview.facts, opening: preview.opening, check: preview.check } : null}
        unavailable={preview.ok ? null : preview.error}
        links={links.map((l) => linkView(l, origin.origin))}
        timeline={timeline}
        limits={demoLimits()}
        storeKind={store.kind}
      />
    </>
  );
}

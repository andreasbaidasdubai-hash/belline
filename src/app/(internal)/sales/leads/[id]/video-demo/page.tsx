import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import { PageHeader } from "@/components/LocationTabs";
import { ensureStubProspect } from "@/lib/sales/video-demo/fixture";
import { demoOrigin, demoLimits, linkView, previewVideoDemo } from "@/lib/sales/video-demo/service";
import { demoStore } from "@/lib/sales/video-demo/store";
import { headers } from "next/headers";
import VideoDemoPanel from "./VideoDemoPanel";

export const dynamic = "force-dynamic";

/**
 * "Create video demo" for one lead: the opening Belle will say (editable,
 * checked against the research before a link can exist), the link, the email
 * draft, and every link this lead has had, with what the prospect did on it.
 */
export default async function LeadVideoDemoPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!isBellineStaff(user)) return null;

  const leadId = Number((await params).id);
  if (!Number.isFinite(leadId)) notFound();
  await ensureStubProspect();

  const head = await headers();
  const host = head.get("x-forwarded-host") ?? head.get("host") ?? "localhost:3000";
  const proto = head.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  let origin: string;
  try {
    origin = demoOrigin(`${proto}://${host}`);
  } catch (err) {
    // Links pointing at the wrong site are worse than none (outreach/templates.ts).
    return <p className="muted">{err instanceof Error ? err.message : "PUBLIC_ORIGIN is not usable."}</p>;
  }

  const store = demoStore();
  const [preview, links, timeline] = await Promise.all([
    previewVideoDemo(leadId),
    store.list({ leadId }),
    store.timeline(leadId),
  ]);
  if (!preview.ok && preview.status === 404) notFound();

  const limits = demoLimits();
  return (
    <>
      <PageHeader
        title={preview.ok ? `Video demo · ${preview.facts.businessName}` : "Video demo"}
        subtitle="A personal video pitch by Belle, from this lead's research, and the email that links to it"
      />
      <VideoDemoPanel
        leadId={leadId}
        preview={preview.ok ? { facts: preview.facts, opening: preview.opening, check: preview.check } : null}
        unavailable={preview.ok ? null : preview.error}
        links={links.map((l) => linkView(l, origin))}
        timeline={timeline}
        limits={limits}
        storeKind={store.kind}
      />
      <p style={{ marginTop: 20 }}>
        <Link href={`/sales/leads/${leadId}`} className="muted" style={{ fontSize: 12.5 }}>
          ← Back to lead
        </Link>
      </p>
    </>
  );
}

import Link from "next/link";
import { leadHref, type UnifiedLead } from "@/lib/staff/leads";
import { linkView } from "@/lib/sales/video-demo/service";
import { demoStatus, isHot, type VideoDemoLink } from "@/lib/sales/video-demo/store";
import Action from "../../Actions";
import { EmptyState, Pill, day } from "../../ui";
import { requestDemoOrigin } from "../demo-origin";
import CopyButton from "./CopyButton";

/**
 * The personalised video demo on a lead's page: every link this lead has had,
 * its state and what the prospect did on it, Hot when they watched for more
 * than a minute or asked Belle something, and the way to make a new one.
 *
 * Only for researched prospects (`db:` leads): Belle's pitch is written from
 * the research, and an enquiry has none. What happens on a link reaches the
 * lead's timeline as `demo_issued` / `demo_used` activity, and the first time
 * a link turns Hot, `recordDemoEvent` records `demo_watched` through
 * `recordLeadEvent`, which marks the lead hot in the list and on Today.
 */
export default async function VideoDemoSlot({ lead, demos }: { lead: UnifiedLead; demos: VideoDemoLink[] }): Promise<React.ReactNode> {
  if (lead.store !== "db") return null;

  const create = `${leadHref(lead.id)}/video-demo`;
  const origin = await requestDemoOrigin();
  const links = origin.ok ? demos.map((d) => linkView(d, origin.origin)) : [];
  const hot = demos.some((d) => isHot(d.stats));
  const active = demos.filter((d) => demoStatus(d) === "active").length;
  const opens = demos.reduce((n, d) => n + d.stats.opens, 0);
  const seconds = demos.reduce((n, d) => n + d.stats.videoSeconds, 0);

  return (
    <div className="panel">
      <div className="panel-head">
        <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
          Video demo
          {hot && (
            <span title="Watched the video demo for over a minute, or asked Belle a question">
              <Pill tone="warn">Hot</Pill>
            </span>
          )}
        </span>
        {demos.length > 0 && (
          <span className="muted">
            {demos.length} link{demos.length === 1 ? "" : "s"}, {active} active · {opens} open{opens === 1 ? "" : "s"} · {seconds}s watched
          </span>
        )}
      </div>
      {!origin.ok ? (
        <EmptyState title="Demo links cannot be shown">{origin.error}</EmptyState>
      ) : links.length === 0 ? (
        <EmptyState title="No video demo yet" action={<Link href={create} className="btn btn-row btn-accent">Create video demo</Link>}>
          A personal video pitch by Belle, written from this lead&apos;s research, with an email draft that links to it.
        </EmptyState>
      ) : (
        <>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {links.map((l) => (
              <li key={l.id} style={{ padding: "10px 18px", borderTop: "1px solid var(--bl-rule-soft)", display: "grid", gap: 6 }}>
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <Pill tone={l.status === "active" ? "accent" : undefined}>{l.status === "active" ? "Active" : l.status === "expired" ? "Expired" : "Revoked"}</Pill>
                  {l.hot && <Pill tone="warn">Hot</Pill>}
                  <span className="muted" style={{ fontSize: 12 }}>
                    Made {day(l.createdAt)} · {l.status === "revoked" ? `revoked ${day(l.revokedAt)}` : `ends ${day(l.expiresAt)}`}
                  </span>
                </div>
                <div className="muted" style={{ fontSize: 12.5 }}>
                  {l.stats.opens} opens · {l.stats.videoSessions} video calls ({l.stats.videoSeconds}s, longest {l.stats.longestVideoSeconds}s) · {l.stats.chats} chats ·{" "}
                  {l.stats.questions} questions
                  {l.stats.outcomes.length ? ` · ${l.stats.outcomes.join(", ")}` : ""}
                </div>
                {l.status === "active" && (
                  <div className="staff-row-actions">
                    <CopyButton value={l.url} label="Copy link" />
                    <a className="btn btn-row" href={l.url} target="_blank" rel="noopener noreferrer">
                      Open demo
                    </a>
                    <Action
                      endpoint="/api/sales/video-demos"
                      body={{ action: "revoke", id: l.id }}
                      label="Revoke"
                      small
                      tone="danger"
                      confirm={`Revoke the demo link for ${l.businessName}? The page stops working at once.`}
                      submitLabel="Revoke link"
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
          <div className="staff-body" style={{ borderTop: "1px solid var(--bl-rule-soft)" }}>
            <Link href={create} className="btn btn-row btn-accent">
              Create video demo
            </Link>{" "}
            <Link href={create} className="btn btn-row">
              Email drafts and timeline
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

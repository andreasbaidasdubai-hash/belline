import Link from "next/link";
import { leadHref } from "@/lib/staff/leads";
import { STUB_LEAD_ID } from "@/lib/sales/video-demo/fixture";
import { linkView } from "@/lib/sales/video-demo/service";
import { demoStore, type VideoDemoLink } from "@/lib/sales/video-demo/store";
import Action from "../Actions";
import { EmptyState, Pill, day } from "../ui";
import { requestDemoOrigin } from "./demo-origin";

/**
 * Leads, "Video demos" view: every personalised video-demo link, who it is
 * for, its state and what happened on it. Was /sales/video-demos, which now
 * redirects here.
 */
export default async function VideoDemoList({ links: rows }: { links: VideoDemoLink[] }) {
  const origin = await requestDemoOrigin();
  if (!origin.ok) return <EmptyState title="Demo links cannot be shown">{origin.error}</EmptyState>;
  const links = rows.map((l) => linkView(l, origin.origin));

  if (links.length === 0) {
    return (
      <EmptyState title="No video demo links yet">
        Open a researched lead and choose Create video demo.
        {demoStore().kind === "memory" && (
          <>
            {" "}
            Local run: <Link href={`${leadHref(`db:${STUB_LEAD_ID}`)}/video-demo`}>try the made-up prospect</Link>.
          </>
        )}
      </EmptyState>
    );
  }

  return (
    <div className="table-wrap" tabIndex={0}>
      <table className="staff-table">
        <thead>
          <tr>
            <th>Business</th>
            <th>Status</th>
            <th>What happened</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {links.map((l) => (
            <tr key={l.id}>
              <td style={{ minWidth: 200 }}>
                <Link href={leadHref(`db:${l.leadId}`)} style={{ fontWeight: 600 }}>
                  {l.businessName}
                </Link>
                <div className="sub">
                  Made {day(l.createdAt)} · ends {day(l.expiresAt)}
                </div>
              </td>
              <td>
                <Pill tone={l.status === "active" ? "accent" : undefined}>{l.status === "active" ? "Active" : l.status === "expired" ? "Expired" : "Revoked"}</Pill>{" "}
                {l.hot && <Pill tone="warn">Hot</Pill>}
              </td>
              <td className="muted" style={{ fontSize: 12.5 }}>
                {l.stats.opens} opens · {l.stats.videoSessions} video calls · {l.stats.videoSeconds}s · {l.stats.chats} chats · {l.stats.questions} questions
                {l.stats.outcomes.length ? ` · ${l.stats.outcomes.join(", ")}` : ""}
              </td>
              <td style={{ textAlign: "right" }}>
                <div className="staff-row-actions" style={{ justifyContent: "flex-end" }}>
                  <Link href={`${leadHref(`db:${l.leadId}`)}/video-demo`} className="btn btn-row">
                    Details
                  </Link>
                  {l.status === "active" && (
                    <Action
                      endpoint="/api/sales/video-demos"
                      body={{ action: "revoke", id: l.id }}
                      label="Revoke"
                      small
                      tone="danger"
                      confirm={`Revoke the demo link for ${l.businessName}? The page stops working at once.`}
                      submitLabel="Revoke link"
                    />
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

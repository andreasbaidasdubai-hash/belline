import Link from "next/link";
import { headers } from "next/headers";
import { requireUser } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import { PageHeader } from "@/components/LocationTabs";
import { ensureStubProspect, STUB_LEAD_ID } from "@/lib/sales/video-demo/fixture";
import { demoOrigin, linkView } from "@/lib/sales/video-demo/service";
import { demoStore } from "@/lib/sales/video-demo/store";
import RevokeButton from "./RevokeButton";

export const dynamic = "force-dynamic";

/** Every personalised video-demo link: who it is for, its state, what happened on it. */
export default async function VideoDemosPage() {
  const user = await requireUser();
  if (!isBellineStaff(user)) return null;
  await ensureStubProspect();

  const head = await headers();
  const host = head.get("x-forwarded-host") ?? head.get("host") ?? "localhost:3000";
  const proto = head.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  let origin: string;
  try {
    origin = demoOrigin(`${proto}://${host}`);
  } catch (err) {
    return <p className="muted">{err instanceof Error ? err.message : "PUBLIC_ORIGIN is not usable."}</p>;
  }

  const store = demoStore();
  const links = (await store.list({ limit: 200 })).map((l) => linkView(l, origin));

  return (
    <>
      <PageHeader title="Video demos" subtitle="Personal video pitches by Belle, one link per lead" />
      <div className="panel">
        {links.length === 0 ? (
          <p className="muted" style={{ padding: "22px 18px", margin: 0, fontSize: 13 }}>
            No demo links yet. Open a lead and choose Create video demo.
            {store.kind === "memory" && (
              <>
                {" "}
                Local run: <Link href={`/sales/leads/${STUB_LEAD_ID}/video-demo`}>try the made-up prospect</Link>.
              </>
            )}
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Business</th>
                <th>Status</th>
                <th>Activity</th>
                <th>Cost</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {links.map((l) => (
                <tr key={l.id}>
                  <td style={{ fontSize: 13 }}>
                    <Link href={`/sales/leads/${l.leadId}/video-demo`}>{l.businessName}</Link>
                    <div className="muted mono" style={{ fontSize: 11 }}>
                      created {new Date(l.createdAt).toLocaleDateString()} · expires {new Date(l.expiresAt).toLocaleDateString()}
                    </div>
                  </td>
                  <td>
                    <span className="pill" style={{ fontSize: 10.5 }}>{l.status}</span>{" "}
                    {l.hot && (
                      <span className="pill" style={{ fontSize: 10.5, color: "var(--ok)", fontWeight: 700 }}>
                        Hot
                      </span>
                    )}
                  </td>
                  <td className="muted" style={{ fontSize: 12 }}>
                    {l.stats.opens} opens · {l.stats.videoSessions} video · {l.stats.videoSeconds}s · {l.stats.chats} chats · {l.stats.questions} questions
                    {l.stats.outcomes.length ? ` · ${l.stats.outcomes.join(", ")}` : ""}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>${l.stats.costUsd.toFixed(2)}</td>
                  <td style={{ textAlign: "right" }}>{l.status === "active" && <RevokeButton id={l.id} name={l.businessName} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

import { getLocation } from "@/lib/store";
import { EmptyState, Pill } from "../ui";
import type { DeliveredCeiling, VideoEnding } from "@/lib/video/delivery";

/**
 * How the last video calls ended, in the provider's own words.
 *
 * This exists because a founder's demo call stopped at 88 seconds of the 300
 * we ask for and nothing anywhere said so. The reason was in the webhook and
 * went into a call record nobody reads; every dashboard the team looks at
 * showed a completed call. A run of short calls has to be visible, because it
 * is the difference between a bug in our timers and a bill to pay at Tavus.
 *
 * Staff-only, like the rest of this page. Raw provider strings are fine here
 * and nowhere a visitor can reach (lib/video/end-reason.ts).
 */

const CAUSE: Record<VideoEnding["cause"], { label: string; tone?: "ok" | "warn" }> = {
  visitor: { label: "They ended it" },
  wrapped_up: { label: "Wrapped up", tone: "ok" },
  time_limit: { label: "Our limit", tone: "ok" },
  cut_short: { label: "Cut short", tone: "warn" },
  connection: { label: "Connection", tone: "warn" },
};

function promise(delivered: DeliveredCeiling, configured: number): string {
  if (!delivered.shortfall) return `Pages promise ${configured}s, which is what we ask for and what we have been getting.`;
  return delivered.seconds === null
    ? "Pages have stopped promising a length: recent calls do not agree on one."
    : `Pages now promise ${delivered.seconds}s instead of ${configured}s, because that is what we have actually delivered.`;
}

export default function VideoEndings({ endings, delivered, configured }: { endings: VideoEnding[]; delivered: DeliveredCeiling; configured: number }) {
  return (
    <>
      <h2 style={{ margin: "28px 0 6px", fontSize: 16 }}>How video calls ended</h2>
      <p className="muted" style={{ margin: "0 0 10px", fontSize: 13 }}>
        The last {endings.length || "few"} endings, with the provider&apos;s own reason and how long the call really ran. {promise(delivered, configured)}
      </p>
      <div className="panel">
        {endings.length === 0 ? (
          <EmptyState title="No video calls yet">Nothing has ended since this server started.</EmptyState>
        ) : (
          <div className="table-wrap" tabIndex={0}>
            <table className="staff-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Venue</th>
                  <th>Ran for</th>
                  <th>What happened</th>
                  <th>The provider&apos;s words</th>
                </tr>
              </thead>
              <tbody>
                {endings.map((e) => {
                  const meta = CAUSE[e.cause];
                  return (
                    <tr key={`${e.sessionId}-${e.at}`}>
                      <td className="sub">{e.at.slice(11, 19)}</td>
                      <td>{getLocation(e.locationId)?.name ?? e.locationId}</td>
                      <td style={{ fontWeight: 600 }}>
                        {e.seconds}s
                        <span className="sub"> of {e.maxCallSeconds}s</span>
                      </td>
                      <td>
                        <Pill tone={meta.tone}>{meta.label}</Pill>
                        <div className="sub">ended by {e.endedBy}</div>
                      </td>
                      <td className="sub" style={{ maxWidth: 280, wordBreak: "break-word" }}>
                        {e.provider}: {e.reason || "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

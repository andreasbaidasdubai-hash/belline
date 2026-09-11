"use client";

import { useCallback, useRef } from "react";

/**
 * Reports that a prospect played their demo.
 *
 * `demo_used` is the strongest behavioural signal in the funnel before a reply
 * — someone who listened is far warmer than someone who merely opened — and it
 * feeds the lead score directly. It is also, per requirement §3, one of the
 * nine events the whole funnel is measured on.
 *
 * Fired once per page view, never blocking playback, and failing silently: a
 * prospect must hear the demo whether or not our analytics call succeeds.
 */
export default function PlayReporter({
  demoId,
  children,
}: {
  demoId: number;
  children: React.ReactNode;
}) {
  const sent = useRef(false);

  const report = useCallback(() => {
    if (sent.current) return;
    sent.current = true;
    // `keepalive` so the report survives the prospect navigating away
    // mid-listen, which is exactly when we most want to know they listened.
    void fetch("/api/demo-play", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ demoId }),
      keepalive: true,
    }).catch(() => {});
  }, [demoId]);

  return (
    <div
      onPlayCapture={report}
      onClickCapture={(e) => {
        // The play button is the only control here, and a click on it is the
        // intent — `play` alone can fire from a resumed buffer.
        if ((e.target as HTMLElement).closest(".demo-play")) report();
      }}
    >
      {children}
    </div>
  );
}

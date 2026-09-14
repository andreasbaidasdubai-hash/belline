"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { minutesToClock } from "@/lib/time";

/**
 * Keeps the dashboard current without a reload.
 *
 * Every ten seconds, while the tab is visible, it asks whether bookings or
 * calls have changed; if they have, the page re-renders in place. When the
 * change is a new booking Belle took, it says so in a small notice with a
 * link to open it.
 */

interface Stamp {
  stamp: string;
  latestFromBelle: { id: string; locationId: string; guestName: string; date: string; startMin: number } | null;
}

const EVERY_MS = 10_000;

export default function LiveRefresh() {
  const router = useRouter();
  const last = useRef<Stamp | null>(null);
  const [notice, setNotice] = useState<Stamp["latestFromBelle"]>(null);

  useEffect(() => {
    let stopped = false;
    async function tick() {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch("/api/live", { cache: "no-store" });
        if (!res.ok) return;
        const next = (await res.json()) as Stamp;
        const before = last.current;
        last.current = next;
        if (!before || before.stamp === next.stamp || stopped) return;
        router.refresh();
        if (next.latestFromBelle && next.latestFromBelle.id !== before.latestFromBelle?.id) setNotice(next.latestFromBelle);
      } catch {
        /* offline for a moment; try again next tick */
      }
    }
    void tick();
    const timer = setInterval(tick, EVERY_MS);
    const onVisible = () => void tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [router]);

  if (!notice) return null;
  return (
    <div className="live-notice" role="status">
      <span>
        <strong>New booking from Belle:</strong> {notice.guestName}, {notice.date} at {minutesToClock(notice.startMin)}
      </span>
      <a href={`/calendar?loc=${notice.locationId}&date=${notice.date}&open=${notice.id}`}>Open</a>
      <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)}>✕</button>
    </div>
  );
}

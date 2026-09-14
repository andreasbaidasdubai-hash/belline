"use client";

import { useRouter } from "next/navigation";

/**
 * Day or week, whose diary, and which date — as controls that change the
 * address, so any view can be bookmarked or sent to a colleague.
 */
export default function CalendarControls({
  locationId,
  date,
  mode,
  axis,
  staff,
  people,
}: {
  locationId: string;
  date: string;
  mode: "day" | "week";
  axis?: string;
  staff?: string;
  people: { id: string; name: string }[];
}) {
  const router = useRouter();
  const go = (next: { date?: string; mode?: string; staff?: string }) => {
    const params = new URLSearchParams({ loc: locationId, date: next.date ?? date });
    const m = next.mode ?? mode;
    if (m === "week") params.set("view", "week");
    if (axis === "rooms") params.set("axis", "rooms");
    const s = next.staff === undefined ? staff : next.staff;
    if (s) params.set("staff", s);
    router.push(`/calendar?${params.toString()}`);
  };

  return (
    <>
      <div className="seg" role="group" aria-label="View">
        <button type="button" className={mode === "day" ? "on" : undefined} aria-pressed={mode === "day"} onClick={() => go({ mode: "day" })}>Day</button>
        <button type="button" className={mode === "week" ? "on" : undefined} aria-pressed={mode === "week"} onClick={() => go({ mode: "week" })}>Week</button>
      </div>
      {people.length > 1 && (
        <select value={staff ?? ""} onChange={(e) => go({ staff: e.target.value })} aria-label="Whose diary" style={{ width: 150 }}>
          <option value="">Everyone</option>
          {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      )}
      <input type="date" value={date} aria-label="Go to date" style={{ width: 150 }} onChange={(e) => e.target.value && go({ date: e.target.value })} />
    </>
  );
}

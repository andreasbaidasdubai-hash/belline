"use client";

import { useRouter } from "next/navigation";

/** Jump to any day, instead of clicking an arrow thirty times. */
export default function DateJump({ locationId, date, axis }: { locationId: string; date: string; axis?: string }) {
  const router = useRouter();
  return (
    <input
      type="date"
      value={date}
      aria-label="Go to date"
      style={{ width: 150 }}
      onChange={(e) => {
        if (!e.target.value) return;
        router.push(`/calendar?loc=${locationId}&date=${e.target.value}${axis === "rooms" ? "&axis=rooms" : ""}`);
      }}
    />
  );
}

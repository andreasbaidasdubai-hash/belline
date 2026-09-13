"use client";

import { useState } from "react";

export default function RemindersForm({
  locationId,
  enabled,
  hours,
}: {
  locationId: string;
  enabled: boolean;
  hours: number;
}) {
  const [on, setOn] = useState(enabled);
  const [ahead, setAhead] = useState(hours);
  const [state, setState] = useState<"idle" | "saving" | "saved" | string>("idle");

  async function save() {
    setState("saving");
    try {
      const res = await fetch("/api/reminders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locationId, enabled: on, hoursBefore: ahead }),
      });
      const data = (await res.json()) as { error?: string };
      setState(res.ok ? "saved" : data.error ?? "That didn't save.");
    } catch {
      setState("That didn't save.");
    }
  }

  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginTop: 14, fontSize: 13 }}>
      <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />
        Send reminders
      </label>
      <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <select value={ahead} onChange={(e) => setAhead(Number(e.target.value))} disabled={!on}>
          {[2, 4, 12, 24, 48].map((h) => (
            <option key={h} value={h}>
              {h} hours
            </option>
          ))}
        </select>
        before the booking
      </label>
      <button className="btn btn-row" onClick={save} disabled={state === "saving"}>
        {state === "saving" ? "Saving…" : "Save"}
      </button>
      {state === "saved" && <span className="muted">Saved.</span>}
      {state !== "idle" && state !== "saving" && state !== "saved" && (
        <span style={{ color: "var(--bad)" }}>{state}</span>
      )}
    </div>
  );
}

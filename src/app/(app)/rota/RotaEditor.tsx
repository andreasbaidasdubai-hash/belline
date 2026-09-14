"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { RotaRow } from "@/lib/rota";
import { minutesToClock } from "@/lib/time";

/**
 * People down, days across. Click a day to change it: usual hours, a
 * different shift, a day off, or a stretch of time off. If the change leaves
 * bookings outside their hours, they are listed so somebody can move them.
 */

function toMinutes(clock: string): number {
  const [h, m] = clock.split(":").map(Number);
  return h * 60 + (m || 0);
}

export default function RotaEditor({ locationId, rows, today }: { locationId: string; rows: RotaRow[]; today: string }) {
  const router = useRouter();
  const [editing, setEditing] = useState<{ row: RotaRow; dayIndex: number } | null>(null);
  const [stranded, setStranded] = useState<{ name: string; list: { id: string; guestName: string; time: string; ref: string }[]; date: string } | null>(null);
  const dates = rows[0]?.days.map((d) => d.date) ?? [];

  return (
    <>
      {stranded && stranded.list.length > 0 && (
        <div className="panel" style={{ padding: "12px 16px", marginBottom: 12, borderColor: "var(--warn)" }} role="status">
          <strong style={{ fontSize: 13.5 }}>
            {stranded.list.length} booking{stranded.list.length === 1 ? "" : "s"} with {stranded.name} on {stranded.date} now fall outside their hours:
          </strong>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
            {stranded.list.map((b) => (
              <a key={b.id} className="chip" href={`/calendar?loc=${locationId}&date=${stranded.date}&open=${b.id}`}>
                {b.time} · {b.guestName} · {b.ref}
              </a>
            ))}
          </div>
          <button className="btn" style={{ marginTop: 10 }} onClick={() => setStranded(null)}>Dismiss</button>
        </div>
      )}

      <div className="panel table-wrap">
        <table className="rota">
          <thead>
            <tr>
              <th>Person</th>
              {dates.map((d) => (
                <th key={d} className={d === today ? "today" : undefined}>
                  {new Date(`${d}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <th scope="row">{row.name}</th>
                {row.days.map((day, i) => (
                  <td key={day.date}>
                    <button type="button" className={`rota-cell src-${day.source}`} onClick={() => setEditing({ row, dayIndex: i })}>
                      {day.working.length ? day.working.map((r) => `${minutesToClock(r.start)}–${minutesToClock(r.end)}`).join(", ") : "Off"}
                      <span className="rota-meta">
                        {day.source === "rota" ? "changed" : day.source === "usual" ? "usual" : ""}
                        {day.timeOff.length ? " · time off" : ""}
                        {day.bookings ? ` · ${day.bookings} booked` : ""}
                      </span>
                    </button>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted" style={{ fontSize: 11.5, marginTop: 10 }}>Click a day to change it. Changed days are marked; everything else follows the usual weekly hours.</p>

      {editing && (
        <DayEditor
          locationId={locationId}
          row={editing.row}
          dayIndex={editing.dayIndex}
          onClose={() => setEditing(null)}
          onSaved={(list) => {
            const day = editing.row.days[editing.dayIndex];
            setEditing(null);
            setStranded({ name: editing.row.name, list, date: day.date });
            router.refresh();
          }}
        />
      )}
    </>
  );
}

function DayEditor({
  locationId,
  row,
  dayIndex,
  onClose,
  onSaved,
}: {
  locationId: string;
  row: RotaRow;
  dayIndex: number;
  onClose: () => void;
  onSaved: (stranded: { id: string; guestName: string; time: string; ref: string }[]) => void;
}) {
  const day = row.days[dayIndex];
  const first = day.working[0];
  const [mode, setMode] = useState<"usual" | "shift" | "off">(day.source === "usual" ? "usual" : day.source === "off" && day.working.length === 0 ? "off" : "shift");
  const [start, setStart] = useState(minutesToClock(first?.start ?? 540));
  const [end, setEnd] = useState(minutesToClock(first?.end ?? 1080));
  const [offStart, setOffStart] = useState("13:00");
  const [offEnd, setOffEnd] = useState("14:00");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(change: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/rota", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ locationId, staffId: row.id, date: day.date, ...change }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string; stranded?: { id: string; guestName: string; time: string; ref: string }[] };
    setBusy(false);
    if (!res.ok) {
      setError(body.error ?? "Could not save.");
      return false;
    }
    onSaved(body.stranded ?? []);
    return true;
  }

  const label = new Date(`${day.date}T12:00:00`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });

  return (
    <div className="drawer-scrim" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={`${row.name}, ${label}`} onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div>
            <strong>{row.name}</strong>
            <div className="muted" style={{ fontSize: 12 }}>{label}</div>
          </div>
          <button className="btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="drawer-body">
          <div className="seg" role="group" aria-label="Hours">
            <button type="button" className={mode === "usual" ? "on" : undefined} onClick={() => setMode("usual")}>Usual</button>
            <button type="button" className={mode === "shift" ? "on" : undefined} onClick={() => setMode("shift")}>Different hours</button>
            <button type="button" className={mode === "off" ? "on" : undefined} onClick={() => setMode("off")}>Day off</button>
          </div>
          {mode === "shift" && (
            <div className="drawer-row">
              <label>Starts<input type="time" step={900} value={start} onChange={(e) => setStart(e.target.value)} /></label>
              <label>Finishes<input type="time" step={900} value={end} onChange={(e) => setEnd(e.target.value)} /></label>
            </div>
          )}
          <button
            className="btn btn-accent"
            disabled={busy}
            onClick={() =>
              void send(mode === "usual" ? { kind: "usual" } : mode === "off" ? { kind: "shift", ranges: [] } : { kind: "shift", ranges: [{ start: toMinutes(start), end: toMinutes(end) }] })
            }
          >
            {busy ? "Saving…" : "Save"}
          </button>

          <fieldset className="drawer-fieldset">
            <legend>Time off this day</legend>
            {day.timeOff.map((t) => (
              <div key={`${t.start}-${t.end}`} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13, marginBottom: 6 }}>
                {minutesToClock(t.start)}–{minutesToClock(t.end)}
                <button className="btn" disabled={busy} onClick={() => void send({ kind: "remove_time_off", start: t.start, end: t.end })}>Remove</button>
              </div>
            ))}
            <div className="drawer-row">
              <label>From<input type="time" step={900} value={offStart} onChange={(e) => setOffStart(e.target.value)} /></label>
              <label>To<input type="time" step={900} value={offEnd} onChange={(e) => setOffEnd(e.target.value)} /></label>
            </div>
            <button className="btn" style={{ marginTop: 8 }} disabled={busy} onClick={() => void send({ kind: "time_off", start: toMinutes(offStart), end: toMinutes(offEnd) })}>
              Add time off
            </button>
          </fieldset>
          {error && <p role="alert" style={{ color: "var(--bad)", fontSize: 13, margin: 0 }}>{error}</p>}
        </div>
      </aside>
    </div>
  );
}

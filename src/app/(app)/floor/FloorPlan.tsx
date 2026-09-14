"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { FloorTable } from "@/lib/floor";
import { minutesToClock } from "@/lib/time";
import BookingForm from "../calendar/BookingForm";

/**
 * The floor, live and arrangeable.
 *
 * Status mode: every table coloured by what is happening at it; click one for
 * who is there or due, and seat, mark arrived or clear it in one tap.
 * Arrange mode: drag tables to where they really are and save — the room's
 * shape is set once and then just used.
 */

const STATUS_TEXT: Record<FloorTable["status"], string> = {
  free: "Free",
  soon: "Booked soon",
  due: "Due now",
  late: "Running late",
  arrived: "Arrived",
  seated: "Seated",
  blocked: "Blocked",
};
const PLAN_WIDTH = 1000;
const SNAP = 10;

export default function FloorPlan({
  locationId,
  date,
  nowMin,
  tables: initial,
  canArrange,
  currency,
  overbookAllowed,
}: {
  locationId: string;
  date: string;
  nowMin: number;
  tables: FloorTable[];
  canArrange: boolean;
  currency: string;
  overbookAllowed: boolean;
}) {
  const router = useRouter();
  const [tables, setTables] = useState(initial);
  const [arranging, setArranging] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [walkIn, setWalkIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);
  const plan = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);

  const height = Math.max(420, ...tables.map((t) => t.y + 130));
  const table = tables.find((t) => t.id === selected);
  const counts = tables.reduce<Record<string, number>>((n, t) => ({ ...n, [t.status]: (n[t.status] ?? 0) + 1 }), {});

  function say(text: string, bad = false) {
    setMessage({ text, bad });
    setTimeout(() => setMessage(null), bad ? 6000 : 3500);
  }

  function scale() {
    const box = plan.current?.getBoundingClientRect();
    return box ? box.width / PLAN_WIDTH : 1;
  }

  function onPointerDown(e: React.PointerEvent, t: FloorTable) {
    if (!arranging) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const box = plan.current!.getBoundingClientRect();
    const s = scale();
    drag.current = { id: t.id, dx: (e.clientX - box.left) / s - t.x, dy: (e.clientY - box.top) / s - t.y };
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d || !plan.current) return;
    const box = plan.current.getBoundingClientRect();
    const s = scale();
    const x = Math.round(((e.clientX - box.left) / s - d.dx) / SNAP) * SNAP;
    const y = Math.round(((e.clientY - box.top) / s - d.dy) / SNAP) * SNAP;
    setTables((all) => all.map((t) => (t.id === d.id ? { ...t, x: Math.max(40, Math.min(PLAN_WIDTH - 40, x)), y: Math.max(40, y) } : t)));
  }

  async function saveLayout() {
    setBusy(true);
    const res = await fetch("/api/floor/layout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ locationId, positions: tables.map((t) => ({ id: t.id, x: t.x, y: t.y, shape: t.shape })) }),
    });
    setBusy(false);
    if (!res.ok) {
      say("The layout could not be saved.", true);
      return;
    }
    setArranging(false);
    say("Floor plan saved.");
    router.refresh();
  }

  async function progress(bookingId: string, event: "arrived" | "seated" | "left" | "no_show", done: string) {
    setBusy(true);
    const res = await fetch("/api/bookings/progress", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ locationId, bookingId, event }),
    });
    setBusy(false);
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) return say(body.error ?? "That did not work.", true);
    say(done);
    setSelected(null);
    router.refresh();
  }

  return (
    <div>
      <div className="floor-bar">
        <div className="floor-legend">
          {(["free", "soon", "due", "late", "arrived", "seated", "blocked"] as const).map((s) => (
            <span key={s}><i className={`floor-dot st-${s}`} />{STATUS_TEXT[s]}{counts[s] ? ` · ${counts[s]}` : ""}</span>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {!arranging && <button className="btn btn-accent" onClick={() => setWalkIn(true)}>+ Walk-in</button>}
          {canArrange && !arranging && <button className="btn" onClick={() => { setArranging(true); setSelected(null); }}>Arrange tables</button>}
          {arranging && (
            <>
              <button className="btn btn-accent" disabled={busy} onClick={() => void saveLayout()}>{busy ? "Saving…" : "Save layout"}</button>
              <button className="btn" disabled={busy} onClick={() => { setTables(initial); setArranging(false); }}>Cancel</button>
            </>
          )}
        </div>
      </div>

      {message && <div className={`cal-toast${message.bad ? " bad" : ""}`} role="status">{message.text}</div>}
      {arranging && <p className="muted" style={{ fontSize: 12.5, margin: "0 0 8px" }}>Drag each table to where it really is, then save.</p>}

      <div className="floor-scroll">
        <div
          ref={plan}
          className={`floor-plan${arranging ? " arranging" : ""}`}
          style={{ aspectRatio: `${PLAN_WIDTH} / ${height}` }}
          onPointerMove={onPointerMove}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
        >
          {tables.map((t) => (
            <button
              type="button"
              key={t.id}
              className={`floor-table ${t.shape} st-${t.status}${selected === t.id ? " on" : ""}`}
              style={{ left: `${(t.x / PLAN_WIDTH) * 100}%`, top: `${(t.y / height) * 100}%` }}
              onPointerDown={(e) => onPointerDown(e, t)}
              onClick={() => !arranging && setSelected(t.id)}
              aria-label={`${t.name}, ${t.maxSeats} seats, ${t.label}`}
            >
              <strong>{t.name}</strong>
              <span>{t.minSeats === t.maxSeats ? t.maxSeats : `${t.minSeats}–${t.maxSeats}`} seats</span>
              {t.current && <span className="floor-guest">{t.current.guestName.split(" ")[0]}</span>}
            </button>
          ))}
        </div>
      </div>

      {table && !arranging && (
        <div className="drawer-scrim" onClick={() => setSelected(null)}>
          <aside className="drawer" role="dialog" aria-modal="true" aria-label={table.name} onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head">
              <div>
                <strong>{table.name}</strong>
                <div className="muted" style={{ fontSize: 12 }}>{table.section || "Room"} · {table.minSeats}–{table.maxSeats} seats · {table.label}</div>
              </div>
              <button className="btn" onClick={() => setSelected(null)} aria-label="Close">✕</button>
            </div>
            <div className="drawer-body">
              {table.current ? (
                <div className="panel" style={{ padding: "12px 14px" }}>
                  <div style={{ fontWeight: 600 }}>{table.current.guestName} · {table.current.partySize} covers</div>
                  <div className="muted" style={{ fontSize: 12.5 }}>{minutesToClock(table.current.startMin)}–{minutesToClock(table.current.endMin)} · <span className="mono">{table.current.ref}</span></div>
                  {table.current.notes && <div style={{ fontSize: 12.5, color: "var(--warn)", marginTop: 4 }}>{table.current.notes}</div>}
                  <div className="drawer-actions" style={{ marginTop: 10 }}>
                    {!table.current.arrived && !table.current.seated && (
                      <button className="btn" disabled={busy} onClick={() => void progress(table.current!.id, "arrived", `${table.current!.guestName} has arrived.`)}>Arrived</button>
                    )}
                    {!table.current.seated && (
                      <button className="btn btn-accent" disabled={busy} onClick={() => void progress(table.current!.id, "seated", `${table.current!.guestName} seated.`)}>Seat</button>
                    )}
                    {table.current.seated && (
                      <button className="btn btn-accent" disabled={busy} onClick={() => void progress(table.current!.id, "left", `${table.name} is free again.`)}>Left — clear table</button>
                    )}
                    {!table.current.arrived && !table.current.seated && table.status === "late" && (
                      <button className="btn btn-danger" disabled={busy} onClick={() => void progress(table.current!.id, "no_show", `${table.current!.guestName} marked as a no-show.`)}>No-show</button>
                    )}
                    <a className="btn" href={`/calendar?loc=${locationId}&date=${date}&open=${table.current.id}`}>Open booking</a>
                  </div>
                </div>
              ) : (
                <p style={{ margin: 0, fontSize: 13.5 }}>{table.blockReason ? `Blocked: ${table.blockReason}` : "Nobody at this table right now."}</p>
              )}
              {table.next && (
                <div style={{ fontSize: 13 }}>
                  <div className="muted" style={{ fontSize: 12 }}>Next</div>
                  {minutesToClock(table.next.startMin)} · {table.next.guestName} · {table.next.partySize} covers
                </div>
              )}
            </div>
          </aside>
        </div>
      )}

      {walkIn && (
        <BookingForm
          locationId={locationId}
          isRestaurant
          currency={currency}
          date={date}
          startMin={Math.ceil(nowMin / 15) * 15}
          columns={[]}
          services={[]}
          overbookAllowed={overbookAllowed}
          onClose={() => setWalkIn(false)}
          onDone={(text) => {
            setWalkIn(false);
            say(text);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

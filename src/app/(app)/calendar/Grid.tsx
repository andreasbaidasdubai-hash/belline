"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { DayView } from "@/lib/calendar";
import { minutesToClock } from "@/lib/time";
import QuickBook from "./QuickBook";

/**
 * The day, drawn and worked in.
 *
 * Time down the side, the thing being booked along the top — tables for a
 * restaurant, people for a diary. Everything is positioned by real minutes
 * rather than by row, so a 20-minute appointment is visibly a third of an
 * hour and a gap is visibly a gap.
 *
 * Two interactions, because they are what a receptionist does all day:
 * drag a block to move it, click a gap to fill it. Both go through the same
 * booking engine the phone line uses, so the calendar cannot put a guest
 * anywhere a caller could not be put. A refused drop springs back and says
 * why, which is the only honest way to show a constraint.
 */

const SCALE = 1.15;
/** Bookings land on quarter hours. Finer is false precision on a phone line. */
const SNAP = 15;

function top(minutes: number, openMin: number): number {
  return (minutes - openMin) * SCALE;
}

function minutesAt(offsetPx: number, openMin: number): number {
  return Math.round((openMin + offsetPx / SCALE) / SNAP) * SNAP;
}

interface Dragging {
  bookingId: string;
  /** Where in the block the pointer grabbed it, so it does not jump. */
  grabOffsetPx: number;
  startMin: number;
  columnId: string;
  durationMin: number;
}

export default function Grid({
  view,
  locationId,
  isRestaurant,
  services,
}: {
  view: DayView;
  locationId: string;
  isRestaurant: boolean;
  services: { id: string; name: string; durationMin: number }[];
}) {
  const router = useRouter();
  const [drag, setDrag] = useState<Dragging | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);
  const [booking, setBooking] = useState<{ startMin: number; columnId: string } | null>(null);
  const lanes = useRef<Map<string, HTMLDivElement>>(new Map());

  const height = (view.closeMin - view.openMin) * SCALE;
  const hours: number[] = [];
  for (let m = Math.ceil(view.openMin / 60) * 60; m < view.closeMin; m += 60) hours.push(m);

  const say = useCallback((text: string, bad = false) => {
    setMessage({ text, bad });
    setTimeout(() => setMessage(null), bad ? 6000 : 3500);
  }, []);

  /** Which lane the pointer is over, and at what minute. */
  function dropTarget(event: React.PointerEvent | PointerEvent) {
    for (const [columnId, lane] of lanes.current) {
      const box = lane.getBoundingClientRect();
      if (event.clientX >= box.left && event.clientX <= box.right) {
        return { columnId, offsetPx: event.clientY - box.top };
      }
    }
    return null;
  }

  async function commitMove(bookingId: string, startMin: number, columnId: string) {
    setBusy(true);
    try {
      const res = await fetch("/api/bookings/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookingId, startMin, columnId }),
      });
      const data = await res.json();
      if (!res.ok) {
        const alts = (data.alternatives as number[] | undefined)
          ?.map((m) => minutesToClock(m))
          .join(", ");
        say(alts ? `${data.error} Free: ${alts}.` : data.error, true);
        return;
      }
      say(data.note ?? `Moved to ${minutesToClock(data.booking.startMin)}.`);
      router.refresh();
    } catch (err) {
      say(err instanceof Error ? err.message : String(err), true);
    } finally {
      setBusy(false);
    }
  }

  function onPointerDown(
    event: React.PointerEvent<HTMLDivElement>,
    bookingId: string,
    startMin: number,
    columnId: string,
    durationMin: number,
  ) {
    if (busy) return;
    // Left button only, and never on a touch scroll.
    if (event.button !== 0) return;
    event.preventDefault();
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);

    const block = (event.currentTarget as HTMLElement).getBoundingClientRect();
    setDrag({
      bookingId,
      grabOffsetPx: event.clientY - block.top,
      startMin,
      columnId,
      durationMin,
    });
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!drag) return;
    const target = dropTarget(event);
    if (!target) return;
    const startMin = minutesAt(target.offsetPx - drag.grabOffsetPx, view.openMin);
    setDrag({
      ...drag,
      startMin: Math.max(view.openMin, Math.min(view.closeMin - drag.durationMin, startMin)),
      columnId: target.columnId,
    });
  }

  function onPointerUp() {
    if (!drag) return;
    const moved = view.blocks.find((b) => b.booking.id === drag.bookingId);
    const changed =
      !moved || moved.startMin !== drag.startMin || moved.columnId !== drag.columnId;
    const { bookingId, startMin, columnId } = drag;
    setDrag(null);
    if (changed) void commitMove(bookingId, startMin, columnId);
  }

  return (
    <div onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => setDrag(null)}>
      {message && (
        <div className={`cal-toast${message.bad ? " bad" : ""}`} role="status">
          {message.text}
        </div>
      )}

      <div className="cal-scroll">
        <div
          className="cal-inner"
          style={{ gridTemplateColumns: `56px repeat(${view.columns.length}, minmax(108px, 1fr))` }}
        >
          <div className="cal-corner" />
          {view.columns.map((column) => (
            <div key={column.id} className="cal-head">
              <div className="cal-head-name">{column.name}</div>
              <div className="cal-head-sub">
                {column.capacity ? `${column.capacity} seats` : column.group ?? ""}
              </div>
            </div>
          ))}

          <div className="cal-gutter" style={{ height }}>
            {hours.map((m) => (
              <div key={m} className="cal-hour" style={{ top: top(m, view.openMin) }}>
                {minutesToClock(m)}
              </div>
            ))}
          </div>

          {view.columns.map((column) => (
            <div
              key={column.id}
              className="cal-lane"
              style={{ height }}
              ref={(node) => {
                if (node) lanes.current.set(column.id, node);
                else lanes.current.delete(column.id);
              }}
              onClick={(event) => {
                if (drag || busy) return;
                // Only an empty part of the lane — a click on a block is a
                // click on the block.
                if (event.target !== event.currentTarget) return;
                const box = event.currentTarget.getBoundingClientRect();
                setBooking({
                  startMin: minutesAt(event.clientY - box.top, view.openMin),
                  columnId: column.id,
                });
              }}
            >
              {hours.map((m) => (
                <div key={m} className="cal-rule" style={{ top: top(m, view.openMin) }} />
              ))}

              {view.blocks
                .filter((block) => block.columnId === column.id)
                .map((block) => {
                  const held = drag?.bookingId === block.booking.id;
                  // While dragging, the block follows the pointer in whichever
                  // lane it is over — so it is drawn here only if this is that
                  // lane, and at the dragged position rather than the stored one.
                  if (held && drag.columnId !== column.id) return null;

                  const startMin = held ? drag.startMin : block.startMin;
                  const guestHeight = Math.max(20, (block.endMin - block.startMin) * SCALE);
                  const bufferHeight = Math.max(0, (block.bufferEndMin - block.endMin) * SCALE);

                  return (
                    <div
                      key={`${block.booking.id}-${column.id}`}
                      className={`cal-block${held ? " held" : ""}`}
                      style={{
                        top: top(startMin, view.openMin),
                        height: guestHeight + bufferHeight,
                      }}
                      title={`${block.title} · ${block.detail} · ${minutesToClock(block.startMin)}–${minutesToClock(block.endMin)} · drag to move`}
                      onPointerDown={(event) =>
                        onPointerDown(
                          event,
                          block.booking.id,
                          block.startMin,
                          column.id,
                          block.bufferEndMin - block.startMin,
                        )
                      }
                    >
                      <span className="cal-block-body" style={{ height: guestHeight }}>
                        <span className="cal-block-time">{minutesToClock(startMin)}</span>
                        <span className="cal-block-name">{block.title}</span>
                        <span className="cal-block-detail">{block.detail}</span>
                      </span>
                      {bufferHeight > 0 && (
                        <span
                          className="cal-block-buffer"
                          style={{ height: bufferHeight }}
                          aria-label="Turnaround held in the diary"
                        />
                      )}
                    </div>
                  );
                })}

              {view.nowMin !== null &&
                view.nowMin >= view.openMin &&
                view.nowMin <= view.closeMin && (
                  <div className="cal-now" style={{ top: top(view.nowMin, view.openMin) }} />
                )}
            </div>
          ))}
        </div>
      </div>

      <p className="muted" style={{ fontSize: 11.5, marginTop: 10 }}>
        Drag a booking to move it. Click an empty slot to take one.
        {isRestaurant && " The table is chosen by the engine — dragging sideways moves the time only."}
      </p>

      {booking && (
        <QuickBook
          locationId={locationId}
          date={view.date}
          startMin={booking.startMin}
          columnId={booking.columnId}
          columnName={view.columns.find((c) => c.id === booking.columnId)?.name ?? ""}
          isRestaurant={isRestaurant}
          services={services}
          onClose={() => setBooking(null)}
          onDone={(text) => {
            setBooking(null);
            say(text);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

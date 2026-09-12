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

/**
 * Where two bookings share a column, give each its own strip of it.
 *
 * The case that forced this is dovetailing: a client booked into the forty
 * minutes while somebody else's colour develops is genuinely two appointments
 * in one stylist's column at the same time, and drawn full-width the second
 * one simply covers the first. Any diary that allows overlap at all has to
 * solve this, and the solution is always the same — cluster whatever overlaps,
 * pack each cluster into as few lanes as it needs, and split the width.
 *
 * Non-overlapping days are untouched: one lane, full width, exactly as before.
 */
function laneOut(
  blocks: { startMin: number; bufferEndMin: number }[],
): Map<number, { lane: number; lanes: number }> {
  const order = blocks
    .map((block, index) => ({ index, start: block.startMin, end: block.bufferEndMin }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const out = new Map<number, { lane: number; lanes: number }>();
  let cluster: typeof order = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    if (cluster.length === 0) return;
    const laneEnds: number[] = [];
    const assigned: number[] = [];
    for (const item of cluster) {
      let lane = laneEnds.findIndex((end) => end <= item.start);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(item.end);
      } else {
        laneEnds[lane] = item.end;
      }
      assigned.push(lane);
    }
    cluster.forEach((item, i) => {
      out.set(item.index, { lane: assigned[i], lanes: laneEnds.length });
    });
    cluster = [];
    clusterEnd = -Infinity;
  };

  for (const item of order) {
    if (item.start >= clusterEnd) flush();
    cluster.push(item);
    clusterEnd = Math.max(clusterEnd, item.end);
  }
  flush();
  return out;
}

/** The holes between the stretches somebody is actually occupied. */
function processingGaps(busy: { start: number; end: number }[] | undefined) {
  if (!busy || busy.length < 2) return [];
  const out: { start: number; end: number }[] = [];
  for (let i = 1; i < busy.length; i++) {
    if (busy[i].start > busy[i - 1].end) {
      out.push({ start: busy[i - 1].end, end: busy[i].start });
    }
  }
  return out;
}

/** The parts of the drawn day this column is not working. */
function offShift(shift: { start: number; end: number }[], openMin: number, closeMin: number) {
  if (shift.length === 0) return [{ start: openMin, end: closeMin }];
  const sorted = shift.slice().sort((a, b) => a.start - b.start);
  const out: { start: number; end: number }[] = [];
  let cursor = openMin;
  for (const range of sorted) {
    if (range.start > cursor) out.push({ start: cursor, end: Math.min(range.start, closeMin) });
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < closeMin) out.push({ start: cursor, end: closeMin });
  return out.filter((r) => r.end > r.start);
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
  overbookAllowed,
  services,
  /**
   * Whether the grid can be worked in as well as read.
   *
   * Off for the room axis. A column there is a surgery, not a person, and
   * neither "move this patient into surgery two" nor "book somebody into the
   * treatment room" is a request the engine takes — rooms are assigned, not
   * chosen. A grid that accepted the drag and then quietly reassigned the room
   * itself would be worse than one that does not offer it.
   */
  bookable = true,
}: {
  view: DayView;
  locationId: string;
  isRestaurant: boolean;
  overbookAllowed: boolean;
  services: { id: string; name: string; durationMin: number }[];
  bookable?: boolean;
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
    if (busy || !bookable) return;
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

      <div className="cal-scroll" tabIndex={0}>
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
              {column.availableMin > 0 && (
                <span
                  className="cal-head-util"
                  // role="img": aria-label on a plain span is ignored by
                  // assistive technology, so the utilisation existed only as a
                  // tooltip. With a role it is read out.
                  role="img"
                  title={`${Math.round(column.utilisation * 100)}% of ${Math.round(column.availableMin / 60)}h sold`}
                  aria-label={`${Math.round(column.utilisation * 100)} per cent sold`}
                >
                  <span style={{ width: `${Math.round(column.utilisation * 100)}%` }} />
                </span>
              )}
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
                if (drag || busy || !bookable) return;
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

              {/* Hours this column is not on. Drawn before anything else so a
                  booking that sits outside a shift is still visible on top of
                  it — which is exactly the case somebody needs to see. */}
              {offShift(column.shift, view.openMin, view.closeMin).map((band) => (
                <div
                  key={`off-${band.start}`}
                  className="cal-off"
                  style={{
                    top: top(band.start, view.openMin),
                    height: (band.end - band.start) * SCALE,
                  }}
                />
              ))}

              {view.offBlocks
                .filter((b) => b.columnId === column.id)
                .map((b) => (
                  <div
                    key={`blk-${b.startMin}-${b.reason}`}
                    className="cal-off"
                    style={{
                      top: top(b.startMin, view.openMin),
                      height: (b.endMin - b.startMin) * SCALE,
                    }}
                    title={b.reason}
                  >
                    <span className="cal-off-label">{b.reason}</span>
                  </div>
                ))}

              {(() => {
                const mine = view.blocks.filter((block) => block.columnId === column.id);
                const lanes = laneOut(mine);
                return mine.map((block, index) => {
                  const { lane, lanes: count } = lanes.get(index) ?? { lane: 0, lanes: 1 };
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
                        // A block being dragged goes full width so it can be
                        // seen; everything else shares the column with whatever
                        // it overlaps.
                        ...(count > 1 && !held
                          ? {
                              left: `calc(3px + ${(lane * 100) / count}%)`,
                              width: `calc(${100 / count}% - 6px)`,
                              right: "auto",
                            }
                          : {}),
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
                      {/* The stretches inside this appointment where the chair
                          is taken and the practitioner is not — colour
                          developing, anaesthetic taking. Drawn because it is
                          the most sellable time in the day. */}
                      {processingGaps(block.busy).map((gap) => (
                        <span
                          key={`gap-${gap.start}`}
                          className="cal-block-gap"
                          style={{
                            top: (gap.start - block.startMin) * SCALE,
                            height: (gap.end - gap.start) * SCALE,
                          }}
                          title={`${minutesToClock(gap.start)}–${minutesToClock(gap.end)} — processing, ${block.title} is here but ${column.name} is free`}
                        />
                      ))}
                      {(block.depositDue || block.arrived) && (
                        <span className="cal-flags">
                          {block.arrived && <span className="cal-flag" title="Arrived" />}
                          {block.depositDue && (
                            <span className="cal-flag deposit" title="Deposit not settled" />
                          )}
                        </span>
                      )}
                    </div>
                  );
                });
              })()}

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
        {bookable ? (
          <>
            Drag a booking to move it. Click an empty slot to take one.
            {isRestaurant &&
              " The table is chosen by the engine — dragging sideways moves the time only."}
          </>
        ) : (
          "Rooms are assigned by the engine, so this view reads only. Switch to People to move anything."
        )}
      </p>

      {booking && (
        <QuickBook
          locationId={locationId}
          date={view.date}
          startMin={booking.startMin}
          columnId={booking.columnId}
          columnName={view.columns.find((c) => c.id === booking.columnId)?.name ?? ""}
          isRestaurant={isRestaurant}
          overbookAllowed={overbookAllowed}
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

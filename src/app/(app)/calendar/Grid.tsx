import Link from "next/link";
import type { DayView } from "@/lib/calendar";
import { minutesToClock } from "@/lib/time";

/**
 * The day, drawn.
 *
 * Time down the side, the thing being booked along the top — tables for a
 * restaurant, people for a diary. Everything is positioned by real minutes
 * rather than by row, so a 20-minute appointment is visibly a third of an
 * hour and a gap is visibly a gap. That is the entire point of a calendar
 * over a list: you see the shape of the day without reading it.
 */

/** Pixels per minute. Tight enough to fit a service, loose enough to read. */
const SCALE = 1.15;
const HOUR = 60 * SCALE;

function top(minutes: number, openMin: number): number {
  return (minutes - openMin) * SCALE;
}

export default function Grid({ view }: { view: DayView }) {
  const height = (view.closeMin - view.openMin) * SCALE;

  const hours: number[] = [];
  for (let m = Math.ceil(view.openMin / 60) * 60; m < view.closeMin; m += 60) hours.push(m);

  // Tables carry a section; people do not. Only draw the band when it means
  // something, or it becomes a row of empty headers.
  const groups = [...new Set(view.columns.map((c) => c.group).filter(Boolean))] as string[];

  return (
    <div className="cal">
      <div className="cal-scroll">
        <div className="cal-inner" style={{ gridTemplateColumns: `56px repeat(${view.columns.length}, minmax(108px, 1fr))` }}>
          {/* Header */}
          <div className="cal-corner" />
          {view.columns.map((column) => (
            <div key={column.id} className="cal-head">
              <div className="cal-head-name">{column.name}</div>
              <div className="cal-head-sub">
                {column.capacity ? `${column.capacity} seats` : column.group ?? ""}
              </div>
            </div>
          ))}

          {/* Time gutter */}
          <div className="cal-gutter" style={{ height }}>
            {hours.map((m) => (
              <div key={m} className="cal-hour" style={{ top: top(m, view.openMin) }}>
                {minutesToClock(m)}
              </div>
            ))}
          </div>

          {/* One lane per column */}
          {view.columns.map((column) => (
            <div key={column.id} className="cal-lane" style={{ height }}>
              {hours.map((m) => (
                <div key={m} className="cal-rule" style={{ top: top(m, view.openMin) }} />
              ))}

              {view.blocks
                .filter((block) => block.columnId === column.id)
                .map((block) => {
                  const guestTop = top(block.startMin, view.openMin);
                  const guestHeight = Math.max(20, (block.endMin - block.startMin) * SCALE);
                  const bufferHeight = Math.max(0, (block.bufferEndMin - block.endMin) * SCALE);
                  return (
                    <Link
                      key={`${block.booking.id}-${column.id}`}
                      href={`/bookings?ref=${block.booking.ref}`}
                      className="cal-block"
                      style={{ top: guestTop, height: guestHeight + bufferHeight }}
                      title={`${block.title} · ${block.detail} · ${minutesToClock(block.startMin)}–${minutesToClock(block.endMin)}`}
                    >
                      <span className="cal-block-body" style={{ height: guestHeight }}>
                        <span className="cal-block-time">{minutesToClock(block.startMin)}</span>
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
                    </Link>
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

      {groups.length > 1 && (
        <p className="muted" style={{ fontSize: 11.5, marginTop: 10 }}>
          Sections: {groups.join(" · ")}
        </p>
      )}
    </div>
  );
}

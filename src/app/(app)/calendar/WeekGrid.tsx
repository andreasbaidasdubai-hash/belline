"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Booking } from "@/lib/types";
import { minutesToClock } from "@/lib/time";
import BookingForm, { type ServiceOption } from "./BookingForm";
import BookingDrawer from "./BookingDrawer";

/**
 * The week, as a grid: seven days across, the hours down.
 *
 * Every booking of the week at its real time and length, coloured by the
 * person it is with, so a thin Tuesday and a packed Thursday are visible at a
 * glance. Click a booking to open it, click empty time to book it, click a
 * day's name to see it in full.
 */

export interface WeekBlock {
  booking: Booking;
  columnId: string;
  startMin: number;
  endMin: number;
  title: string;
  detail: string;
  arrived?: boolean;
}

export interface WeekDayData {
  date: string;
  closed: boolean;
  openMin: number;
  closeMin: number;
  blocks: WeekBlock[];
}

const SCALE = 0.9;
const TONES = 6;

function lanes(blocks: WeekBlock[]): Map<string, { lane: number; count: number }> {
  const sorted = [...blocks].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  const out = new Map<string, { lane: number; count: number }>();
  let cluster: WeekBlock[] = [];
  let end = -1;
  const flush = () => {
    const ends: number[] = [];
    const assigned = cluster.map((b) => {
      let lane = ends.findIndex((e) => e <= b.startMin);
      if (lane < 0) {
        lane = ends.length;
        ends.push(b.endMin);
      } else ends[lane] = b.endMin;
      return lane;
    });
    cluster.forEach((b, i) => out.set(b.booking.id, { lane: assigned[i], count: ends.length }));
    cluster = [];
    end = -1;
  };
  for (const b of sorted) {
    if (b.startMin >= end && cluster.length) flush();
    cluster.push(b);
    end = Math.max(end, b.endMin);
  }
  if (cluster.length) flush();
  return out;
}

export default function WeekGrid({
  days,
  locationId,
  isRestaurant,
  currency,
  columns,
  services,
  overbookAllowed,
  dayHref,
}: {
  days: WeekDayData[];
  locationId: string;
  isRestaurant: boolean;
  currency: string;
  columns: { id: string; name: string }[];
  services: ServiceOption[];
  overbookAllowed: boolean;
  dayHref: Record<string, string>;
}) {
  const router = useRouter();
  const [opened, setOpened] = useState<WeekBlock | null>(null);
  const [newAt, setNewAt] = useState<{ date: string; startMin: number } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const open = Math.min(...days.map((d) => d.openMin));
  const close = Math.max(...days.map((d) => d.closeMin));
  const height = (close - open) * SCALE;
  const hours: number[] = [];
  for (let m = Math.ceil(open / 60) * 60; m < close; m += 60) hours.push(m);
  const tone = (columnId: string) => Math.max(0, columns.findIndex((c) => c.id === columnId)) % TONES;
  const done = (text: string) => {
    setOpened(null);
    setNewAt(null);
    setMessage(text);
    setTimeout(() => setMessage(null), 4000);
    router.refresh();
  };

  return (
    <div>
      {message && <div className="cal-toast" role="status">{message}</div>}
      {!isRestaurant && columns.length > 1 && (
        <div className="week-legend">
          {columns.map((c) => (
            <span key={c.id}><i className={`tone-${tone(c.id)}`} />{c.name}</span>
          ))}
        </div>
      )}
      <div className="cal-scroll" tabIndex={0}>
        <div className="week-inner" style={{ gridTemplateColumns: `56px repeat(${days.length}, minmax(120px, 1fr))` }}>
          <div className="cal-corner" />
          {days.map((d) => (
            <a key={d.date} href={dayHref[d.date]} className={`week-head${d.closed ? " closed" : ""}`}>
              <span>{new Date(`${d.date}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short" })}</span>
              <strong>{Number(d.date.slice(8))}</strong>
              <span className="muted">{d.closed ? "closed" : `${d.blocks.length}`}</span>
            </a>
          ))}

          <div className="cal-gutter" style={{ height }}>
            {hours.map((m) => (
              <div key={m} className="cal-hour" style={{ top: (m - open) * SCALE }}>{minutesToClock(m)}</div>
            ))}
          </div>

          {days.map((d) => {
            const laneOf = lanes(d.blocks);
            return (
              <div
                key={d.date}
                className={`cal-lane week-lane${d.closed ? " closed" : ""}`}
                style={{ height }}
                onClick={(e) => {
                  if (e.target !== e.currentTarget) return;
                  const box = e.currentTarget.getBoundingClientRect();
                  const minute = Math.round((open + (e.clientY - box.top) / SCALE) / 15) * 15;
                  setNewAt({ date: d.date, startMin: minute });
                }}
              >
                {hours.map((m) => <div key={m} className="cal-rule" style={{ top: (m - open) * SCALE }} />)}
                {d.blocks.map((b) => {
                  const { lane, count } = laneOf.get(b.booking.id) ?? { lane: 0, count: 1 };
                  return (
                    <button
                      type="button"
                      key={b.booking.id}
                      className={`week-block tone-${tone(b.columnId)}${b.arrived ? " arrived" : ""}`}
                      style={{
                        top: (b.startMin - open) * SCALE,
                        height: Math.max(18, (b.endMin - b.startMin) * SCALE),
                        left: `calc(2px + ${(lane * 100) / count}%)`,
                        width: `calc(${100 / count}% - 4px)`,
                      }}
                      onClick={() => setOpened(b)}
                      title={`${minutesToClock(b.startMin)} ${b.title} · ${b.detail}`}
                    >
                      <span className="week-block-time">{minutesToClock(b.startMin)}</span>
                      <span className="week-block-name">{b.title}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      <p className="muted" style={{ fontSize: 11.5, marginTop: 10 }}>
        Click a booking to open it, empty time to book it, or a day to see it in full.
      </p>

      {opened && (
        <BookingDrawer
          booking={opened.booking}
          locationId={locationId}
          isRestaurant={isRestaurant}
          currency={currency}
          columns={columns}
          services={services}
          onClose={() => setOpened(null)}
          onDone={done}
        />
      )}
      {newAt && (
        <BookingForm
          locationId={locationId}
          isRestaurant={isRestaurant}
          currency={currency}
          date={newAt.date}
          startMin={newAt.startMin}
          columns={columns}
          services={services}
          overbookAllowed={overbookAllowed}
          onClose={() => setNewAt(null)}
          onDone={done}
        />
      )}
    </div>
  );
}

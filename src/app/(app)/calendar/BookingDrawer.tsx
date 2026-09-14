"use client";

import { useEffect, useState } from "react";
import type { Booking } from "@/lib/types";
import { minutesToClock } from "@/lib/time";
import type { ServiceOption } from "./BookingForm";

/**
 * One booking, opened from the calendar.
 *
 * Everything a receptionist does to a booking without leaving the day: see who
 * it is and what they booked, mark them arrived or a no-show, change the time,
 * the person, the services or the guest's details, or cancel it — with the
 * cancel confirmed inside the panel rather than by a browser pop-up.
 */

function toMinutes(clock: string): number {
  const [h, m] = clock.split(":").map(Number);
  return h * 60 + (m || 0);
}

const SOURCE: Record<string, string> = {
  phone: "Booked by Belline on the phone",
  embed: "Booked by Belline on your website",
  webchat: "Booked by Belline in website chat",
  whatsapp: "Booked by Belline on WhatsApp",
  manual: "Booked at the desk",
};

export default function BookingDrawer({
  booking,
  locationId,
  isRestaurant,
  currency,
  columns,
  services,
  onClose,
  onDone,
}: {
  booking: Booking;
  locationId: string;
  isRestaurant: boolean;
  currency: string;
  columns: { id: string; name: string }[];
  services: ServiceOption[];
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [mode, setMode] = useState<"view" | "edit" | "cancel">("view");
  const [date, setDate] = useState(booking.date);
  const [time, setTime] = useState(minutesToClock(booking.startMin));
  const [staffId, setStaffId] = useState(booking.staffId ?? "");
  const [serviceIds, setServiceIds] = useState<string[]>(booking.serviceIds ?? []);
  const [partySize, setPartySize] = useState(booking.partySize ?? 2);
  const [guestName, setGuestName] = useState(booking.guestName);
  const [guestPhone, setGuestPhone] = useState(booking.guestPhone);
  const [guestEmail, setGuestEmail] = useState(booking.guestEmail ?? "");
  const [notes, setNotes] = useState(booking.notes);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; alternatives: number[] } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const staffName = columns.find((c) => c.id === booking.staffId)?.name;
  const booked = services.filter((s) => (booking.serviceIds ?? []).includes(s.id));
  const price = booked.reduce((n, s) => n + s.price, 0);
  const arrived = Boolean(booking.service?.arrivedAt);

  async function call(url: string, method: string, body: Record<string, unknown>, done: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = (await res.json().catch(() => ({}))) as { error?: string; alternatives?: number[]; summary?: string };
      if (!res.ok) {
        setError({ text: data.error ?? "That did not work.", alternatives: data.alternatives ?? [] });
        return;
      }
      onDone(data.summary ? `${done}: ${data.summary}` : done);
    } catch (err) {
      setError({ text: err instanceof Error ? err.message : String(err), alternatives: [] });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="drawer-scrim" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={`Booking for ${booking.guestName}`} onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div>
            <strong>{booking.guestName}</strong>
            <div className="muted" style={{ fontSize: 12 }}>
              <span className="mono">{booking.ref}</span> · {booking.date} · {minutesToClock(booking.startMin)}–{minutesToClock(booking.endMin)}
            </div>
          </div>
          <button className="btn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {mode === "view" && (
          <div className="drawer-body">
            <dl className="facts">
              <dt>{isRestaurant ? "Covers" : "Services"}</dt>
              <dd>{isRestaurant ? booking.partySize : booked.map((s) => s.name).join(", ") || "—"}{price ? ` · ${currency} ${price.toLocaleString()}` : ""}</dd>
              {!isRestaurant && (<><dt>With</dt><dd>{staffName ?? "Anyone"}</dd></>)}
              <dt>Phone</dt>
              <dd>{booking.guestPhone ? <a href={`tel:${booking.guestPhone}`}>{booking.guestPhone}</a> : "—"}</dd>
              <dt>Email</dt>
              <dd>{booking.guestEmail ? <a href={`mailto:${booking.guestEmail}`}>{booking.guestEmail}</a> : "—"}</dd>
              {booking.notes && (<><dt>Notes</dt><dd>{booking.notes}</dd></>)}
              {booking.deposit && (<><dt>Deposit</dt><dd>{booking.deposit.currency} {booking.deposit.amount} · {booking.deposit.status}</dd></>)}
              <dt>Source</dt>
              <dd>{SOURCE[booking.source ?? ""] ?? "Booked"}</dd>
            </dl>

            <div className="drawer-actions">
              <button
                className="btn btn-accent"
                disabled={busy}
                onClick={() => void call("/api/bookings/progress", "POST", { locationId, bookingId: booking.id, event: arrived ? "reopen" : "arrived" }, arrived ? "Arrival undone" : `${booking.guestName} has arrived`)}
              >
                {arrived ? "Undo arrived" : "Arrived"}
              </button>
              <button className="btn" disabled={busy} onClick={() => void call("/api/bookings/progress", "POST", { locationId, bookingId: booking.id, event: "no_show" }, `${booking.guestName} marked as a no-show`)}>
                No-show
              </button>
              <button className="btn" disabled={busy} onClick={() => setMode("edit")}>Edit</button>
              <button className="btn btn-danger" disabled={busy} onClick={() => setMode("cancel")}>Cancel booking</button>
            </div>
            {booking.guestPhone && (
              <a className="muted" style={{ fontSize: 12.5 }} href={`/guests?loc=${locationId}`}>
                See {booking.guestName.split(" ")[0]}&apos;s history →
              </a>
            )}
            {error && <p role="alert" style={{ color: "var(--bad)", fontSize: 13, margin: 0 }}>{error.text}</p>}
          </div>
        )}

        {mode === "cancel" && (
          <div className="drawer-body">
            <p style={{ margin: 0, fontSize: 14 }}>
              Cancel {booking.guestName}&apos;s booking at {minutesToClock(booking.startMin)} on {booking.date}? The time becomes free straight away.
            </p>
            <label>Reason (optional)<input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Rang to cancel, feeling unwell…" /></label>
            {error && <p role="alert" style={{ color: "var(--bad)", fontSize: 13, margin: 0 }}>{error.text}</p>}
            <div className="drawer-actions">
              <button className="btn btn-danger" disabled={busy} onClick={() => void call("/api/bookings/cancel", "POST", { bookingId: booking.id, reason }, `${booking.guestName}'s booking cancelled`)}>
                {busy ? "Cancelling…" : "Yes, cancel it"}
              </button>
              <button className="btn" disabled={busy} onClick={() => setMode("view")}>Keep it</button>
            </div>
          </div>
        )}

        {mode === "edit" && (
          <form
            className="drawer-body"
            onSubmit={(e) => {
              e.preventDefault();
              void call(
                "/api/bookings/update",
                "PATCH",
                {
                  bookingId: booking.id,
                  date,
                  startMin: toMinutes(time),
                  staffId: isRestaurant ? undefined : staffId || null,
                  serviceIds: isRestaurant ? undefined : serviceIds,
                  partySize: isRestaurant ? partySize : undefined,
                  guestName,
                  guestPhone,
                  guestEmail,
                  notes,
                },
                "Saved",
              );
            }}
          >
            <label>Guest<input value={guestName} onChange={(e) => setGuestName(e.target.value)} required /></label>
            <div className="drawer-row">
              <label>Phone<input value={guestPhone} onChange={(e) => setGuestPhone(e.target.value)} inputMode="tel" /></label>
              <label>Email<input value={guestEmail} onChange={(e) => setGuestEmail(e.target.value)} inputMode="email" /></label>
            </div>
            <div className="drawer-row">
              <label>Date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></label>
              <label>Time<input type="time" step={900} value={time} onChange={(e) => setTime(e.target.value)} required /></label>
            </div>
            {isRestaurant ? (
              <label>Covers<input type="number" min={1} max={40} value={partySize} onChange={(e) => setPartySize(Number(e.target.value))} /></label>
            ) : (
              <>
                <label>
                  With
                  <select value={staffId} onChange={(e) => setStaffId(e.target.value)}>
                    <option value="">Anyone free</option>
                    {columns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </label>
                <fieldset className="drawer-fieldset">
                  <legend>Services</legend>
                  <div className="chips">
                    {services.map((s) => {
                      const on = serviceIds.includes(s.id);
                      return (
                        <button type="button" key={s.id} className={`chip${on ? " on" : ""}`} aria-pressed={on} onClick={() => setServiceIds(on ? serviceIds.filter((x) => x !== s.id) : [...serviceIds, s.id])}>
                          {s.name} <span className="muted">{s.durationMin}m</span>
                        </button>
                      );
                    })}
                  </div>
                </fieldset>
              </>
            )}
            <label>Notes<input value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
            {error && (
              <div role="alert" style={{ color: "var(--bad)", fontSize: 13 }}>
                {error.text}
                {error.alternatives.length > 0 && (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                    <span className="muted">Free:</span>
                    {error.alternatives.map((m) => (
                      <button type="button" key={m} className="chip" onClick={() => { setTime(minutesToClock(m)); setError(null); }}>{minutesToClock(m)}</button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="drawer-actions">
              <button className="btn btn-accent" disabled={busy}>{busy ? "Saving…" : "Save changes"}</button>
              <button type="button" className="btn" disabled={busy} onClick={() => setMode("view")}>Back</button>
            </div>
          </form>
        )}
      </aside>
    </div>
  );
}

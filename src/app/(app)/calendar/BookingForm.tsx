"use client";

import { useEffect, useRef, useState } from "react";
import { minutesToClock } from "@/lib/time";

/**
 * A booking, taken at the desk.
 *
 * Opened from an empty slot (time and person already chosen) or from "New
 * booking" (choose everything). Start typing a name or number and returning
 * guests come up with their details; pick several services and the length and
 * price add up as you go. If the time has gone, the free times nearby are
 * buttons, not a sentence.
 */

export interface ServiceOption {
  id: string;
  name: string;
  durationMin: number;
  price: number;
}

interface GuestHit {
  name: string;
  phone: string;
  email: string;
  visits: number;
  usual: string;
  notes: string[];
}

function toMinutes(clock: string): number {
  const [h, m] = clock.split(":").map(Number);
  return h * 60 + (m || 0);
}

export default function BookingForm({
  locationId,
  isRestaurant,
  currency,
  date: initialDate,
  startMin: initialStart,
  columnId,
  columns,
  services,
  overbookAllowed,
  onClose,
  onDone,
}: {
  locationId: string;
  isRestaurant: boolean;
  currency: string;
  date: string;
  startMin: number;
  columnId?: string;
  columns: { id: string; name: string }[];
  services: ServiceOption[];
  overbookAllowed: boolean;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [date, setDate] = useState(initialDate);
  const [time, setTime] = useState(minutesToClock(initialStart));
  const [staffId, setStaffId] = useState(isRestaurant ? "" : columnId ?? "");
  const [serviceIds, setServiceIds] = useState<string[]>(isRestaurant || !services[0] ? [] : [services[0].id]);
  const [partySize, setPartySize] = useState(2);
  const [guestName, setGuestName] = useState("");
  const [guestPhone, setGuestPhone] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [overbook, setOverbook] = useState(false);
  const [hits, setHits] = useState<GuestHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; alternatives: number[] } | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Returning guests, as the name or number is typed.
  useEffect(() => {
    const q = (guestName.length >= 2 ? guestName : guestPhone).trim();
    if (q.length < 2) {
      setHits([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/guests/search?loc=${encodeURIComponent(locationId)}&q=${encodeURIComponent(q)}`, { signal: controller.signal });
        const body = (await res.json()) as { guests?: GuestHit[] };
        setHits((body.guests ?? []).filter((g) => g.name !== guestName || g.phone !== guestPhone));
      } catch {
        /* typing on; a failed lookup is not an error worth showing */
      }
    }, 220);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [guestName, guestPhone, locationId]);

  const chosen = services.filter((s) => serviceIds.includes(s.id));
  const totalMin = chosen.reduce((n, s) => n + s.durationMin, 0);
  const totalPrice = chosen.reduce((n, s) => n + s.price, 0);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/bookings/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          locationId,
          date,
          startMin: toMinutes(time),
          staffId: staffId || null,
          serviceIds: isRestaurant ? undefined : serviceIds,
          partySize: isRestaurant ? partySize : undefined,
          guestName,
          guestPhone,
          guestEmail,
          notes,
          overbook,
        }),
      });
      const data = (await res.json()) as { error?: string; alternatives?: number[]; duplicate?: boolean; booking?: { summary: string; ref: string } };
      if (!res.ok || !data.booking) {
        setError({ text: data.error ?? "That did not book.", alternatives: data.alternatives ?? [] });
        return;
      }
      onDone(data.duplicate ? `${guestName} already had that booking — nothing was booked twice.` : `Booked: ${data.booking.summary} · ${data.booking.ref}`);
    } catch (err) {
      setError({ text: err instanceof Error ? err.message : String(err), alternatives: [] });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="drawer-scrim" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="New booking" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <strong>New booking</strong>
          <button className="btn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <form onSubmit={submit} className="drawer-body">
          <div style={{ position: "relative" }}>
            <label>
              Guest
              <input ref={nameRef} value={guestName} onChange={(e) => setGuestName(e.target.value)} placeholder="Name — returning guests appear as you type" disabled={busy} autoComplete="off" />
            </label>
            {hits.length > 0 && (
              <div className="suggest" role="listbox">
                {hits.map((g) => (
                  <button
                    type="button"
                    key={g.phone}
                    role="option"
                    aria-selected="false"
                    onClick={() => {
                      setGuestName(g.name);
                      setGuestPhone(g.phone);
                      if (g.email) setGuestEmail(g.email);
                      setHits([]);
                    }}
                  >
                    <strong>{g.name}</strong>
                    <span className="muted"> · {g.phone} · {g.visits} visit{g.visits === 1 ? "" : "s"}{g.usual ? ` · usually ${g.usual}` : ""}</span>
                    {g.notes.length > 0 && <span className="suggest-note">{g.notes.join(" · ")}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="drawer-row">
            <label>Phone<input value={guestPhone} onChange={(e) => setGuestPhone(e.target.value)} placeholder="+971 50 …" inputMode="tel" disabled={busy} /></label>
            <label>Email<input value={guestEmail} onChange={(e) => setGuestEmail(e.target.value)} placeholder="Optional" inputMode="email" disabled={busy} /></label>
          </div>

          <div className="drawer-row">
            <label>Date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} required disabled={busy} /></label>
            <label>Time<input type="time" step={900} value={time} onChange={(e) => setTime(e.target.value)} required disabled={busy} /></label>
          </div>

          {isRestaurant ? (
            <label>Covers<input type="number" min={1} max={40} value={partySize} onChange={(e) => setPartySize(Number(e.target.value))} disabled={busy} /></label>
          ) : (
            <>
              <label>
                With
                <select value={staffId} onChange={(e) => setStaffId(e.target.value)} disabled={busy}>
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
                      <button
                        type="button"
                        key={s.id}
                        className={`chip${on ? " on" : ""}`}
                        aria-pressed={on}
                        onClick={() => setServiceIds(on ? serviceIds.filter((x) => x !== s.id) : [...serviceIds, s.id])}
                      >
                        {s.name} <span className="muted">{s.durationMin}m{s.price ? ` · ${s.price}` : ""}</span>
                      </button>
                    );
                  })}
                </div>
                {chosen.length > 0 && (
                  <p className="muted" style={{ fontSize: 12.5, margin: "8px 0 0" }}>
                    {totalMin} min · ends about {minutesToClock(toMinutes(time) + totalMin)}{totalPrice ? ` · ${currency} ${totalPrice.toLocaleString()}` : ""}
                  </p>
                )}
              </fieldset>
            </>
          )}

          <label>Notes<input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Allergy, occasion, preference…" disabled={busy} /></label>

          {isRestaurant && error && overbookAllowed && (
            <label className="hours-toggle" style={{ fontWeight: 400 }}>
              <input type="checkbox" checked={overbook} onChange={(e) => setOverbook(e.target.checked)} disabled={busy} />
              Seat them anyway, past the kitchen&apos;s pacing cap.
            </label>
          )}

          {error && (
            <div role="alert" style={{ color: "var(--bad)", fontSize: 13, lineHeight: 1.5 }}>
              {error.text}
              {error.alternatives.length > 0 && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                  <span className="muted">Free:</span>
                  {error.alternatives.map((m) => (
                    <button type="button" key={m} className="chip" onClick={() => { setTime(minutesToClock(m)); setError(null); }}>
                      {minutesToClock(m)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-accent" disabled={busy || !guestName.trim() || (!isRestaurant && serviceIds.length === 0)}>
              {busy ? "Booking…" : "Book it"}
            </button>
            <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          </div>
        </form>
      </aside>
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { minutesToClock } from "@/lib/time";

/**
 * Taking a booking from the gap you clicked.
 *
 * Deliberately short. Somebody is standing at the desk, and the difference
 * between this and a booking form is that the time and the person are already
 * decided — that is what clicking the gap meant. Only a name is required,
 * because a walk-in does not always leave a number and inventing one is worse
 * than leaving it blank.
 */
export default function QuickBook({
  locationId,
  date,
  startMin,
  columnId,
  columnName,
  isRestaurant,
  overbookAllowed,
  services,
  onClose,
  onDone,
}: {
  locationId: string;
  date: string;
  startMin: number;
  columnId: string;
  columnName: string;
  isRestaurant: boolean;
  overbookAllowed: boolean;
  services: { id: string; name: string; durationMin: number }[];
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [guestName, setGuestName] = useState("");
  const [guestPhone, setGuestPhone] = useState("");
  const [partySize, setPartySize] = useState(2);
  const [serviceId, setServiceId] = useState(services[0]?.id ?? "");
  const [notes, setNotes] = useState("");
  const [overbook, setOverbook] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/bookings/quick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          locationId,
          date,
          startMin,
          columnId,
          guestName,
          guestPhone,
          partySize: isRestaurant ? partySize : undefined,
          serviceIds: isRestaurant ? undefined : serviceId ? [serviceId] : [],
          notes,
          overbook,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        const alts = (data.alternatives as number[] | undefined)
          ?.map((m) => minutesToClock(m))
          .join(", ");
        setError(alts ? `${data.error} Free: ${alts}.` : data.error);
        return;
      }
      onDone(
        data.duplicate
          ? `${guestName} already had that booking — nothing was booked twice.`
          : `Booked: ${data.booking.summary} · ${data.booking.ref}`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cal-modal-scrim" onClick={onClose}>
      <div
        className="panel cal-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Take a booking"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-head">
          {minutesToClock(startMin)}
          {columnName && <span className="muted" style={{ fontWeight: 400 }}> · {columnName}</span>}
        </div>

        <form onSubmit={submit} style={{ padding: 16 }}>
          <div style={{ marginBottom: 12 }}>
            <label htmlFor="qb-name">Name</label>
            <input
              id="qb-name"
              ref={nameRef}
              value={guestName}
              onChange={(e) => setGuestName(e.target.value)}
              placeholder="Who is it for?"
              disabled={busy}
            />
          </div>

          <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
            <div style={{ flex: 1 }}>
              <label htmlFor="qb-phone">Number (optional)</label>
              <input
                id="qb-phone"
                value={guestPhone}
                onChange={(e) => setGuestPhone(e.target.value)}
                placeholder="—"
                disabled={busy}
                inputMode="tel"
              />
            </div>

            {isRestaurant ? (
              <div style={{ width: 96 }}>
                <label htmlFor="qb-party">Covers</label>
                <input
                  id="qb-party"
                  type="number"
                  min={1}
                  max={20}
                  value={partySize}
                  onChange={(e) => setPartySize(Number(e.target.value))}
                  disabled={busy}
                />
              </div>
            ) : (
              <div style={{ flex: 1 }}>
                <label htmlFor="qb-service">Service</label>
                <select
                  id="qb-service"
                  value={serviceId}
                  onChange={(e) => setServiceId(e.target.value)}
                  disabled={busy}
                >
                  {services.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} · {s.durationMin} min
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div style={{ marginBottom: 14 }}>
            <label htmlFor="qb-notes">Note (optional)</label>
            <input
              id="qb-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Allergy, occasion, preference…"
              disabled={busy}
            />
          </div>

          {/* Offered only after the engine has already said no, so it reads as
              the override it is rather than a box to tick by habit. */}
          {isRestaurant && error && overbookAllowed && (
            <label
              style={{
                display: "flex",
                gap: 8,
                alignItems: "flex-start",
                textTransform: "none",
                letterSpacing: 0,
                fontSize: 12.5,
                fontWeight: 400,
                color: "var(--text-2)",
                marginBottom: 12,
              }}
            >
              <input
                type="checkbox"
                checked={overbook}
                onChange={(e) => setOverbook(e.target.checked)}
                style={{ width: "auto", marginTop: 2 }}
                disabled={busy}
              />
              <span>
                Seat them anyway. Past the kitchen&apos;s pacing cap — only if you can see
                the room.
              </span>
            </label>
          )}

          {error && (
            <div style={{ color: "var(--bad)", fontSize: 12.5, marginBottom: 12, lineHeight: 1.5 }}>
              {error}
            </div>
          )}

          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-accent" disabled={busy || !guestName.trim()}>
              {busy ? "…" : "Book it"}
            </button>
            <button type="button" className="btn" onClick={onClose} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

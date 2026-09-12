"use client";

import { useState } from "react";

/**
 * One button, one confirmation, then the row updates.
 *
 * A confirmation rather than an undo, because a cancelled table is offered to
 * the waitlist the moment it frees and may be gone by the time anybody looks
 * for an undo button.
 */
export default function CancelBooking({ bookingId, guestName }: { bookingId: string; guestName: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cancel() {
    if (!window.confirm(`Cancel ${guestName}'s booking?`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/bookings/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bookingId }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "That didn't work.");
        return;
      }
      window.location.reload();
    } catch {
      setError("That didn't work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button className="btn btn-danger btn-row" onClick={cancel} disabled={busy}>
        {busy ? "Cancelling…" : "Cancel"}
      </button>
      {error && <div style={{ fontSize: 11.5, color: "var(--bad)", marginTop: 4 }}>{error}</div>}
    </>
  );
}

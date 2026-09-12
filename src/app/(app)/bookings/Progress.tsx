"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Booking } from "@/lib/types";

/**
 * Ticking somebody off as they walk in.
 *
 * Two buttons at a host stand, and they have to be two: anything that needs
 * reading is not going to be used while somebody is standing in front of you
 * with their coat on. Which two depends on where the booking is — before the
 * visit it is "here" or "did not come"; after arrival it is "gone".
 *
 * Not optimistic. The row is greyed while the write is in flight and redrawn
 * from the server afterwards, because the same page is open at the desk and on
 * somebody's phone, and two copies of the truth at a host stand on a Friday is
 * exactly where this would go wrong.
 */
export default function Progress({
  locationId,
  booking,
  guestWord,
}: {
  locationId: string;
  booking: Pick<Booking, "id" | "status" | "service">;
  guestWord: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function mark(event: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/bookings/progress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locationId, bookingId: booking.id, event }),
      });
      if (!res.ok) {
        const { error: message } = (await res.json().catch(() => ({}))) as { error?: string };
        setError(message ?? "That did not save.");
        return;
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // Sized for a thumb at a host stand, not a cursor. They were 27px tall.
  const btn = {
    padding: "9px 14px",
    fontSize: 12.5,
    minHeight: 40,
  } as const;

  if (error) {
    return (
      <span style={{ fontSize: 11.5, color: "var(--bad)" }}>
        {error}{" "}
        <button className="btn" style={btn} onClick={() => setError(null)}>
          Retry
        </button>
      </span>
    );
  }

  if (booking.status === "no_show") {
    return (
      <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
        <span className="pill" style={{ color: "var(--bad)", background: "var(--bad-soft)", borderColor: "var(--bad-soft)" }}>
          no-show
        </span>
        <button className="btn" style={btn} disabled={busy} onClick={() => mark("reopen")}>
          Undo
        </button>
      </span>
    );
  }

  if (booking.status === "completed") {
    return (
      <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
        <span className="pill" style={{ color: "var(--ok)", background: "var(--ok-soft)", borderColor: "var(--ok-soft)" }}>
          done
        </span>
        <button className="btn" style={btn} disabled={busy} onClick={() => mark("reopen")}>
          Undo
        </button>
      </span>
    );
  }

  if (booking.status !== "confirmed") return null;

  if (booking.service?.arrivedAt) {
    return (
      <span style={{ display: "inline-flex", gap: 6, alignItems: "center", opacity: busy ? 0.5 : 1 }}>
        <span className="pill">here</span>
        <button className="btn" style={btn} disabled={busy} onClick={() => mark("left")}>
          Gone
        </button>
      </span>
    );
  }

  return (
    <span style={{ display: "inline-flex", gap: 6, opacity: busy ? 0.5 : 1 }}>
      <button className="btn" style={btn} disabled={busy} onClick={() => mark("arrived")}>
        Here
      </button>
      <button
        className="btn btn-danger"
        style={btn}
        disabled={busy}
        title={`Counts against this ${guestWord} in the house rules`}
        onClick={() => mark("no_show")}
      >
        No-show
      </button>
    </span>
  );
}

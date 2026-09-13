"use client";

import { useState } from "react";

/**
 * The deposit on one booking: what is owed, and the three things the desk does
 * about it. "Send link" only appears once the venue's Stripe account can take
 * cards; paid and waived work today.
 */
export default function DepositActions({
  bookingId,
  label,
  status,
  canSend,
}: {
  bookingId: string;
  label: string;
  status: "required" | "paid" | "waived";
  canSend: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function act(action: "send" | "paid" | "waived") {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/bookings/deposit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bookingId, action }),
      });
      const data = (await res.json()) as { error?: string; texted?: boolean };
      if (!res.ok) {
        setNote(data.error ?? "That didn't work.");
        return;
      }
      if (action === "send") {
        setNote(data.texted ? "Link texted." : "Link made, but the text did not send.");
        return;
      }
      window.location.reload();
    } catch {
      setNote("That didn't work.");
    } finally {
      setBusy(false);
    }
  }

  if (status !== "required") {
    return (
      <span className="pill" style={{ fontSize: 11 }}>
        deposit {status}
      </span>
    );
  }

  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap", fontSize: 12 }}>
      <span className="pill" style={{ fontSize: 11, color: "var(--warn)", borderColor: "var(--warn)" }}>
        {label} deposit owed
      </span>
      {canSend && (
        <button className="btn btn-row" onClick={() => act("send")} disabled={busy}>
          Send link
        </button>
      )}
      <button className="btn btn-row" onClick={() => act("paid")} disabled={busy}>
        Paid
      </button>
      <button className="btn btn-row" onClick={() => act("waived")} disabled={busy}>
        Waive
      </button>
      {note && <span className="muted">{note}</span>}
    </span>
  );
}

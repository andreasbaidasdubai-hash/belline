"use client";

import { useState } from "react";

/**
 * A venue's WhatsApp number, or the two fields that connect one.
 *
 * The number has already been added in Meta's dashboard under Belline's own
 * account; this records it against the venue so messages to it book into
 * the right diary. Two fields because that is all that differs per venue.
 */
export default function WhatsAppCell({
  venueId,
  number,
  ready,
}: {
  venueId: string;
  number: string | null;
  /** Whether our own WhatsApp account is connected — a venue's number lives inside it. */
  ready: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    try {
      const res = await fetch("/api/sales/whatsapp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          venueId,
          number: form.get("number"),
          phoneNumberId: form.get("phoneNumberId"),
        }),
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

  async function pause() {
    if (!window.confirm("Stop answering on this number? The history stays.")) return;
    setBusy(true);
    try {
      await fetch(`/api/sales/whatsapp?venueId=${encodeURIComponent(venueId)}`, { method: "DELETE" });
      window.location.reload();
    } finally {
      setBusy(false);
    }
  }

  if (number) {
    return (
      <div style={{ fontSize: 12.5 }}>
        <span className="mono">{number}</span>
        <button className="btn btn-row" style={{ marginLeft: 8 }} onClick={pause} disabled={busy}>
          Pause
        </button>
      </div>
    );
  }

  if (!ready) {
    return (
      <span className="muted" style={{ fontSize: 11.5 }}>
        after ours is connected
      </span>
    );
  }

  if (!open) {
    return (
      <button className="btn btn-row" onClick={() => setOpen(true)}>
        Connect a number
      </button>
    );
  }

  return (
    <form onSubmit={connect} style={{ display: "grid", gap: 6, minWidth: 220 }}>
      <input name="number" placeholder="+9715XXXXXXXX" aria-label="WhatsApp number" required />
      <input name="phoneNumberId" placeholder="Meta phone number ID" aria-label="Meta phone number ID" required />
      {error && <span style={{ fontSize: 11.5, color: "var(--bad)" }}>{error}</span>}
      <div style={{ display: "flex", gap: 6 }}>
        <button className="btn btn-accent btn-row" type="submit" disabled={busy}>
          {busy ? "Connecting…" : "Connect"}
        </button>
        <button className="btn btn-row" type="button" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

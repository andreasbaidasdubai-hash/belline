"use client";

import { useState } from "react";

/**
 * The number a venue's calls are forwarded to.
 *
 * Buy it in Twilio, point its voice webhook at /api/twilio/voice, then record
 * it here. Until this exists for a venue, its forwarded calls reach nobody.
 */
export default function NumberCell({ venueId, phone }: { venueId: string; phone: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    try {
      const res = await fetch("/api/sales/clients/number", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ venueId, phone: form.get("phone") }),
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

  if (!open) {
    return phone ? (
      <div style={{ fontSize: 12.5 }}>
        <span className="mono">{phone}</span>
        <button className="btn btn-row" style={{ marginLeft: 8 }} onClick={() => setOpen(true)}>
          Change
        </button>
      </div>
    ) : (
      <button className="btn btn-row" onClick={() => setOpen(true)}>
        Assign a number
      </button>
    );
  }

  return (
    <form onSubmit={save} style={{ display: "grid", gap: 6, minWidth: 200 }}>
      <input name="phone" defaultValue={phone} placeholder="+15715550100" aria-label="Belline number" />
      {error && <span style={{ fontSize: 11.5, color: "var(--bad)" }}>{error}</span>}
      <div style={{ display: "flex", gap: 6 }}>
        <button className="btn btn-accent btn-row" type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button className="btn btn-row" type="button" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

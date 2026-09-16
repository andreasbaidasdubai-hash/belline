"use client";

import { useState } from "react";

/**
 * The number a venue's calls are forwarded to.
 *
 * Buy it in Twilio, point its voice webhook at /api/twilio/voice, then record
 * it here. Until this exists for a venue, its forwarded calls reach nobody.
 *
 * Recording is the whole of it: nothing here buys a number, configures Twilio
 * or dials anything. What it writes is `location.phone`, which is the field
 * the voice webhook routes on — so a wrong value silently points a live
 * venue's calls at the wrong diary. Hence the confirmation and the audit row.
 */
export default function NumberCell({
  venueId,
  venueName,
  phone,
}: {
  venueId: string;
  venueName: string;
  phone: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;

    const form = new FormData(e.currentTarget);
    const next = String(form.get("phone") ?? "").trim();
    // Named, and quoting both numbers. This row is one of twenty and the wrong
    // one is a keystroke away; "are you sure?" would not tell anybody which
    // venue they were about to redirect.
    const question = phone
      ? `Change the recorded number for ${venueName} from ${phone} to ${next || "none"}?\n\n` +
        `Calls forwarded to ${phone} will stop reaching this venue.`
      : `Record ${next || "no number"} as the Belline number for ${venueName}?`;
    if (!window.confirm(question)) return;

    setBusy(true);
    setError(null);
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
        Record a number
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

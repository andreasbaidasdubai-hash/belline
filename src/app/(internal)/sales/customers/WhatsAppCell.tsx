"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * A location's WhatsApp number, or the two fields that connect one.
 *
 * The number has already been added in Meta's dashboard under Belline's own
 * account; this records it against the location so messages to it book into
 * the right diary. Connecting starts answering real customers in the venue's
 * name, and pausing stops it, so both ask first, in the page, naming the venue.
 */
export default function WhatsAppCell({
  venueId,
  venueName,
  number,
  ready,
}: {
  venueId: string;
  venueName: string;
  number: string | null;
  /** Whether our own WhatsApp account is connected — a venue's number lives inside it. */
  ready: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmConnect, setConfirmConnect] = useState<{ number: string; phoneNumberId: string } | null>(null);
  const [confirmPause, setConfirmPause] = useState(false);

  async function connect(input: { number: string; phoneNumberId: string }) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/sales/whatsapp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ venueId, ...input }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "That didn't work.");
        setConfirmConnect(null);
        return;
      }
      setConfirmConnect(null);
      setOpen(false);
      router.refresh();
    } catch {
      setError("That didn't work.");
    } finally {
      setBusy(false);
    }
  }

  async function pause() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/sales/whatsapp?venueId=${encodeURIComponent(venueId)}`, { method: "DELETE" });
      if (!res.ok) setError("That didn't work.");
      setConfirmPause(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (number) {
    if (confirmPause) {
      return (
        <div className="staff-action-form" role="alertdialog" aria-label={`Pause WhatsApp for ${venueName}`}>
          <p className="staff-action-question">Stop answering WhatsApp on {number} for {venueName}? The history stays.</p>
          <div className="staff-action-buttons">
            <button className="btn btn-danger btn-row" type="button" disabled={busy} onClick={() => void pause()}>
              {busy ? "Pausing…" : "Yes, pause it"}
            </button>
            <button className="btn btn-row" type="button" disabled={busy} onClick={() => setConfirmPause(false)}>
              Back
            </button>
          </div>
        </div>
      );
    }
    return (
      <div style={{ fontSize: 13 }}>
        <span className="mono">{number}</span>
        <button className="btn btn-row" style={{ marginLeft: 8 }} onClick={() => setConfirmPause(true)} disabled={busy}>
          Pause
        </button>
        {error && <div style={{ fontSize: 11.5, color: "var(--bl-danger)" }}>{error}</div>}
      </div>
    );
  }

  if (!ready) {
    return <span className="muted" style={{ fontSize: 12 }}>Available once Belline&apos;s own WhatsApp account is connected</span>;
  }

  if (confirmConnect) {
    return (
      <div className="staff-action-form" role="alertdialog" aria-label={`Connect WhatsApp for ${venueName}`}>
        <p className="staff-action-question">
          Connect {confirmConnect.number} to {venueName}? Belline will start answering WhatsApp messages sent to that number, as {venueName}.
        </p>
        <div className="staff-action-buttons">
          <button className="btn btn-accent btn-row" type="button" disabled={busy} onClick={() => void connect(confirmConnect)}>
            {busy ? "Connecting…" : "Yes, connect it"}
          </button>
          <button className="btn btn-row" type="button" disabled={busy} onClick={() => setConfirmConnect(null)}>
            Back
          </button>
        </div>
      </div>
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
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        setConfirmConnect({ number: String(form.get("number") ?? "").trim(), phoneNumberId: String(form.get("phoneNumberId") ?? "").trim() });
      }}
      style={{ display: "grid", gap: 6, minWidth: 220 }}
    >
      <input name="number" placeholder="+9715XXXXXXXX" aria-label="WhatsApp number" required />
      <input name="phoneNumberId" placeholder="Meta phone number ID" aria-label="Meta phone number ID" required />
      {error && <span style={{ fontSize: 11.5, color: "var(--bl-danger)" }}>{error}</span>}
      <div style={{ display: "flex", gap: 6 }}>
        <button className="btn btn-accent btn-row" type="submit" disabled={busy}>
          Connect
        </button>
        <button className="btn btn-row" type="button" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

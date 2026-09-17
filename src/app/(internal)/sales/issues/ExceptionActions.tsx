"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Resolve with a note and the minutes it took, or mark as waiting on the customer. In the page. */
export default function ExceptionActions({ id, waiting }: { id: string; waiting: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [minutes, setMinutes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/sales/exceptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, ...body }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) setError(data.error ?? "That did not save.");
      else {
        setOpen(false);
        router.refresh();
      }
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="staff-row-actions">
        <button className="btn btn-accent btn-row" type="button" onClick={() => setOpen(true)}>
          Resolve
        </button>
        {!waiting && (
          <button className="btn btn-row" type="button" disabled={busy} onClick={() => void send({ action: "waiting" })}>
            Waiting on customer
          </button>
        )}
        {error && (
          <p role="alert" className="staff-action-error" style={{ margin: 0 }}>
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <form
      className="staff-action-form"
      onSubmit={(e) => {
        e.preventDefault();
        void send({ action: "resolve", note, minutes: minutes === "" ? NaN : Number(minutes) });
      }}
    >
      <label className="staff-field">
        <span>What was done</span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} aria-label="Resolution note" rows={2} maxLength={1000} required />
      </label>
      <label className="staff-field">
        <span>Minutes it took</span>
        <input value={minutes} onChange={(e) => setMinutes(e.target.value.replace(/[^\d]/g, ""))} inputMode="numeric" aria-label="Minutes spent" required />
      </label>
      <div className="staff-action-buttons">
        <button className="btn btn-accent btn-row" type="submit" disabled={busy}>
          {busy ? "Saving…" : "Resolve"}
        </button>
        <button className="btn btn-row" type="button" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      {error && (
        <p role="alert" className="staff-action-error" style={{ margin: 0 }}>
          {error}
        </p>
      )}
    </form>
  );
}

"use client";

import { useState } from "react";

/** Resolve with a note and the minutes it took, or mark as waiting on the customer. */
export default function ExceptionActions({ id, waiting }: { id: string; waiting: boolean }) {
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
      else window.location.reload();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void send({ action: "resolve", note, minutes: minutes === "" ? NaN : Number(minutes) });
      }}
      style={{ display: "grid", gap: 6, minWidth: 220 }}
    >
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="What was done"
        aria-label="Resolution note"
        rows={2}
        maxLength={1000}
      />
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input
          value={minutes}
          onChange={(e) => setMinutes(e.target.value.replace(/[^\d]/g, ""))}
          inputMode="numeric"
          placeholder="Minutes"
          aria-label="Minutes spent"
          style={{ width: 90 }}
        />
        <button className="btn btn-accent" type="submit" disabled={busy}>
          Resolve
        </button>
        {!waiting && (
          <button className="btn" type="button" disabled={busy} onClick={() => void send({ action: "waiting" })}>
            Waiting on customer
          </button>
        )}
      </div>
      {error && (
        <p role="alert" style={{ margin: 0, fontSize: 12, color: "var(--bad)" }}>
          {error}
        </p>
      )}
    </form>
  );
}

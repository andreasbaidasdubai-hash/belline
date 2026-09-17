"use client";

import { useState } from "react";

/** One button that posts one action to /api/sales/video and reloads. */
export default function VideoAction({
  action,
  label,
  locationId,
  sessionId,
  danger,
  confirm,
}: {
  action: "kill" | "restore" | "allow" | "disallow" | "end";
  label: string;
  locationId?: string;
  sessionId?: string;
  danger?: boolean;
  confirm?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (confirm && !window.confirm(confirm)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/sales/video", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, locationId, sessionId }),
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
    <span style={{ display: "inline-grid", gap: 4 }}>
      <button
        type="button"
        className={`btn${danger ? " btn-danger" : ""}`}
        disabled={busy}
        onClick={() => void run()}
        style={danger ? { borderColor: "var(--bad)", color: "var(--bad)" } : undefined}
      >
        {busy ? "Saving…" : label}
      </button>
      {error && (
        <span role="alert" style={{ color: "var(--bad)", fontSize: 12 }}>
          {error}
        </span>
      )}
    </span>
  );
}

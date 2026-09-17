"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * One button that posts one action to /api/sales/video and refreshes the page.
 * With `confirm`, it asks first, in the page.
 */
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
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
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
      else {
        setAsking(false);
        router.refresh();
      }
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  if (asking && confirm) {
    return (
      <span className="staff-action-form" role="alertdialog" aria-label={label}>
        <span className="staff-action-question">{confirm}</span>
        <span className="staff-action-buttons">
          <button type="button" className={`btn btn-row${danger ? " btn-danger" : " btn-accent"}`} disabled={busy} onClick={() => void run()}>
            {busy ? "Saving…" : "Yes"}
          </button>
          <button type="button" className="btn btn-row" disabled={busy} onClick={() => setAsking(false)}>
            Back
          </button>
        </span>
        {error && <span role="alert" className="staff-action-error">{error}</span>}
      </span>
    );
  }

  return (
    <span style={{ display: "inline-grid", gap: 4 }}>
      <button type="button" className={`btn btn-row${danger ? " btn-danger" : ""}`} disabled={busy} onClick={() => (confirm ? setAsking(true) : void run())}>
        {busy ? "Saving…" : label}
      </button>
      {error && (
        <span role="alert" className="staff-action-error">
          {error}
        </span>
      )}
    </span>
  );
}

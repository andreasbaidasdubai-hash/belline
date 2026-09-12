"use client";

import { useState } from "react";

/** One button, one round trip, then Stripe's page. */
export default function ManageBilling({ locationId }: { locationId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/portal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locationId }),
      });
      const data = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !data.url) {
        setError(data.error ?? "Could not open billing.");
        return;
      }
      window.location.href = data.url;
    } catch {
      setError("Could not open billing.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 14 }}>
      <button className="btn" onClick={open} disabled={busy}>
        {busy ? "Opening…" : "Card, invoices and cancellation"}
      </button>
      {error && (
        <p style={{ margin: "8px 0 0", fontSize: 12.5, color: "var(--bad)" }}>{error}</p>
      )}
    </div>
  );
}

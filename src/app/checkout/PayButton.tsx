"use client";

import { useState } from "react";
import type { BillingCycle, ProductId } from "@/lib/billing/plans";

/**
 * One button, and it says what it does.
 *
 * "Choose plan": the next screen is Stripe's, asking for a card. It used to
 * promise going live as well, but paying does not switch anything on — going
 * live is its own step in setup.
 *
 * With card payments closed (`billing.stripe` off) the button says payments
 * open soon and until when the owner is covered. It never calls the checkout
 * route, so its 503 is never what the owner sees, and it never offers an
 * email address instead.
 */
export default function PayButton({
  products,
  cycle,
  enabled,
  venueName,
  coveredNote,
}: {
  products: ProductId[];
  cycle: BillingCycle;
  enabled: boolean;
  venueName: string;
  /** "Payments open soon — you're covered until …", from billing/trial-end.ts. */
  coveredNote?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (products.length === 0) {
    return (
      <button className="btn" disabled style={{ width: "100%", padding: "14px 16px" }}>
        Choose a plan
      </button>
    );
  }

  if (!enabled) {
    return (
      <div>
        <button className="btn" disabled style={{ width: "100%", padding: "14px 16px" }}>
          Payments open soon
        </button>
        <p className="muted" style={{ fontSize: 12, margin: "12px 0 0", lineHeight: 1.6 }}>
          {coveredNote ?? "Payments open soon — Belline keeps answering until then."} {venueName} keeps answering, and
          nothing is charged.
        </p>
      </div>
    );
  }

  async function pay() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ products, cycle }),
      });
      const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !body.url) {
        setError(body.error ?? "Could not open checkout.");
        setBusy(false);
        return;
      }
      window.location.href = body.url;
    } catch {
      setError("Could not reach Belline. Check your connection and try again.");
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        className="btn btn-accent"
        onClick={pay}
        disabled={busy}
        style={{ width: "100%", padding: "14px 16px", fontSize: 14.5 }}
      >
        {busy ? "Opening checkout…" : "Choose plan"}
      </button>
      {error && (
        <p role="alert" style={{ fontSize: 12.5, color: "var(--bad)", margin: "12px 0 0" }}>
          {error}
        </p>
      )}
    </div>
  );
}

"use client";

import { useState } from "react";
import type { BillingCycle, PlanId } from "@/lib/billing/plans";

/**
 * One button, and it says what it does.
 *
 * "Pay" rather than "Continue" or "Proceed": the next screen asks for a card,
 * and a button that hides that is a button people press and then resent.
 *
 * When Stripe is not configured the button says so instead of failing. That is
 * the same contract every other provider in this codebase follows — a product
 * with an unset key degrades honestly rather than throwing at a customer.
 */
export default function PayButton({
  planId,
  cycle,
  enabled,
  venueName,
}: {
  planId: PlanId;
  cycle: BillingCycle;
  enabled: boolean;
  venueName: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!enabled) {
    return (
      <div>
        <button className="btn" disabled style={{ width: "100%", padding: "14px 16px" }}>
          Card payments are not switched on yet
        </button>
        <p className="muted" style={{ fontSize: 12, margin: "12px 0 0", lineHeight: 1.6 }}>
          {venueName} is on the free trial and keeps answering. Email{" "}
          <a href="mailto:hello@belline.ai">hello@belline.ai</a> and we will take it from there.
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
        body: JSON.stringify({ planId, cycle }),
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
        {busy ? "Opening checkout…" : "Pay and go live"}
      </button>
      {error && (
        <p role="alert" style={{ fontSize: 12.5, color: "var(--bad)", margin: "12px 0 0" }}>
          {error}
        </p>
      )}
    </div>
  );
}

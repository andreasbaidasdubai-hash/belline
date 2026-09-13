"use client";

import { useState } from "react";
import type { BillingCycle, PlanId } from "@/lib/billing/plans";

/**
 * Four fields, on the same page as the price.
 *
 * Everything else a signup form might ask for is something the next screen
 * reads off the business's own website, so asking here would be asking
 * somebody to type what we are about to fetch.
 *
 * What happens on submit depends on whether we can take a card yet:
 *
 *   Stripe configured — create the account, then straight to Stripe. The
 *   customer never comes back to a marketing page in between, which is the
 *   thing that loses them.
 *
 *   Stripe not configured — create the account and go to setup. The trial is
 *   real, the product works, and the button says so rather than pretending
 *   there is a payment step that does not exist.
 */

const TRADES = [
  { value: "salon", label: "Salon or spa" },
  { value: "clinic", label: "Clinic or dental practice" },
  { value: "restaurant", label: "Restaurant" },
] as const;

export default function CheckoutForm({
  planId,
  cycle,
  takesCard,
}: {
  planId: PlanId;
  cycle: BillingCycle;
  takesCard: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ field?: string; message: string } | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);

    const form = new FormData(event.currentTarget);
    try {
      const signup = await fetch("/api/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          businessName: form.get("businessName"),
          vertical: form.get("vertical"),
          email: form.get("email"),
          password: form.get("password"),
          // Their clock, not the server's. "Tomorrow at four" has to mean
          // their four, and this is the only moment we can ask for free.
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });

      const body = (await signup.json().catch(() => ({}))) as {
        ok?: boolean;
        next?: string;
        field?: string;
        error?: string;
      };

      if (!signup.ok || !body.ok) {
        setError({ field: body.field, message: body.error ?? "Something went wrong." });
        setBusy(false);
        return;
      }

      if (takesCard) {
        // Straight on to the card. A "thanks for signing up" page in between is
        // a page people close.
        const checkout = await fetch("/api/checkout", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ planId, cycle }),
        });
        const paid = (await checkout.json().catch(() => ({}))) as { url?: string };
        if (paid.url) {
          window.location.href = paid.url;
          return;
        }
        // Checkout would not open. The account exists and the trial is
        // running, so carry on into setup rather than stranding them —
        // they can add a card from the dashboard.
      }

      window.location.href = body.next ?? "/setup";
    } catch {
      setError({ message: "Could not reach Belline. Check your connection and try again." });
      setBusy(false);
    }
  }

  const bad = (name: string) => (error?.field === name ? { borderColor: "var(--bad)" } : {});

  return (
    <form onSubmit={submit} style={{ display: "grid", gap: 14 }}>
      <div>
        <label htmlFor="businessName">Business name</label>
        <input
          id="businessName"
          name="businessName"
          type="text"
          required
          maxLength={120}
          autoComplete="organization"
          placeholder="Marina Hair Studio"
          style={bad("businessName")}
        />
      </div>

      <div>
        <label htmlFor="vertical">What do you do?</label>
        <select id="vertical" name="vertical" defaultValue="salon" style={bad("vertical")}>
          {TRADES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="email">Your email</label>
        <input
          id="email"
          name="email"
          type="email"
          required
          maxLength={254}
          autoComplete="email"
          inputMode="email"
          spellCheck={false}
          style={bad("email")}
        />
      </div>

      <div>
        <label htmlFor="password">Choose a password</label>
        <input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="new-password"
          minLength={12}
          style={bad("password")}
        />
        <p className="muted" style={{ fontSize: 10.5, margin: "6px 0 0" }}>
          At least twelve characters. A short sentence works well.
        </p>
      </div>

      {error && (
        <p
          role="alert"
          style={{
            margin: 0,
            fontSize: 12.5,
            color: "var(--bad)",
            background: "var(--bad-soft)",
            border: "1px solid var(--bad)",
            borderRadius: 9,
            padding: "10px 12px",
          }}
        >
          {error.message}
        </p>
      )}

      <button
        className="btn btn-accent"
        type="submit"
        disabled={busy}
        style={{ padding: "13px 16px", fontSize: 14.5, marginTop: 4 }}
      >
        {busy ? "Setting you up…" : takesCard ? "Continue to payment" : "Start free trial"}
      </button>

      <p className="muted" style={{ fontSize: 10.5, margin: 0, textAlign: "center", lineHeight: 1.6 }}>
        Next: paste your website and Belline reads your business off it.
        <br />
        By continuing you agree to the{" "}
        <a href="https://belline.ai/terms" target="_blank" rel="noopener">Terms</a> and{" "}
        <a href="https://belline.ai/privacy" target="_blank" rel="noopener">Privacy policy</a>.
      </p>
    </form>
  );
}

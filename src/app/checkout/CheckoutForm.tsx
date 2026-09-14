"use client";

import { useState } from "react";
import type { ProductId } from "@/lib/billing/plans";
import type { Market } from "@/lib/markets";

/**
 * Four fields, on the same page as the price.
 *
 * Everything else a signup form might ask for is something the next screen
 * reads off the business's own website, so asking here would be asking
 * somebody to type what we are about to fetch.
 *
 * No card, whatever is configured. The trial is card-free (§2.3, confirmed
 * before Stripe goes live): the card is asked for when somebody chooses a
 * plan from their dashboard, never here. What they picked on this page is
 * remembered on the trial, so the end of it can offer the same thing back.
 */

const TRADES = [
  { value: "salon", label: "Salon or spa" },
  { value: "clinic", label: "Clinic or dental practice" },
  { value: "restaurant", label: "Restaurant" },
] as const;

export default function CheckoutForm({ products, market }: { products: ProductId[]; market: Market }) {
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
          products,
          market,
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
        {busy ? "Setting you up…" : "Start free trial"}
      </button>

      <p className="muted" style={{ fontSize: 10.5, margin: 0, textAlign: "center", lineHeight: 1.6 }}>
        No card. Next: paste your website and Belline reads your business off it.
        <br />
        By continuing you agree to the{" "}
        <a href="https://belline.ai/terms" target="_blank" rel="noopener">Terms</a> and{" "}
        <a href="https://belline.ai/privacy" target="_blank" rel="noopener">Privacy policy</a>.
      </p>
    </form>
  );
}

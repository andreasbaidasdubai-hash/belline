"use client";

import { useState } from "react";
import type { ProductId } from "@/lib/billing/plans";
import { MARKETS, type Market } from "@/lib/markets";
import { PASSWORD_HINT, PASSWORD_MIN_LENGTH, TRADES, TRADE_GROUPS, passwordProblem } from "@/lib/signup-rules";

/**
 * A few fields, on the same page as the price.
 *
 * Everything else a signup form might ask for is something the next screen
 * reads off the business's own website, so asking here would be asking
 * somebody to type what we are about to fetch.
 *
 * No card, whatever is configured. The trial is card-free (§2.3, confirmed
 * before Stripe goes live): the card is asked for when somebody chooses a
 * plan from their dashboard, never here. What they picked on this page is
 * remembered on the trial, so the end of it can offer the same thing back.
 *
 * The country decides the currency and the clock, not the browser. The kind
 * of business is optional: a landing page's `?trade=` prefills it, and empty
 * is a fine answer.
 */

interface Failure {
  field?: string;
  message: string;
  didYouMean?: string;
  signIn?: string;
}

export default function CheckoutForm({
  products,
  market,
  markets,
  trade,
}: {
  products: ProductId[];
  market: Market;
  /** The countries a business can sign up in today. */
  markets: Market[];
  /** Preselected from the link's `?trade=`, or "" for nothing chosen. */
  trade: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Failure | null>(null);
  const [email, setEmail] = useState("");
  const [emailConfirmed, setEmailConfirmed] = useState(false);

  async function submit(element: HTMLFormElement, confirmed = emailConfirmed) {
    if (busy) return;
    const form = new FormData(element);

    // The same rule the server holds, checked here so a short password costs
    // a round trip to nobody.
    const problem = passwordProblem(String(form.get("password") ?? ""));
    if (problem) {
      setError({ field: "password", message: problem });
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const signup = await fetch("/api/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          businessName: form.get("businessName"),
          // What they picked from the list. Never an engine `vertical`: the
          // server works that out, so "garage" can never arrive as one.
          trade: form.get("trade") ?? "",
          email,
          emailConfirmed: confirmed,
          password: form.get("password"),
          market: form.get("market") ?? market,
          acceptTerms: form.get("acceptTerms") === "on",
          products,
        }),
      });

      const body = (await signup.json().catch(() => ({}))) as {
        ok?: boolean;
        next?: string;
        field?: string;
        error?: string;
        didYouMean?: string;
        signIn?: string;
      };

      if (!signup.ok || !body.ok) {
        setError({
          field: body.field,
          message: body.error ?? "Something went wrong.",
          didYouMean: body.didYouMean,
          signIn: body.signIn,
        });
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
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit(e.currentTarget);
      }}
      style={{ display: "grid", gap: 14 }}
    >
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
        <label htmlFor="market">Where is the business?</label>
        {/*
          The country, not the browser's clock: a UAE business set up from
          Zurich still opens at nine in Dubai and is billed in dirhams.
        */}
        <select id="market" name="market" defaultValue={market} style={bad("market")}>
          {markets.map((m) => (
            <option key={m} value={m}>
              {MARKETS[m].name}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="trade">What do you do?</label>
        {/*
          Grouped, because seventeen options in one flat list is a scroll on a
          phone. The engine only tells a table from an appointment; the rest
          of the difference is kept for reports, so the list can be as long as
          it needs to be without the engine growing a case for each entry.
        */}
        <select id="trade" name="trade" defaultValue={trade} style={bad("vertical")}>
          <option value="">Something else, or skip</option>
          {TRADE_GROUPS.map((group) => (
            <optgroup key={group} label={group}>
              {TRADES.filter((t) => t.group === group).map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </optgroup>
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
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setEmailConfirmed(false);
          }}
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
          minLength={PASSWORD_MIN_LENGTH}
          style={bad("password")}
        />
        <p className="muted" style={{ fontSize: 10.5, margin: "6px 0 0" }}>
          {PASSWORD_HINT}
        </p>
      </div>

      <label
        htmlFor="acceptTerms"
        style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 11.5, lineHeight: 1.5 }}
      >
        <input id="acceptTerms" name="acceptTerms" type="checkbox" required style={{ width: "auto", marginTop: 2 }} />
        <span>
          I agree to the{" "}
          <a href="https://belline.ai/terms" target="_blank" rel="noopener">Terms</a> and{" "}
          <a href="https://belline.ai/privacy" target="_blank" rel="noopener">Privacy policy</a>.
        </span>
      </label>

      {error && (
        <div
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
          {error.signIn && (
            <>
              {" "}
              <a href={error.signIn} style={{ color: "inherit", textDecoration: "underline" }}>
                Sign in
              </a>
            </>
          )}
          {error.didYouMean && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setEmail(error.didYouMean!);
                  setEmailConfirmed(false);
                  setError(null);
                }}
              >
                Use {error.didYouMean}
              </button>
              <button
                type="button"
                className="btn"
                onClick={(e) => {
                  setEmailConfirmed(true);
                  // Resubmit as typed, with the address confirmed. Passed
                  // directly because the state above lands after this call.
                  const form = e.currentTarget.form;
                  if (form) void submit(form, true);
                }}
              >
                Keep what I typed
              </button>
            </div>
          )}
        </div>
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
      </p>
    </form>
  );
}

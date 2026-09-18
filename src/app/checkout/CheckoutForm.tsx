"use client";

import { useState } from "react";
import type { ProductId } from "@/lib/billing/plans";
import { MARKETS, type Market } from "@/lib/markets";
import { PASSWORD_HINT, PASSWORD_MIN_LENGTH, passwordProblem } from "@/lib/signup-rules";

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
 * The country decides the currency and the clock, not the browser.
 *
 * There is no "What do you do?" here any more (founder, f6). It was the one
 * question on the page whose answer we can read for ourselves off the website
 * the very next screen asks for, and it was seventeen options deep on a phone
 * between a business name and an email address. What kind of business it is
 * still decides the engine; it is set from the venue's own card under
 * Settings → Locations, and until Belline has taken a booking or a call there
 * it can still be changed (lib/locations.ts).
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
  siteOrigin,
  verifyBy,
}: {
  products: ProductId[];
  market: Market;
  /** The countries a business can sign up in today. */
  markets: Market[];
  /** Where the terms and privacy policy are, for this environment (lib/origin.ts). */
  siteOrigin: string;
  /** How the address is confirmed here: by an emailed code, or by the team. */
  verifyBy: "email" | "team";
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

      window.location.href = body.next ?? "/verify";
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
        {/*
          The placeholder asks the question again rather than naming a
          business. "Marina Hair Studio" read as a value already filled in,
          and it named one trade to everybody who is not in it (founder, f6).
        */}
        <input
          id="businessName"
          name="businessName"
          type="text"
          required
          maxLength={120}
          autoComplete="organization"
          placeholder="Your business name"
          style={bad("businessName")}
        />
      </div>

      {/*
        The country, not the browser's clock: a UAE business set up from
        Zurich still opens at nine in Dubai and is billed in dirhams.

        A select with one option is a question with one answer, and a line of
        read-only text saying the answer is a line nobody needs to read
        (founder, f6). While only one market is open there is nothing on the
        page at all — the market still travels, as a hidden field, and the
        server still refuses any other. The control comes back on its own the
        day a second market's `status` in lib/markets.ts turns "live"; nothing
        here has to be remembered or undone.
      */}
      {markets.length > 1 ? (
        <div>
          <label htmlFor="market">Where is the business?</label>
          <select id="market" name="market" defaultValue={market} style={bad("market")}>
            {markets.map((m) => (
              <option key={m} value={m}>
                {MARKETS[m].name}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <input type="hidden" name="market" value={markets[0] ?? market} data-market-fixed />
      )}

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

      {/*
        The checkbox is a sibling of its label, not a child of it.

        It used to sit inside the <label>, which reads as the obvious way to
        write this and is the one arrangement that breaks the name. A label
        names its control from its own contents, and an embedded control
        inside those contents contributes its *value* — so this consent
        checkbox announced itself as "on". A person agreeing to terms by
        screen reader heard the word "on" and nothing about what they were
        agreeing to. Clicking the text still toggles it, because `htmlFor`
        binds them; only the nesting is gone.
      */}
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 11.5, lineHeight: 1.5 }}>
        <input id="acceptTerms" name="acceptTerms" type="checkbox" required style={{ width: "auto", marginTop: 2 }} />
        <label htmlFor="acceptTerms">
          I agree to the{" "}
          <a href={`${siteOrigin}/terms`} target="_blank" rel="noopener">Terms</a> and{" "}
          <a href={`${siteOrigin}/privacy`} target="_blank" rel="noopener">Privacy policy</a>.
        </label>
      </div>

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
        {busy ? "Setting you up…" : "Get started"}
      </button>

      <p className="muted" style={{ fontSize: 10.5, margin: 0, textAlign: "center", lineHeight: 1.6 }}>
        {verifyBy === "email"
          ? "No card. Next, confirm your email with the code we send."
          : "No card. Belline can’t send email from here yet, so the team confirms your address for you."}
      </p>
    </form>
  );
}

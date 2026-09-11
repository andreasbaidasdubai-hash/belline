"use client";

import { useState } from "react";

/**
 * Four fields.
 *
 * Business name, what you do, email, password — and nothing else, because
 * every other thing a signup form asks for is something the next screen can
 * read off the business's own website. Asking for an address and a phone
 * number here would be asking somebody to type what we are about to fetch.
 *
 * The vertical is the one field that cannot be deferred: it decides which
 * engine the venue runs on, and a table is not an appointment.
 */

const TRADES = [
  { value: "salon", label: "Salon or spa" },
  { value: "clinic", label: "Clinic or dental practice" },
  { value: "restaurant", label: "Restaurant" },
] as const;

export default function StartForm() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ field?: string; message: string } | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);

    const form = new FormData(event.currentTarget);
    try {
      const res = await fetch("/api/signup", {
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

      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        next?: string;
        field?: string;
        error?: string;
      };

      if (!res.ok || !body.ok) {
        setError({ field: body.field, message: body.error ?? "Something went wrong." });
        setBusy(false);
        return;
      }

      // A full navigation rather than a router push: the session cookie was
      // just set, and every page after this reads it on the server.
      window.location.href = body.next ?? "/setup";
    } catch {
      setError({ message: "Could not reach Belline. Check your connection and try again." });
      setBusy(false);
    }
  }

  const badField = (name: string) => (error?.field === name ? { borderColor: "var(--bad)" } : {});

  return (
    <form onSubmit={submit} style={{ display: "grid", gap: 16 }}>
      <div>
        <label htmlFor="businessName">Business name</label>
        <input
          id="businessName"
          name="businessName"
          type="text"
          required
          maxLength={120}
          autoComplete="organization"
          autoFocus
          placeholder="Marina Hair Studio"
          style={badField("businessName")}
        />
      </div>

      <div>
        <label htmlFor="vertical">What do you do?</label>
        <select id="vertical" name="vertical" defaultValue="salon" style={badField("vertical")}>
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
          style={badField("email")}
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
          style={badField("password")}
        />
        <p className="muted" style={{ fontSize: 11, margin: "7px 0 0" }}>
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

      <button className="btn btn-accent" type="submit" disabled={busy} style={{ padding: "12px 16px" }}>
        {busy ? "Setting you up…" : "Get Belline"}
      </button>

      <p className="muted" style={{ fontSize: 11, margin: 0, textAlign: "center", lineHeight: 1.6 }}>
        Next: paste your website and Belline reads your business off it.
      </p>
    </form>
  );
}

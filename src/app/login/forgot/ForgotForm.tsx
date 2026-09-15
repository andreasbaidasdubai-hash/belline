"use client";

import { useState } from "react";

export default function ForgotForm({ mode, initialEmail }: { mode: "email" | "team"; initialEmail: string }) {
  const [email, setEmail] = useState(initialEmail);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/auth/forgot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      if (!res.ok || !data.message) setError(data.error ?? "That did not go through. Try again.");
      else setDone(data.message);
    } catch {
      setError("Could not reach Belline. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="panel" role="status" style={{ padding: 22, fontSize: 13.5, lineHeight: 1.6 }}>
        {done}
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="panel" style={{ padding: 22 }}>
      <div style={{ marginBottom: 18 }}>
        <label htmlFor="email">Email</label>
        <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" autoFocus required />
        {mode === "team" && (
          <div className="muted" style={{ fontSize: 11.5, marginTop: 6, lineHeight: 1.5 }}>
            The Belline team writes to this address to check it is you, then helps you back in.
          </div>
        )}
      </div>
      {error && (
        <p role="alert" style={{ color: "var(--bad)", fontSize: 12.5, margin: "0 0 14px" }}>
          {error}
        </p>
      )}
      <button type="submit" className="btn btn-accent" disabled={busy} style={{ width: "100%" }}>
        {busy ? "…" : mode === "email" ? "Send me a link" : "Ask for help"}
      </button>
    </form>
  );
}

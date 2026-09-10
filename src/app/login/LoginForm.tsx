"use client";

import { useState } from "react";

export default function LoginForm({ firstRun }: { firstRun: boolean }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(firstRun ? "/api/auth/setup" : "/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, name }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Something went wrong.");
        return;
      }
      // Hard navigation so the server re-renders with the new session.
      window.location.href = "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="panel" style={{ padding: 22 }}>
      {firstRun && (
        <div style={{ marginBottom: 16 }}>
          <label htmlFor="name">Your name</label>
          <input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            required
          />
        </div>
      )}

      <div style={{ marginBottom: 16 }}>
        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete={firstRun ? "email" : "username"}
          autoFocus
          required
        />
      </div>

      <div style={{ marginBottom: 18 }}>
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={firstRun ? "new-password" : "current-password"}
          required
        />
        {firstRun && (
          <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
            At least 10 characters. Use a password manager.
          </div>
        )}
      </div>

      {error && (
        <div
          style={{
            background: "var(--bad-soft)",
            border: "1px solid var(--bad)",
            color: "var(--bad)",
            borderRadius: 9,
            padding: "9px 12px",
            fontSize: 12.5,
            marginBottom: 16,
          }}
        >
          {error}
        </div>
      )}

      <button
        type="submit"
        className="btn btn-accent"
        disabled={busy}
        style={{ width: "100%" }}
      >
        {busy ? "…" : firstRun ? "Create account" : "Sign in"}
      </button>
    </form>
  );
}

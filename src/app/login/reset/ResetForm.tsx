"use client";

import { useState } from "react";
import { PASSWORD_HINT, PASSWORD_MIN_LENGTH, passwordProblem } from "@/lib/signup-rules";

export default function ResetForm({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const problem = passwordProblem(password);
    if (problem) return setError(problem);
    if (password !== again) return setError("The two passwords are not the same.");
    setBusy(true);
    try {
      const res = await fetch("/api/auth/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = (await res.json().catch(() => ({}))) as { next?: string; error?: string; field?: string };
      if (!res.ok) {
        setExpired(data.field === "token");
        setError(data.error ?? "That did not save. Try again.");
        return;
      }
      window.location.href = data.next?.startsWith("/") && !data.next.startsWith("//") ? data.next : "/";
    } catch {
      setError("Could not reach Belline. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="panel" style={{ padding: 22 }}>
      <div style={{ marginBottom: 16 }}>
        <label htmlFor="password">New password</label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          minLength={PASSWORD_MIN_LENGTH}
          autoFocus
          required
        />
        <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
          {PASSWORD_HINT}
        </div>
      </div>
      <div style={{ marginBottom: 18 }}>
        <label htmlFor="again">The same again</label>
        <input id="again" type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" required />
      </div>
      {error && (
        <p role="alert" style={{ color: "var(--bad)", fontSize: 12.5, margin: "0 0 14px" }}>
          {error} {expired && <a href="/login/forgot">Ask for a new link</a>}
        </p>
      )}
      <button type="submit" className="btn btn-accent" disabled={busy} style={{ width: "100%" }}>
        {busy ? "…" : "Save and sign in"}
      </button>
      <p className="muted" style={{ fontSize: 11.5, margin: "12px 0 0", lineHeight: 1.5 }}>
        Saving signs you out on every other device.
      </p>
    </form>
  );
}

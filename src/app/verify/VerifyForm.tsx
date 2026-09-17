"use client";

import { useState } from "react";

type Reply = { ok?: boolean; next?: string; error?: string; message?: string };

async function post(body: Record<string, unknown>): Promise<{ status: number; data: Reply }> {
  try {
    const res = await fetch("/api/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: (await res.json().catch(() => ({}))) as Reply };
  } catch {
    return { status: 0, data: { error: "Could not reach Belline. Check your connection and try again." } };
  }
}

const box = (tone: "bad" | "ok") =>
  ({
    background: tone === "bad" ? "var(--bad-soft)" : "var(--ok-soft, transparent)",
    border: `1px solid var(--${tone})`,
    color: `var(--${tone})`,
    borderRadius: 9,
    padding: "9px 12px",
    fontSize: 12.5,
    marginBottom: 14,
  }) as const;

/** The code, a new code, and a corrected address. */
export default function VerifyForm({ mode, email, initialCode }: { mode: "email" | "team"; email: string; initialCode: string }) {
  const [code, setCode] = useState(initialCode);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [changing, setChanging] = useState(false);
  const [newEmail, setNewEmail] = useState(email);

  async function run(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const { data } = await post(body);
    setBusy(false);
    if (data.error) {
      setError(data.error);
      return;
    }
    if (body.action === "check") {
      window.location.href = data.next?.startsWith("/") && !data.next.startsWith("//") ? data.next : "/setup";
      return;
    }
    if (body.action === "change") {
      // The page shows the address the code went to: reload to show the new one.
      window.location.reload();
      return;
    }
    setNotice(data.message ?? "Done.");
  }

  return (
    <div className="panel" style={{ padding: 22 }}>
      {mode === "email" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run({ action: "check", code });
          }}
        >
          <div style={{ marginBottom: 16 }}>
            <label htmlFor="verify-code">6-digit code</label>
            <input
              id="verify-code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              autoFocus
              required
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "verify-error" : undefined}
              style={{ fontSize: 22, letterSpacing: "0.3em", textAlign: "center" }}
            />
          </div>
          {error && (
            <div id="verify-error" role="alert" style={box("bad")}>
              {error}
            </div>
          )}
          {notice && (
            <div role="status" style={box("ok")}>
              {notice}
            </div>
          )}
          <button type="submit" className="btn btn-accent" disabled={busy || code.length !== 6} style={{ width: "100%" }}>
            {busy ? "…" : "Confirm"}
          </button>
        </form>
      )}

      {mode === "team" && (error || notice) && (
        <div role={error ? "alert" : "status"} style={box(error ? "bad" : "ok")}>
          {error ?? notice}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center", marginTop: 14 }}>
        {mode === "email" && (
          <button type="button" className="btn" disabled={busy} onClick={() => void run({ action: "resend" })}>
            Send a new code
          </button>
        )}
        <button type="button" className="btn" disabled={busy} onClick={() => setChanging((c) => !c)} aria-expanded={changing}>
          Wrong address?
        </button>
      </div>

      {changing && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run({ action: "change", email: newEmail });
          }}
          style={{ marginTop: 16 }}
        >
          <label htmlFor="verify-email">Your email</label>
          <input
            id="verify-email"
            type="email"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            autoComplete="email"
            inputMode="email"
            spellCheck={false}
            maxLength={254}
            required
          />
          <button type="submit" className="btn btn-accent" disabled={busy} style={{ width: "100%", marginTop: 10 }}>
            {mode === "email" ? "Use this address and send a code" : "Use this address"}
          </button>
        </form>
      )}
    </div>
  );
}

"use client";

import { useState } from "react";

/**
 * Two steps, a minute apart: the number, then the code Meta texts to it.
 *
 * Written from the owner's side of the counter. They have a SIM in their hand
 * and a website to put the number on; nothing about Meta, tokens or ids is
 * theirs to know.
 */
export default function ConnectWhatsApp({
  locationId,
  venueName,
  pending,
}: {
  locationId: string;
  venueName: string;
  /** A number already waiting for its code, from an earlier attempt. */
  pending: { number: string; displayName: string } | null;
}) {
  const [step, setStep] = useState<"number" | "code">(pending ? "code" : "number");
  const [number, setNumber] = useState(pending?.number ?? "");
  const [name, setName] = useState(pending?.displayName ?? venueName);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function call(method: "POST" | "PUT" | "PATCH" | "DELETE", body?: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await fetch(
        method === "DELETE" ? `/api/whatsapp/number?locationId=${encodeURIComponent(locationId)}` : "/api/whatsapp/number",
        {
          method,
          headers: { "content-type": "application/json" },
          body: method === "DELETE" ? undefined : JSON.stringify({ locationId, ...body }),
        },
      );
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "That didn't work. Try again in a moment.");
        return false;
      }
      return true;
    } catch {
      setError("That didn't work. Try again in a moment.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (step === "number") {
    return (
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (await call("POST", { number, displayName: name })) setStep("code");
        }}
        style={{ display: "grid", gap: 12, maxWidth: 420, marginTop: 14 }}
      >
        <div>
          <label htmlFor="wa-number">The number Belle should answer</label>
          <input
            id="wa-number"
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            placeholder="+9715XXXXXXXX"
            inputMode="tel"
            required
          />
          <p className="muted" style={{ fontSize: 12, margin: "6px 0 0", lineHeight: 1.5 }}>
            A number that has never been on WhatsApp — a new SIM is the easy way. Keep the SIM to
            hand: Meta texts it a code in the next step, once, and never again.
          </p>
        </div>
        <div>
          <label htmlFor="wa-name">The name shown on WhatsApp</label>
          <input id="wa-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required />
        </div>
        {error && <p style={{ fontSize: 12.5, color: "var(--bad)", margin: 0 }}>{error}</p>}
        <button className="btn btn-accent" type="submit" disabled={busy} style={{ justifySelf: "start" }}>
          {busy ? "Asking Meta…" : "Send me the code"}
        </button>
      </form>
    );
  }

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (await call("PUT", { code })) window.location.reload();
      }}
      style={{ display: "grid", gap: 12, maxWidth: 420, marginTop: 14 }}
    >
      <p style={{ fontSize: 13.5, margin: 0 }}>
        Meta has sent a six-digit code by SMS to <span className="mono">{number}</span>.
      </p>
      <div>
        <label htmlFor="wa-code">The code</label>
        <input
          id="wa-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="123456"
          maxLength={8}
          required
          style={{ maxWidth: 160, fontVariantNumeric: "tabular-nums", letterSpacing: "0.1em" }}
        />
      </div>
      {error && <p style={{ fontSize: 12.5, color: "var(--bad)", margin: 0 }}>{error}</p>}
      {note && <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>{note}</p>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="btn btn-accent" type="submit" disabled={busy}>
          {busy ? "Checking…" : "Connect"}
        </button>
        <button
          className="btn"
          type="button"
          disabled={busy}
          onClick={async () => {
            if (await call("PATCH", { method: "SMS" })) setNote("Sent again.");
          }}
        >
          Send it again
        </button>
        <button
          className="btn"
          type="button"
          disabled={busy}
          onClick={async () => {
            if (await call("PATCH", { method: "VOICE" })) setNote("Meta will ring the number and read the code out.");
          }}
        >
          Ring me instead
        </button>
        <button
          className="btn"
          type="button"
          disabled={busy}
          onClick={async () => {
            if (await call("DELETE")) {
              setStep("number");
              setCode("");
            }
          }}
        >
          Use a different number
        </button>
      </div>
    </form>
  );
}

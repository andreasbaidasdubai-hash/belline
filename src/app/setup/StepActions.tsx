"use client";

import { useState } from "react";

/**
 * The buttons on the setup steps that are not a form.
 *
 * Each sends one action to /api/setup/journey and follows the step the server
 * says is next. The server re-checks everything, Go live included, so these
 * are conveniences, not the gate.
 */

async function send(body: Record<string, unknown>): Promise<{ next?: string; error?: string; fix?: string }> {
  try {
    const res = await fetch("/api/setup/journey", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { next?: string; error?: string; fix?: string };
    if (!res.ok) return { error: data.error ?? "That did not save. Try again.", fix: data.fix };
    return { next: data.next };
  } catch {
    return { error: "Could not reach Belline. Check your connection and try again." };
  }
}

function go(next: string | undefined) {
  window.location.href = next?.startsWith("/") && !next.startsWith("//") ? next : "/setup";
}

function Problem({ error, fix }: { error: string | null; fix?: string }) {
  if (!error) return null;
  return (
    <p role="alert" style={{ fontSize: 13.5, color: "var(--bad)", margin: "12px 0 0" }}>
      {error} {fix && <a href={fix}>Fix this</a>}
    </p>
  );
}

export function ActionButton({ action, label }: { action: "rules" | "activate"; label: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fix, setFix] = useState<string | undefined>();

  async function run() {
    setBusy(true);
    setError(null);
    const out = await send({ action });
    if (out.error) {
      setError(out.error);
      setFix(out.fix);
      setBusy(false);
      return;
    }
    go(out.next);
  }

  return (
    <div>
      <button type="button" className="btn btn-accent" onClick={run} disabled={busy} style={{ padding: "12px 22px" }}>
        {busy ? "Saving…" : label}
      </button>
      <Problem error={error} fix={fix} />
    </div>
  );
}

export interface DestinationOption {
  kind: string;
  title: string;
  body: string;
  state: "available" | "preparing" | "soon";
}

const STATE_LABEL: Record<DestinationOption["state"], string> = {
  available: "Available",
  preparing: "Being prepared",
  soon: "Coming soon",
};

export function DestinationPicker({ options, current }: { options: DestinationOption[]; current?: string }) {
  const firstAvailable = options.find((o) => o.state === "available")?.kind ?? "";
  const [chosen, setChosen] = useState(current && options.some((o) => o.kind === current && o.state === "available") ? current : firstAvailable);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    const out = await send({ action: "destination", destination: chosen });
    if (out.error) {
      setError(out.error);
      setBusy(false);
      return;
    }
    go(out.next);
  }

  return (
    <div>
      <button type="button" className="btn btn-accent" onClick={run} disabled={busy || !chosen} style={{ padding: "12px 22px" }}>
        {busy ? "Saving…" : "Use this"}
      </button>
      <Problem error={error} />

      <fieldset style={{ border: 0, padding: 0, margin: "22px 0 0", display: "grid", gap: 10 }}>
        <legend className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>
          Where Belline puts a booking
        </legend>
        {options.map((o) => {
          const open = o.state === "available";
          return (
            <label
              key={o.kind}
              style={{
                display: "flex",
                gap: 12,
                alignItems: "flex-start",
                padding: "14px 16px",
                border: `1px solid ${chosen === o.kind ? "var(--accent)" : "var(--border)"}`,
                borderRadius: 12,
                background: "var(--panel)",
                textTransform: "none",
                letterSpacing: 0,
                opacity: open ? 1 : 0.72,
                cursor: open ? "pointer" : "default",
              }}
            >
              <input
                type="radio"
                name="destination"
                value={o.kind}
                checked={chosen === o.kind}
                disabled={!open}
                onChange={() => setChosen(o.kind)}
                style={{ width: "auto", marginTop: 3 }}
              />
              <span style={{ display: "grid", gap: 4 }}>
                <span style={{ fontSize: 14.5, fontWeight: 600 }}>
                  {o.title}{" "}
                  <span className="pill" style={{ fontWeight: 400, marginLeft: 6 }}>
                    {STATE_LABEL[o.state]}
                  </span>
                </span>
                <span className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
                  {o.body}
                </span>
              </span>
            </label>
          );
        })}
      </fieldset>
    </div>
  );
}

"use client";

import { useState } from "react";

/**
 * "Is it on my website?" — answered by looking.
 *
 * The owner pastes their site's address; we fetch it, find which builder it
 * runs on, show that builder's exact steps, and say yes or no to whether the
 * snippet is live.
 */

interface Result {
  installed: boolean;
  platform: string | null;
  reason?: string;
  steps: { name: string; steps: string[]; note?: string };
}

export default function InstallCheck({ locationId }: { locationId: string }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function check(event: React.FormEvent) {
    event.preventDefault();
    if (!url.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/website/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locationId, url }),
      });
      const body = (await res.json().catch(() => ({}))) as Result & { error?: string };
      if (!res.ok) setError(body.error ?? "Could not check that site.");
      else setResult(body);
    } catch {
      setError("Could not reach Belline.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel" style={{ marginTop: 14 }}>
      <div className="panel-head">Put it on your website</div>
      <div style={{ padding: "14px 18px 18px" }}>
        <p className="muted" style={{ margin: "0 0 12px", fontSize: 13, lineHeight: 1.6 }}>
          Paste your website address. We will tell you exactly where the snippet goes for your website builder,
          and check whether it is live.
        </p>
        <form onSubmit={check} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://yourbusiness.ae"
            aria-label="Your website address"
            style={{ flex: "1 1 260px" }}
          />
          <button className="btn btn-accent" type="submit" disabled={busy || !url.trim()}>
            {busy ? "Checking…" : "Check my site"}
          </button>
        </form>
        {error && <p role="alert" style={{ color: "var(--bad)", fontSize: 12.5, margin: "10px 0 0" }}>{error}</p>}
        {result && (
          <div style={{ marginTop: 16 }}>
            <p style={{ margin: "0 0 10px", fontSize: 14, fontWeight: 600, color: result.installed ? "var(--ok)" : "var(--text)" }}>
              {result.installed ? "✓ Live on your site." : result.reason ?? "Not on that page yet."}
            </p>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
              {result.platform && result.platform !== "custom" ? `Built with ${result.steps.name}` : result.steps.name}
            </div>
            <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 1.7, color: "var(--text-2)" }}>
              {result.steps.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
            {result.steps.note && (
              <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
                {result.steps.note}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

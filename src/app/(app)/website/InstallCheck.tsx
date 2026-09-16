"use client";

import { useEffect, useState } from "react";

/**
 * "Is it on my website?" — answered without being asked.
 *
 * While this page is open it checks every 20 seconds. The widget reports
 * itself the moment it loads on one of the venue's sites, so an owner who
 * pastes the snippet and opens their site sees this flip to installed without
 * pressing anything. Checking a particular page by hand is still here, and
 * shows that builder's exact steps.
 */

interface Result {
  installed: boolean;
  platform: string | null;
  reason?: string;
  steps: { name: string; steps: string[]; note?: string };
}

export default function InstallCheck({ locationId, detectedAt: initialDetected }: { locationId: string; detectedAt: string | null }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detectedAt, setDetectedAt] = useState(initialDetected);

  useEffect(() => {
    if (detectedAt) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/embed/status?locationId=${encodeURIComponent(locationId)}`);
        const body = (await res.json().catch(() => ({}))) as { detectedAt?: string | null };
        if (body.detectedAt) setDetectedAt(body.detectedAt);
      } catch {
        /* the next tick tries again */
      }
    }, 20_000);
    return () => clearInterval(timer);
  }, [detectedAt, locationId]);

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
      <div className="panel-head">Is it on your website?</div>
      <div style={{ padding: "14px 18px 18px" }}>
        <p role="status" style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 600, color: detectedAt ? "var(--ok)" : "var(--text)" }}>
          {detectedAt
            ? "✓ Installed. The widget has loaded on your website."
            : "Waiting for the widget to load on your website. This updates by itself once it does."}
        </p>
        <p className="muted" style={{ margin: "0 0 12px", fontSize: 13, lineHeight: 1.6 }}>
          To check one page now, paste its address. We will also say which website builder it uses.
        </p>
        <form onSubmit={check} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://yourbusiness.ae"
            aria-label="Page to check for the widget"
            style={{ flex: "1 1 260px" }}
          />
          <button className="btn" type="submit" disabled={busy || !url.trim()}>
            {busy ? "Checking…" : "Check this page"}
          </button>
        </form>
        {error && <p role="alert" style={{ color: "var(--bad)", fontSize: 12.5, margin: "10px 0 0" }}>{error}</p>}
        {result && (
          <div style={{ marginTop: 16 }}>
            <p style={{ margin: "0 0 10px", fontSize: 14, fontWeight: 600, color: result.installed ? "var(--ok)" : "var(--text)" }}>
              {result.installed ? "✓ Live on that page." : result.reason ?? "Not on that page yet."}
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

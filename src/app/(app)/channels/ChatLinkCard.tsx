"use client";

import { useState } from "react";

/**
 * The chat link, with one button to make it and one to copy it. Used on the
 * channels setup step and the Channels screen.
 */
export default function ChatLinkCard({ locationId, url: initialUrl, live }: { locationId: string; url: string | null; live: boolean }) {
  const [url, setUrl] = useState(initialUrl);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  async function create() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/chat-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locationId }),
      });
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !data.url) setError(data.error ?? "That did not work. Try again in a moment.");
      else setUrl(data.url);
    } catch {
      setError("Could not reach Belline. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setError("Copy did not work here. Select the link and copy it by hand.");
    }
  }

  const button = { padding: "8px 14px", fontSize: 13.5 } as const;

  if (!url) {
    return (
      <div style={{ marginTop: 10 }}>
        <button type="button" className="btn btn-accent" onClick={create} disabled={busy} style={button} data-testid="create-chat-link">
          {busy ? "Making it…" : "Make my chat link"}
        </button>
        {error && (
          <p role="alert" style={{ fontSize: 13, color: "var(--bad)", margin: "6px 0 0" }}>
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input
          readOnly
          value={url}
          aria-label="Your Belline chat link"
          onFocus={(e) => e.currentTarget.select()}
          className="mono"
          style={{ flex: "1 1 220px", minWidth: 0, fontSize: 13 }}
          data-testid="chat-link-url"
        />
        <button type="button" className="btn btn-accent" onClick={copy} style={button}>
          {copied ? "Copied" : "Copy link"}
        </button>
      </div>
      <p role="status" style={{ fontSize: 12.5, lineHeight: 1.5, margin: "6px 0 0" }}>
        {live
          ? "Live: anybody with the link can message Belline."
          : "Not answering yet: until you go live, anybody who opens it sees only that the chat is not available."}
      </p>
      {error && (
        <p role="alert" style={{ fontSize: 13, color: "var(--bad)", margin: "6px 0 0" }}>
          {error}
        </p>
      )}
    </div>
  );
}

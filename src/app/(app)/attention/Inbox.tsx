"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { AttentionItem, AttentionKind } from "@/lib/attention";

/**
 * The Action Inbox.
 *
 * Read between patients or mid-service, so it is a list you clear rather than
 * a page you study: who rang, what they wanted, what to do, done. The call is
 * one tap away for anyone who wants the detail, and most of the time nobody
 * does.
 */

const TONE: Record<AttentionKind, { border: string; ink: string; wash: string }> = {
  waitlist_match: { border: "var(--ok)", ink: "var(--ok)", wash: "var(--ok-soft)" },
  escalated: { border: "var(--bad)", ink: "var(--bad)", wash: "var(--bad-soft)" },
  transferred: { border: "var(--warn)", ink: "var(--warn)", wash: "var(--warn-soft)" },
  message: { border: "var(--gold-ink)", ink: "var(--gold-ink)", wash: "var(--panel-2)" },
  booking_failed: { border: "var(--warn)", ink: "var(--warn)", wash: "var(--warn-soft)" },
  abandoned: { border: "var(--border)", ink: "var(--muted)", wash: "var(--panel-2)" },
};

function when(at: string): string {
  const mins = Math.round((Date.now() - new Date(at).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export default function Inbox({
  items,
  labels,
}: {
  items: AttentionItem[];
  labels: Record<AttentionKind, string>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function resolve(item: AttentionItem) {
    const key = item.callId ?? item.entryId!;
    setBusy(key);
    setError(null);
    try {
      const res = await fetch("/api/attention", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callId: item.callId, entryId: item.entryId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? `Could not clear that (${res.status}).`);
        return;
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  if (items.length === 0) {
    return (
      <div className="panel" style={{ padding: "44px 24px", textAlign: "center" }}>
        <div style={{ fontSize: 30, lineHeight: 1 }} aria-hidden="true">
          ✓
        </div>
        <p style={{ fontWeight: 600, margin: "14px 0 4px", fontSize: 15 }}>Nothing needs you.</p>
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>
          Every call has been handled, or already cleared. This is the normal state —
          it is the exceptions that land here.
        </p>
      </div>
    );
  }

  return (
    <>
      {error && (
        <div
          style={{
            background: "var(--bad-soft)",
            border: "1px solid var(--bad)",
            color: "var(--bad)",
            borderRadius: 10,
            padding: "10px 14px",
            fontSize: 13,
            marginBottom: 14,
          }}
        >
          {error}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {items.map((item) => {
          const tone = TONE[item.kind];
          return (
            <article
              key={item.callId ?? item.entryId}
              className="panel"
              style={{ borderLeft: `3px solid ${tone.border}`, padding: "15px 17px" }}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                <span
                  className="pill"
                  style={{ background: tone.wash, color: tone.ink, borderColor: tone.border }}
                >
                  {labels[item.kind]}
                </span>
                <strong style={{ fontSize: 14.5 }}>{item.who}</strong>
                <span className="muted" style={{ fontSize: 12, marginLeft: "auto" }}>
                  {when(item.at)}
                </span>
              </div>

              <p style={{ margin: "10px 0 0", fontSize: 13.5, lineHeight: 1.5 }}>{item.what}</p>
              <p className="muted" style={{ margin: "6px 0 0", fontSize: 12.5, lineHeight: 1.5 }}>
                {item.why}
              </p>
              <p
                style={{
                  margin: "10px 0 0",
                  fontSize: 13,
                  fontWeight: 600,
                  color: tone.ink,
                }}
              >
                {item.todo}
              </p>

              <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
                <button
                  className="btn btn-accent"
                  onClick={() => resolve(item)}
                  disabled={busy === (item.callId ?? item.entryId)}
                >
                  {busy === (item.callId ?? item.entryId) ? "…" : "Done"}
                </button>
                {item.callbackNumber && item.callbackNumber !== "Unknown caller" && (
                  <a className="btn" href={`tel:${item.callbackNumber.replace(/\s/g, "")}`}>
                    Call {item.callbackNumber}
                  </a>
                )}
                {item.callId && (
                  <Link className="btn" href={`/calls/${item.callId}`}>
                    Read the call
                  </Link>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}

"use client";

import { useState } from "react";

export interface VersionRow {
  number: number;
  by: string;
  at: string;
  note: string;
  revertedFrom?: number;
}

/**
 * Every published version of this venue, newest first, with a way back.
 *
 * Reverting writes a *new* version that matches the old one, so the history
 * is never rewritten — undoing a mistake is itself an event worth keeping.
 */
export default function VersionHistory({ locationId, versions }: { locationId: string; versions: VersionRow[] }) {
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function revert(number: number) {
    if (!window.confirm(`Put the venue back to version ${number}? The next call will use it.`)) return;
    setBusy(number);
    setError(null);
    try {
      const res = await fetch("/api/venue/revert", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locationId, number }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "That didn't work.");
        return;
      }
      window.location.reload();
    } catch {
      setError("That didn't work.");
    } finally {
      setBusy(null);
    }
  }

  if (versions.length === 0) return null;

  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <div className="panel-head">
        History
        <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>
          every change, and a way back to any of them
        </span>
      </div>
      {error && <p style={{ margin: "10px 18px 0", fontSize: 12.5, color: "var(--bad)" }}>{error}</p>}
      <div className="table-wrap" tabIndex={0}>
        <table>
          <tbody>
            {versions.map((v, i) => (
              <tr key={v.number}>
                <td className="mono" style={{ width: 70, color: "var(--gold-ink)" }}>
                  v{v.number}
                </td>
                <td>
                  <div style={{ fontWeight: i === 0 ? 600 : 400 }}>
                    {v.note || "Published"}
                    {v.revertedFrom ? (
                      <span className="muted"> — back to v{v.revertedFrom}</span>
                    ) : null}
                    {i === 0 && <span className="pill" style={{ marginLeft: 8 }}>live</span>}
                  </div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {v.by} ·{" "}
                    {new Date(v.at).toLocaleString("en-GB", {
                      day: "numeric",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </div>
                </td>
                <td style={{ width: 130, textAlign: "right" }}>
                  {i > 0 && (
                    <button className="btn btn-row" onClick={() => revert(v.number)} disabled={busy !== null}>
                      {busy === v.number ? "Reverting…" : "Go back to this"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

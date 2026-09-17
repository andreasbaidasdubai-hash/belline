"use client";

import { useState } from "react";
import type { SelftestResult } from "@/lib/types";
import { SkipLink } from "./StepActions";

/**
 * The checks step: the automatic checks.
 *
 * One button, then a row per check. While they run every row says so; when
 * they finish each shows a tick, or the question, Belline's exact reply, the
 * likely cause, and the two ways to fix it. Nothing here decides anything: the
 * server grades, records and gates.
 */

const primary = { padding: "12px 22px", display: "inline-block" } as const;

export default function SelftestPanel({
  checks,
  initial,
  stale,
  available,
  done,
  next,
  skipHref,
}: {
  /** Before the checks pass: where "Skip for now" goes. */
  skipHref?: string;
  checks: { id: string; title: string }[];
  initial: SelftestResult[] | null;
  /** The last run is from before a change to the setup. */
  stale: boolean;
  /** A model is configured, so the checks can run. */
  available: boolean;
  /** The step is done: the checks passed and still match the setup. */
  done: boolean;
  next: string | null;
}) {
  const [results, setResults] = useState<SelftestResult[] | null>(initial);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passed, setPassed] = useState(done);
  const [isStale, setStale] = useState(stale);
  const [onward, setOnward] = useState(next);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/setup/selftest", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const body = (await res.json().catch(() => ({}))) as { results?: SelftestResult[]; passed?: boolean; next?: string; error?: string };
      if (!res.ok || !body.results) {
        setError(body.error ?? "The checks did not run. Try again.");
      } else {
        setResults(body.results);
        setPassed(Boolean(body.passed));
        setStale(false);
        setOnward(body.next ?? null);
      }
    } catch {
      setError("Could not reach Belline. Check your connection and try again.");
    } finally {
      setRunning(false);
    }
  }

  const failed = results?.filter((r) => !r.passed).length ?? 0;

  return (
    <div>
      {!available ? (
        <p role="status" className="panel" style={{ padding: "12px 16px", fontSize: 14, lineHeight: 1.55, margin: 0 }}>
          The automatic checks are being prepared. The Belline team has been told, and nothing is needed from you.
        </p>
      ) : passed && !running && onward ? (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <a href={onward} className="btn btn-accent" style={primary}>
            Continue
          </a>
          <button type="button" className="btn" onClick={run} style={{ padding: "12px 18px" }}>
            Run the checks again
          </button>
        </div>
      ) : (
        <button type="button" className="btn btn-accent" onClick={run} disabled={running} style={primary} data-testid="run-checks">
          {running ? "Checking…" : results ? "Run the checks again" : "Run the checks"}
        </button>
      )}

      {isStale && !running && (
        <p role="status" style={{ fontSize: 13.5, margin: "12px 0 0" }}>
          You changed your setup after the last checks, so they need to run again.
        </p>
      )}
      {error && (
        <p role="alert" style={{ fontSize: 13.5, color: "var(--bad)", margin: "12px 0 0" }}>
          {error}
        </p>
      )}
      {results && !running && (
        <p role="status" style={{ fontSize: 14, margin: "14px 0 0" }}>
          {failed === 0 ? "Every check passed." : `${failed} of ${results.length} checks did not pass.`}
        </p>
      )}

      <ol style={{ listStyle: "none", margin: "16px 0 0", padding: 0, display: "grid", gap: 10 }} aria-live="polite">
        {checks.map((c) => {
          const r = running ? undefined : results?.find((x) => x.scenario === c.id);
          const mark = running ? "…" : !r ? "·" : r.passed ? "✓" : "✗";
          return (
            <li key={c.id} className="panel" style={{ padding: "12px 16px" }} data-check={c.id} data-passed={r ? String(r.passed) : undefined}>
              <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
                <span aria-hidden="true" style={{ width: 16, color: r?.passed ? "var(--ok)" : r ? "var(--bad)" : "var(--text-2)" }}>
                  {mark}
                </span>
                <strong style={{ fontSize: 14 }}>{c.title}</strong>
                <span className="sr-only">{running ? " (checking)" : !r ? "" : r.passed ? " (passed)" : " (did not pass)"}</span>
              </div>
              {r && !r.passed && (
                <div style={{ fontSize: 13.5, lineHeight: 1.55, marginTop: 8, paddingLeft: 26 }}>
                  {r.prompt && (
                    <p style={{ margin: "0 0 4px" }}>
                      <span className="muted">We asked:</span> {r.prompt}
                    </p>
                  )}
                  <p style={{ margin: "0 0 4px" }}>
                    <span className="muted">Belline replied:</span> {r.reply ? `“${r.reply}”` : "nothing"}
                  </p>
                  {r.detail && <p style={{ margin: "0 0 8px" }}>{r.detail}</p>}
                  <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                    {r.fix && <a href={r.fix.includes("?") || r.fix.startsWith("/setup/") ? r.fix : `${r.fix}?from=setup`}>Fix this</a>}
                    <a href={`/setup/assistant?step=test&check=${encodeURIComponent(r.scenario)}`}>Fix with Belle</a>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {/* The same button again under the eight checks, beside Skip for now. */}
      {available && (
        <div className="setup-footer">
          {passed && !running && onward ? (
            <a href={onward} className="btn btn-accent" style={primary}>
              Continue
            </a>
          ) : (
            <button type="button" className="btn btn-accent" onClick={run} disabled={running} style={primary}>
              {running ? "Checking…" : results ? "Run the checks again" : "Run the checks"}
            </button>
          )}
          {skipHref && !passed && <SkipLink href={skipHref} />}
        </div>
      )}
    </div>
  );
}

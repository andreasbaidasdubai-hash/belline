"use client";

import { useState } from "react";
import type { EmbedMode } from "@/lib/types";

/**
 * Switching the website widget on, and saying what it offers.
 *
 * Three decisions on one screen, in the order somebody actually makes them:
 * what it should offer, where it is allowed to appear, and then the line to
 * paste. The snippet is last and only exists once it is on — handing somebody
 * a line of HTML before the thing works is how you get it pasted, broken, and
 * blamed.
 *
 * The origins field is the one that carries the security of the whole feature,
 * so it is a plain text box rather than a tag editor: people paste a domain,
 * and the most common way a widget silently fails is an allowlist that looks
 * full and contains a typo. Everything typed is shown back normalised after
 * saving, so a typo is visible rather than inferred.
 */

const MODES: { id: EmbedMode; title: string; what: string; costs: string }[] = [
  {
    id: "both",
    title: "Both",
    what: "A bell and a message button. The visitor picks.",
    costs: "Most sites want this. Neither button costs anything until somebody uses it.",
  },
  {
    id: "voice",
    title: "Talking only",
    what: "A bell. Tapping it starts a real conversation, out loud.",
    costs: "Uses voice minutes from your plan, the same as a phone call.",
  },
  {
    id: "chat",
    title: "Messages only",
    what: "A message button. The visitor types; Belline writes back.",
    costs: "No voice minutes. For visitors who will not talk out loud on a train or at a desk.",
  },
];

export default function WidgetEditor({
  locationId,
  enabled,
  mode,
  origins,
  snippet,
  offering,
  used,
  limits,
  minutesCount,
}: {
  locationId: string;
  enabled: boolean;
  mode: EmbedMode;
  origins: string[];
  snippet: string;
  offering: { voice: boolean; chat: boolean };
  used: { voice: number; chat: number };
  limits: { voice: number; chat: number };
  /** Whether voice here comes out of a paid allowance. Changes what we warn about. */
  minutesCount: boolean;
}) {
  const [pick, setPick] = useState<EmbedMode>(mode);
  const [sites, setSites] = useState(origins.join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function save(next: { enabled: boolean }) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/embed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          locationId,
          enabled: next.enabled,
          mode: pick,
          origins: sites
            .split(/[\n,]/)
            .map((s) => s.trim())
            .filter(Boolean),
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "That didn't save. Try again in a moment.");
        return;
      }
      // A full reload rather than patching state: the snippet, the key and the
      // day's usage are all rendered on the server, and a half-updated screen
      // about a public endpoint is worse than a second of waiting.
      window.location.reload();
    } catch {
      setError("That didn't save. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard refused — an insecure context, or a browser that asks. The
      // snippet is on screen and selectable, which is the fallback.
      setError("Couldn't copy it. Select the line and copy it by hand.");
    }
  }

  return (
    <>
      {error && (
        <div
          className="panel"
          style={{
            padding: "12px 16px",
            marginBottom: 14,
            background: "var(--bad-soft)",
            borderColor: "var(--bad)",
            color: "var(--bad)",
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      {/* Is it on, and what has it done today. */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            aria-hidden="true"
            style={{
              width: 8,
              height: 8,
              borderRadius: 999,
              background: enabled ? "var(--ok)" : "var(--muted)",
            }}
          />
          {enabled ? "On" : "Off"}
          {enabled && (
            <span className="muted" style={{ fontWeight: 400 }}>
              {offering.voice && offering.chat
                ? " · talking and messages"
                : offering.chat
                  ? " · messages"
                  : " · talking"}
            </span>
          )}
        </div>

        <div style={{ padding: 18 }}>
          {enabled ? (
            <>
              <div className="widget-used">
                {offering.voice && (
                  <div>
                    <strong>
                      {used.voice} <span>of {limits.voice}</span>
                    </strong>
                    <span className="muted">conversations today, by voice</span>
                  </div>
                )}
                {offering.chat && (
                  <div>
                    <strong>
                      {used.chat} <span>of {limits.chat}</span>
                    </strong>
                    <span className="muted">message threads today</span>
                  </div>
                )}
              </div>
              <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.6, margin: "14px 0 0" }}>
                A daily ceiling, so an unattended tab on a slow afternoon cannot
                run up a bill. Past it, visitors are asked to ring you instead.
                {minutesCount && offering.voice
                  ? " Spoken conversations come out of your plan's voice minutes; messages do not."
                  : ""}
              </p>
              <button
                className="btn btn-danger"
                style={{ marginTop: 16 }}
                onClick={() => save({ enabled: false })}
                disabled={busy}
              >
                Switch it off
              </button>
            </>
          ) : (
            <p className="muted" style={{ fontSize: 13.5, lineHeight: 1.65, margin: 0, maxWidth: "62ch" }}>
              Nothing appears on your website yet. Choose what it should offer,
              name the sites it may appear on, and you will get one line of HTML
              to paste.
            </p>
          )}
        </div>
      </div>

      {/* What it offers. */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">What it offers</div>
        <div style={{ padding: 18 }}>
          <div className="widget-modes" role="radiogroup" aria-label="What the widget offers">
            {MODES.map((m) => {
              const on = pick === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  className={`widget-mode${on ? " is-on" : ""}`}
                  onClick={() => setPick(m.id)}
                >
                  <strong>{m.title}</strong>
                  <span>{m.what}</span>
                  <em>{m.costs}</em>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Where it may appear. */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">Which websites</div>
        <div style={{ padding: 18 }}>
          <label htmlFor="widget-origins">Your website addresses</label>
          <textarea
            id="widget-origins"
            rows={3}
            value={sites}
            onChange={(e) => setSites(e.target.value)}
            placeholder={"marinahair.ae\nwww.marinahair.ae"}
            spellCheck={false}
            style={{ fontFamily: "inherit" }}
          />
          <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.6, margin: "10px 0 0", maxWidth: "62ch" }}>
            One per line. Belline will only open on the sites you name here, and
            will refuse anywhere else — this is what stops somebody copying your
            line of HTML onto their own site and spending your minutes.
            {" "}
            <strong style={{ fontWeight: 500 }}>marinahair.ae</strong> and
            {" "}
            <strong style={{ fontWeight: 500 }}>www.marinahair.ae</strong> count
            as the same site; a staging address does not, so add that too if you
            test there.
          </p>

          <button
            className="btn btn-accent"
            style={{ marginTop: 16 }}
            onClick={() => save({ enabled: true })}
            disabled={busy}
          >
            {busy ? "Saving…" : enabled ? "Save changes" : "Switch it on"}
          </button>
        </div>
      </div>

      {/* The line to paste — only once there is something to paste. */}
      {enabled && snippet && (
        <div className="panel">
          <div className="panel-head">The line to paste</div>
          <div style={{ padding: 18 }}>
            <p className="muted" style={{ fontSize: 13.5, lineHeight: 1.65, margin: "0 0 14px", maxWidth: "62ch" }}>
              Paste this once, just before the closing <code>&lt;/body&gt;</code>{" "}
              tag of your website. On Squarespace, Wix or WordPress it goes in
              the footer or custom-code box. Nothing to install, and it will not
              slow your site down.
            </p>
            <pre className="widget-snippet mono">{snippet}</pre>
            <button className="btn" style={{ marginTop: 12 }} onClick={copy} disabled={busy}>
              {copied ? "Copied" : "Copy the line"}
            </button>
            <p className="muted" style={{ fontSize: 12.5, margin: "14px 0 0" }}>
              The key in that line is public, like a payment provider&rsquo;s. It
              is not a password — the list of websites above is what protects
              you, which is why it is not optional.
            </p>
          </div>
        </div>
      )}
    </>
  );
}

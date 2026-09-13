"use client";

import { useState } from "react";
import type { EmbedAppearance, EmbedMode } from "@/lib/types";
import { APPEARANCE_RULES, EMBED_PALETTE, accentHex, contrastRatio, textOn } from "@/lib/embed-look";

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
  appearance,
  whatsappNumber,
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
  appearance: EmbedAppearance;
  /** The venue's WhatsApp number, if Belle answers one — the third button. */
  whatsappNumber: string | null;
}) {
  const [pick, setPick] = useState<EmbedMode>(mode);
  const [sites, setSites] = useState(origins.join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [look, setLook] = useState<EmbedAppearance>(appearance);
  const [customHex, setCustomHex] = useState(
    appearance.accent && !EMBED_PALETTE[appearance.accent] ? appearance.accent : "",
  );

  // What the buttons will look like, resolved the way the widget resolves it.
  const accent = accentHex(look.accent) ?? EMBED_PALETTE.ink;
  const accentText = textOn(accent);
  const accentMark = accentText === "#FBF9F5" ? "#E8DCC6" : "#8A672E";
  const contrast = Math.max(contrastRatio(accent, "#FBF9F5"), contrastRatio(accent, "#14110D"));
  const tooPale = contrast < APPEARANCE_RULES.minContrast;

  function setLabel(field: "voiceLabel" | "chatLabel" | "whatsappLabel", value: string) {
    setLook((prev) => ({ ...prev, [field]: value.slice(0, APPEARANCE_RULES.labelMaxChars) }));
  }

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
          appearance: look,
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

      {/* How it looks. The venue's words and colour; the mark stays ours. */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          How it looks
          <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>
            your words, your colour — the bell stays
          </span>
        </div>
        <div style={{ padding: 18, display: "grid", gap: 18, gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }} className="widget-look">
          <div style={{ display: "grid", gap: 14 }}>
            {(
              [
                ["voiceLabel", "The bell says", "Talk to us", pick !== "chat"],
                ["chatLabel", "The message button says", "Chat with us", pick !== "voice"],
                ["whatsappLabel", "The WhatsApp button says", "WhatsApp us", Boolean(whatsappNumber)],
              ] as const
            )
              .filter(([, , , shown]) => shown)
              .map(([field, label, placeholder]) => (
                <div key={field}>
                  <label htmlFor={`look-${field}`}>{label}</label>
                  <input
                    id={`look-${field}`}
                    value={look[field] ?? ""}
                    placeholder={placeholder}
                    maxLength={APPEARANCE_RULES.labelMaxChars}
                    onChange={(e) => setLabel(field, e.target.value)}
                  />
                  <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>
                    {(look[field] ?? "").length}/{APPEARANCE_RULES.labelMaxChars} — a button, not a sentence
                  </div>
                </div>
              ))}

            <div>
              <label>Colour of the main button</label>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                {Object.entries(EMBED_PALETTE).map(([name, hex]) => {
                  const on = (look.accent ?? "ink") === name;
                  return (
                    <button
                      key={name}
                      type="button"
                      aria-label={name}
                      aria-pressed={on}
                      title={name}
                      onClick={() => {
                        setCustomHex("");
                        setLook((prev) => ({ ...prev, accent: name }));
                      }}
                      style={{
                        width: 34,
                        height: 34,
                        borderRadius: 999,
                        background: hex,
                        border: on ? "3px solid var(--text)" : "3px solid transparent",
                        boxShadow: "0 0 0 1px var(--border)",
                        cursor: "pointer",
                      }}
                    />
                  );
                })}
                <input
                  value={customHex}
                  placeholder="#2F4A3A"
                  aria-label="Your own colour, as a hex"
                  maxLength={7}
                  style={{ maxWidth: 110, fontFamily: "var(--mono, ui-monospace, monospace)" }}
                  onChange={(e) => {
                    const v = e.target.value.trim();
                    setCustomHex(v);
                    if (/^#[0-9a-f]{6}$/i.test(v)) setLook((prev) => ({ ...prev, accent: v.toUpperCase() }));
                  }}
                />
              </div>
              <div style={{ fontSize: 11.5, marginTop: 6, color: tooPale ? "var(--bad)" : "var(--muted)" }}>
                {tooPale
                  ? "Not enough contrast for the words to be read. Try a deeper or a lighter shade."
                  : `Words in ${accentText === "#FBF9F5" ? "paper" : "ink"} on it — ${contrast.toFixed(1)}:1, readable.`}
              </div>
            </div>

            <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
              <div>
                <label>Shape</label>
                <div className="plan-switch" role="group" aria-label="Shape">
                  {(["pill", "round"] as const).map((s) => (
                    <a
                      key={s}
                      href="#"
                      className={(look.shape ?? "pill") === s ? "is-on" : ""}
                      onClick={(e) => {
                        e.preventDefault();
                        setLook((prev) => ({ ...prev, shape: s }));
                      }}
                    >
                      <span>{s === "pill" ? "Pill with words" : "Round, mark only"}</span>
                    </a>
                  ))}
                </div>
              </div>
              <div>
                <label>Corner</label>
                <div className="plan-switch" role="group" aria-label="Corner">
                  {(["right", "left"] as const).map((c) => (
                    <a
                      key={c}
                      href="#"
                      className={(look.corner ?? "right") === c ? "is-on" : ""}
                      onClick={(e) => {
                        e.preventDefault();
                        setLook((prev) => ({ ...prev, corner: c }));
                      }}
                    >
                      <span>{c === "right" ? "Bottom right" : "Bottom left"}</span>
                    </a>
                  ))}
                </div>
              </div>
            </div>

            {whatsappNumber && (
              <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13.5 }}>
                <input
                  type="checkbox"
                  checked={look.whatsapp ?? true}
                  onChange={(e) => setLook((prev) => ({ ...prev, whatsapp: e.target.checked }))}
                  style={{ width: 22, height: 22, margin: 0, accentColor: "var(--accent)" }}
                />
                Show a WhatsApp button for {whatsappNumber}
              </label>
            )}
          </div>

          {/* The preview: the buttons exactly as the widget will draw them. */}
          <div
            aria-label="Preview"
            style={{
              borderRadius: 12,
              border: "1px solid var(--border)",
              background: "repeating-linear-gradient(45deg, var(--panel-2) 0 10px, var(--panel) 10px 20px)",
              minHeight: 260,
              position: "relative",
            }}
          >
            <div
              style={{
                position: "absolute",
                bottom: 18,
                [(look.corner ?? "right") === "left" ? "left" : "right"]: 18,
                display: "flex",
                flexDirection: "column",
                alignItems: (look.corner ?? "right") === "left" ? "flex-start" : "flex-end",
                gap: 10,
              }}
            >
              {whatsappNumber && (look.whatsapp ?? true) && (
                <PreviewFab label={look.whatsappLabel || "WhatsApp us"} round={look.shape === "round"} quiet mark="wa" />
              )}
              {pick !== "voice" && (
                <PreviewFab label={look.chatLabel || "Chat with us"} round={look.shape === "round"} quiet={pick === "both"} mark="bubble" accent={pick === "chat" ? { bg: accent, fg: accentText, mark: accentMark } : undefined} />
              )}
              {pick !== "chat" && (
                <PreviewFab label={look.voiceLabel || "Talk to us"} round={look.shape === "round"} mark="bell" accent={{ bg: accent, fg: accentText, mark: accentMark }} />
              )}
            </div>
          </div>
        </div>
        <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.6, margin: "0 18px 18px", maxWidth: "68ch" }}>
          Saved with the button below. Changes reach your website within a minute — nothing to
          paste again. The words are limited to {APPEARANCE_RULES.labelMaxChars} characters and the colour has to keep the
          words readable; the bell itself does not change, so a visitor who has seen Belline
          anywhere knows what the button is.
        </p>
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

/** One button, drawn the way embed.js draws it. */
function PreviewFab({
  label,
  round,
  quiet,
  mark,
  accent,
}: {
  label: string;
  round: boolean;
  quiet?: boolean;
  mark: "bell" | "bubble" | "wa";
  accent?: { bg: string; fg: string; mark: string };
}) {
  const bg = quiet || !accent ? "#F4F0E8" : accent.bg;
  const fg = quiet || !accent ? "#14110D" : accent.fg;
  const markColor = quiet || !accent ? "#8A672E" : accent.mark;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        padding: round ? 0 : "14px 22px 14px 18px",
        width: round ? 58 : undefined,
        height: round ? 58 : undefined,
        borderRadius: 999,
        background: bg,
        color: fg,
        font: "500 15px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        boxShadow: "0 14px 34px -14px rgba(0,0,0,.5)",
      }}
    >
      <svg viewBox={mark === "bell" ? "0 0 48 48" : "0 0 24 24"} width="24" height="24" fill="none" aria-hidden="true" style={{ color: markColor }}>
        {mark === "bell" && (
          <>
            <circle cx="24" cy="9.5" r="3.5" fill="currentColor" />
            <path d="M9 31.5a15 15 0 0 1 30 0Z" fill="currentColor" />
            <rect x="5" y="35" width="38" height="5.5" rx="2.75" fill="currentColor" />
          </>
        )}
        {mark === "bubble" && (
          <>
            <path d="M3 11.2C3 6.9 7.03 3.5 12 3.5s9 3.4 9 7.7c0 4.3-4.03 7.7-9 7.7a11 11 0 0 1-2.4-.26L5.4 20.5l.5-3.2A7.7 7.7 0 0 1 3 11.2Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            <circle cx="12" cy="7.4" r="1.05" fill="currentColor" />
            <path d="M8.7 13.1a3.3 3.3 0 0 1 6.6 0Z" fill="currentColor" />
            <rect x="7.8" y="13.8" width="8.4" height="1.35" rx=".68" fill="currentColor" />
          </>
        )}
        {mark === "wa" && (
          <>
            <path d="M12 3.5a8.5 8.5 0 0 0-7.3 12.9L3.6 20.4l4.1-1.1A8.5 8.5 0 1 0 12 3.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            <path d="M9.2 8.6c.2-.4.4-.4.6-.4h.5c.2 0 .4 0 .5.4l.7 1.6c.1.2 0 .4-.1.5l-.5.6c-.1.1-.1.3 0 .4a6 6 0 0 0 2.6 2.5c.2.1.3.1.4 0l.6-.7c.1-.2.3-.2.5-.1l1.6.7c.2.1.4.2.4.4 0 .3 0 1-.4 1.4-.5.5-1.2.7-1.8.6a7.9 7.9 0 0 1-5.7-5.6c-.1-.6 0-1.3.6-1.8Z" fill="currentColor" />
          </>
        )}
      </svg>
      {!round && <span>{label}</span>}
    </span>
  );
}

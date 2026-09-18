"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { EmbedAppearance, EmbedMode } from "@/lib/types";
import { APPEARANCE_RULES, EMBED_PALETTE, accentHex, contrastRatio, textOn } from "@/lib/embed-look";
import LogoUpload from "@/components/LogoUpload";
import ChatLinkCard from "../channels/ChatLinkCard";
import InstallGuide from "./InstallGuide";
import InstallCheck from "./InstallCheck";

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

/**
 * What the widget can offer, in the words for what it is.
 *
 * "Bell", "talking only" and "messages only" were our words for our own
 * buttons rather than the customer's words for what they are buying (founder,
 * f6). The two things on offer are a receptionist with a face who speaks, and
 * one who types: video and chat.
 *
 * Which of the two the first one is depends on the venue, so it is an argument
 * rather than written in. `video` is `video.avatar` and this venue's own
 * availability (video/availability.ts `videoOffered`) — the same question the
 * widget itself asks. Where it is off, that button starts a spoken call with
 * no face, and calling it "Video" here would sell something the visitor will
 * not get. It says Voice, which is true, and becomes Video the day video is
 * live for the venue, with no edit on this screen.
 *
 * `videoRatio` is the catalogue's own (plans.ts), so the cost sentence cannot
 * drift from what is billed.
 */
export function modesFor(video: boolean, videoRatio: number): { id: EmbedMode; title: string; what: string; costs: string }[] {
  const spoken = video ? "Video" : "Voice";
  const talks = video
    ? "Belline appears with a face and answers out loud, in the visitor's own browser — it uses their microphone, never their camera."
    : "Belline answers out loud, in the visitor's own browser, using their microphone.";
  const talkCost = video
    ? `Uses voice minutes from your plan; each video minute uses ${videoRatio} of them.`
    : "Uses voice minutes from your plan, the same as a phone call.";
  return [
    {
      id: "both",
      title: `${spoken} and chat`,
      what: `Two buttons and the visitor picks: one to talk, one to write — and messages always take voice notes too. ${talks}`,
      costs: `Most sites want this. Neither button costs anything until somebody uses it. ${talkCost} Messages use none.`,
    },
    {
      id: "voice",
      title: `${spoken} only`,
      what: `One button. Tapping it starts a conversation out loud. ${talks}`,
      costs: talkCost,
    },
    {
      id: "chat",
      title: "Chat only",
      what: "One button. The visitor types, or holds the microphone to send a voice note; Belline writes back. Nobody has to talk out loud.",
      costs: "No voice minutes: a voice note is written down and counts as a message.",
    },
  ];
}

export default function WidgetEditor({
  locationId,
  enabled: enabledAtLoad,
  mode,
  origins,
  snippet: snippetAtLoad,
  builderTabs,
  used,
  limits,
  minutesCount,
  appearance,
  whatsappNumber,
  detectedAt,
  logoUrl: logoUrlAtLoad = null,
  video = false,
  videoRatio,
  chatLink,
  chatLinkLive = false,
}: {
  locationId: string;
  enabled: boolean;
  mode: EmbedMode;
  /** The saved sites, or the website setup read the business from when there are none yet. */
  origins: string[];
  snippet: string;
  builderTabs: { id: string; name: string; steps: string[]; note?: string }[];
  used: { voice: number; chat: number };
  limits: { voice: number; chat: number };
  /** Whether voice here comes out of a paid allowance. Changes what we warn about. */
  minutesCount: boolean;
  appearance: EmbedAppearance;
  /** The venue's WhatsApp number, if Belle answers one — the third button. */
  whatsappNumber: string | null;
  /** When the widget was last seen loading on the venue's own site, if ever. */
  detectedAt: string | null;
  /**
   * The venue's uploaded logo (logo.ts `logoUrlFor`), if any. Optional so
   * every place that mounted this before logos existed still does; without
   * it the logo can still be uploaded right here.
   */
  logoUrl?: string | null;
  /**
   * Belline answers this venue's website on video (video/availability.ts
   * `videoOffered`) — the same question the widget asks. It decides whether
   * the spoken option is called Video or Voice, and nothing else on the page.
   */
  video?: boolean;
  /** Voice minutes a video minute costs (plans.ts `VIDEO_VOICE_MINUTE_RATIO`). */
  videoRatio: number;
  /** The venue's shareable chat link, or null until it has made one. */
  chatLink: string | null;
  /** Is the venue answering yet? The link exists either way; only one of them is answered. */
  chatLinkLive?: boolean;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(enabledAtLoad);
  const [snippet, setSnippet] = useState(snippetAtLoad);
  const [pick, setPick] = useState<EmbedMode>(mode);
  // What is *saved*, as opposed to what is picked. The header and the day's
  // counters describe the live widget, so they follow this and not `pick`; a
  // mode chosen and not yet saved changes the preview and nothing else.
  const [savedMode, setSavedMode] = useState<EmbedMode>(mode);
  const [sites, setSites] = useState(origins.join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [look, setLook] = useState<EmbedAppearance>(appearance);
  const [customHex, setCustomHex] = useState(
    appearance.accent && !EMBED_PALETTE[appearance.accent] ? appearance.accent : "",
  );
  const [customChatHex, setCustomChatHex] = useState(
    appearance.chatAccent && !EMBED_PALETTE[appearance.chatAccent] ? appearance.chatAccent : "",
  );
  const [logoUrl, setLogoUrl] = useState<string | null>(logoUrlAtLoad);
  // As the widget resolves it: the logo only when chosen *and* uploaded.
  const showsLogo = look.buttonMark === "logo" && Boolean(logoUrl);

  // What the buttons will look like, resolved the way the widget resolves it.
  const accent = accentHex(look.accent) ?? EMBED_PALETTE.indigo;
  const accentText = textOn(accent);
  const accentMark = accentText;
  const contrast = Math.max(contrastRatio(accent, "#FFFFFF"), contrastRatio(accent, "#1D1D1F"));
  const tooPale = contrast < APPEARANCE_RULES.minContrast;
  // The message button's own colour, where the venue gave it one. Null is the
  // quiet paper button, which is what everybody starts with.
  const chatAccent = look.chatAccent ? (accentHex(look.chatAccent) ?? null) : null;
  const chatAccentText = chatAccent ? textOn(chatAccent) : "#1D1D1F";
  const chatContrast = chatAccent ? Math.max(contrastRatio(chatAccent, "#FFFFFF"), contrastRatio(chatAccent, "#1D1D1F")) : Infinity;
  const chatTooPale = chatContrast < APPEARANCE_RULES.minContrast;

  // The word for the spoken option on this venue, so the labels, the status
  // line and the preview all use the one the buyer will actually get.
  const MODES = modesFor(video, videoRatio);
  const spokenWord = video ? "video" : "voice";

  // voiceAllowed/chatAllowed, off the saved mode rather than off a server prop
  // captured before the save. Read from the prop, an owner who switched the
  // widget on in this visit was told "On · talking" whatever they had chosen.
  const offering = { voice: savedMode !== "chat", chat: savedMode !== "voice" };

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
      const data = (await res.json()) as {
        error?: string;
        enabled?: boolean;
        snippet?: string;
        origins?: string[];
        mode?: EmbedMode;
      };
      if (!res.ok) {
        setError(data.error ?? "That didn't save. Try again in a moment.");
        return;
      }
      // Patched in place rather than reloaded: a reload threw away whatever was
      // typed in the sites box when the save failed half-way. The sites come
      // back normalised, so a typo is visible straight away.
      setEnabled(Boolean(data.enabled));
      if (data.mode) setSavedMode(data.mode);
      if (data.snippet) setSnippet(data.snippet);
      if (data.origins) setSites(data.origins.join("\n"));
      // The rest of this screen is still server-rendered — today's usage, the
      // ceilings, the suggested sites. A refresh re-runs the page on the server
      // and hands down fresh props without remounting this component, so the
      // typed-in box the reload used to eat is untouched. Nothing on screen
      // waits for it: what the save returned is already showing.
      router.refresh();
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
                ? ` · ${spokenWord} and chat`
                : offering.chat
                  ? " · chat"
                  : ` · ${spokenWord}`}
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
                    <span className="muted">spoken conversations today</span>
                  </div>
                )}
                {offering.chat && (
                  <div>
                    <strong>
                      {used.chat} <span>of {limits.chat}</span>
                    </strong>
                    <span className="muted">chat threads today</span>
                  </div>
                )}
              </div>
              <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.6, margin: "14px 0 0" }}>
                A daily ceiling, so an unattended tab on a slow afternoon cannot
                run up a bill. Past it, visitors are asked to ring you instead.
                {minutesCount && offering.voice
                  ? ` Spoken conversations come out of your plan's voice minutes${video ? ` — a video minute uses ${videoRatio} of them` : ""}; chat threads do not.`
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
          {/*
            Said once, plainly, on the screen where somebody decides to put
            this on their own website (founder, f6). It is not a disclaimer —
            it is what they are buying, and it is what their visitors are told
            too: the video call carries an "AI concierge" label on the circle,
            and the agent is instructed never to claim or imply it is a person,
            in any language (lib/agent/prompt.ts).
          */}
          <p style={{ fontSize: 13.5, lineHeight: 1.6, margin: "0 0 16px", maxWidth: "68ch" }}>
            <strong style={{ fontWeight: 600 }}>Belline is an AI assistant, not a human receptionist.</strong>{" "}
            Your visitors see that too — the call is labelled as AI, and if anyone asks whether they are
            talking to a person, it says plainly that it is not. What it cannot decide on its own, it
            passes to your team.
          </p>
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
            your words, your colours, our mark or your logo
          </span>
        </div>
        <div style={{ padding: 18, display: "grid", gap: 18, gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }} className="widget-look">
          <div style={{ display: "grid", gap: 14 }}>
            {(
              [
                ["voiceLabel", `The ${spokenWord} button says`, "Talk to us", pick !== "chat"],
                ["chatLabel", "The chat button says", "Chat with us", pick !== "voice"],
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
              <label id="accent-label">Colour of the main button</label>
              <Swatches
                labelledBy="accent-label"
                name="main"
                picked={look.accent}
                custom={customHex}
                onPick={(value) => {
                  setCustomHex("");
                  setLook((prev) => ({ ...prev, accent: value }));
                }}
                onCustom={(v) => {
                  setCustomHex(v);
                  if (/^#[0-9a-f]{6}$/i.test(v)) setLook((prev) => ({ ...prev, accent: v.toUpperCase() }));
                }}
              />
              <div style={{ fontSize: 11.5, marginTop: 6, color: tooPale ? "var(--bad)" : "var(--muted)" }}>
                {tooPale
                  ? "Not enough contrast for the words to be read. Try a deeper or a lighter shade."
                  : `Words in ${accentText === "#FFFFFF" ? "white" : "ink"} on it — ${contrast.toFixed(1)}:1, readable.`}
              </div>
            </div>

            {/*
              The message button's own colour (founder, f6/12). Only where it
              is the second button: on its own it *is* the main button and the
              colour above is already its colour, so offering a second one here
              would be two controls for one thing. "Plain white" is the
              default and the way back, because a pair where both buttons
              shout has no primary in it.
            */}
            {pick === "both" && (
              <div>
                <label id="chat-accent-label">Colour of the message button</label>
                <Swatches
                  labelledBy="chat-accent-label"
                  name="message"
                  picked={look.chatAccent}
                  custom={customChatHex}
                  plain={{
                    on: !look.chatAccent,
                    label: "Plain white",
                    onPick: () => {
                      setCustomChatHex("");
                      setLook((prev) => ({ ...prev, chatAccent: undefined }));
                    },
                  }}
                  onPick={(value) => {
                    setCustomChatHex("");
                    setLook((prev) => ({ ...prev, chatAccent: value }));
                  }}
                  onCustom={(v) => {
                    setCustomChatHex(v);
                    if (/^#[0-9a-f]{6}$/i.test(v)) setLook((prev) => ({ ...prev, chatAccent: v.toUpperCase() }));
                  }}
                />
                <div style={{ fontSize: 11.5, marginTop: 6, color: chatTooPale ? "var(--bad)" : "var(--muted)" }}>
                  {chatTooPale
                    ? "Not enough contrast for the words to be read. Try a deeper or a lighter shade."
                    : chatAccent
                      ? `Words in ${chatAccentText === "#FFFFFF" ? "white" : "ink"} on it — ${chatContrast.toFixed(1)}:1, readable.`
                      : "White with ink words, so the two buttons read as one offer with a main one in it."}
                </div>
              </div>
            )}

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

            {/*
             * The bell or the venue's logo on the main button. The logo can be
             * uploaded right here, so the choice is never a dead end: disabled
             * until there is a logo, with the reason beside it.
             */}
            <LogoUpload locationId={locationId} logoUrl={logoUrl} onChange={setLogoUrl} />
            <fieldset style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
              {/* Styled as the other field labels on this panel. */}
              <legend
                style={{ padding: 0, fontSize: 11, fontWeight: 600, letterSpacing: "0.045em", textTransform: "uppercase", color: "var(--muted)", marginBottom: 7 }}
              >
                The main button shows
              </legend>
              <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginTop: 4 }}>
                {(
                  [
                    ["bell", "Belline's mark"],
                    ["logo", "Your logo"],
                  ] as const
                ).map(([value, text]) => {
                  const disabled = value === "logo" && !logoUrl;
                  const checked = value === "logo" ? showsLogo : !showsLogo;
                  return (
                    <label
                      key={value}
                      className="label-plain"
                      style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, margin: 0, opacity: disabled ? 0.55 : 1 }}
                    >
                      <input
                        type="radio"
                        name={`button-mark-${locationId}`}
                        value={value}
                        checked={checked}
                        disabled={disabled}
                        onChange={() => setLook((prev) => ({ ...prev, buttonMark: value }))}
                        style={{ width: 18, height: 18, margin: 0, accentColor: "var(--accent)" }}
                      />
                      {text}
                    </label>
                  );
                })}
              </div>
              <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
                {logoUrl
                  ? "Your logo sits on a thin white disc, so it reads on any colour. If it ever fails to load, visitors see Belline's mark."
                  : "Upload your logo above to put it on the button. Until then, the button shows Belline's mark."}
              </div>
            </fieldset>

            <div>
              <label className="label-plain" style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13.5 }}>
                <input
                  type="checkbox"
                  checked={look.ring ?? false}
                  onChange={(e) => setLook((prev) => ({ ...prev, ring: e.target.checked }))}
                  style={{ width: 22, height: 22, margin: 0, accentColor: "var(--accent)" }}
                />
                Ring the button now and then
              </label>
              <div className="muted" style={{ fontSize: 11.5, marginTop: 4, maxWidth: "52ch" }}>
                A few seconds of ringing, a few times per visit, to catch the eye. It stops for good once a
                visitor points at or taps it, and never plays for visitors who have asked their device for
                less motion. The preview rings all the time so you can see it.
              </div>
            </div>
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
                <PreviewFab
                  label={look.chatLabel || "Chat with us"}
                  round={look.shape === "round"}
                  quiet={pick === "both" && !chatAccent}
                  mark="bubble"
                  accent={
                    pick === "chat"
                      ? { bg: accent, fg: accentText, mark: accentMark }
                      : chatAccent
                        ? { bg: chatAccent, fg: chatAccentText, mark: chatAccentText }
                        : undefined
                  }
                  // In "Chat only" this is the main button: it carries the logo and rings.
                  logoUrl={pick === "chat" && showsLogo ? logoUrl : null}
                  ring={pick === "chat" && Boolean(look.ring)}
                />
              )}
              {pick !== "chat" && (
                <PreviewFab
                  label={look.voiceLabel || "Talk to us"}
                  round={look.shape === "round"}
                  mark="bell"
                  accent={{ bg: accent, fg: accentText, mark: accentMark }}
                  logoUrl={showsLogo ? logoUrl : null}
                  ring={Boolean(look.ring)}
                />
              )}
            </div>
          </div>
        </div>
        <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.6, margin: "0 18px 18px", maxWidth: "68ch" }}>
          Saved with the button below (your logo itself saves as soon as you upload it). Changes
          reach your website within a minute — nothing to paste again. The words are limited to{" "}
          {APPEARANCE_RULES.labelMaxChars} characters and every colour has to keep the words readable.
          Belline&rsquo;s own marks do not change; the only other picture a button can carry is your
          own logo.
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
            placeholder={"yourbusiness.ae\nwww.yourbusiness.ae"}
            spellCheck={false}
            style={{ fontFamily: "inherit" }}
          />
          <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.6, margin: "10px 0 0", maxWidth: "62ch" }}>
            One per line. Belline will only open on the sites you name here, and
            will refuse anywhere else — this is what stops somebody copying your
            line of HTML onto their own site and spending your minutes.
            {" "}
            <strong style={{ fontWeight: 500 }}>yourbusiness.ae</strong> and
            {" "}
            <strong style={{ fontWeight: 500 }}>www.yourbusiness.ae</strong> count
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
            <InstallGuide snippet={snippet} tabs={builderTabs} />
            <p className="muted" style={{ fontSize: 12.5, margin: "14px 0 0" }}>
              The key in that line is public, like a payment provider&rsquo;s. It
              is not a password — the list of websites above is what protects
              you, which is why it is not optional.
            </p>
          </div>
        </div>
      )}

      {/*
       * "Is it on your website?" — mounted off this component's own state, so
       * it appears in the visit that switches the widget on rather than the
       * one after. It has to: its whole job is to notice the widget reporting
       * itself, which happens seconds after the snippet above is pasted, and a
       * panel that is not on screen is not polling.
       */}
      {enabled && <InstallCheck locationId={locationId} detectedAt={detectedAt} />}

      {/*
        The same chat, for the places that are not a website (founder, f6/14).
        It was only on the Channels → Link tab, which is a tab you find by
        looking for it; somebody who has just set the chat up on their site is
        exactly the person who wants the link for their Instagram bio, and this
        is where they are. One card, the same component the Link tab renders,
        so there is one implementation of making and copying it.
      */}
      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          Your chat link
          <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>
            the same chat, with no website needed
          </span>
        </div>
        <div style={{ padding: 18 }}>
          <p className="muted" style={{ fontSize: 13.5, lineHeight: 1.65, margin: "0 0 4px", maxWidth: "62ch" }}>
            A link that opens this chat on its own page. Put it in your Instagram bio, your Google
            Business Profile, your WhatsApp status or an email signature — anywhere you cannot paste
            a line of HTML. It answers from the same information as the button on your website, and
            its threads count the same way.
          </p>
          <ChatLinkCard locationId={locationId} url={chatLink} live={chatLinkLive} />
        </div>
      </div>
    </>
  );
}

/**
 * The palette, a free hex, and optionally "plain white".
 *
 * One component because the main button and the message button choose their
 * colour the same way and by the same contrast rule, and two copies of a
 * swatch row is how they end up disagreeing about what "picked" looks like.
 */
function Swatches({
  labelledBy,
  name,
  picked,
  custom,
  plain,
  onPick,
  onCustom,
}: {
  labelledBy: string;
  /** Names this row's buttons apart for a screen reader: "forest, main button". */
  name: string;
  picked: string | undefined;
  custom: string;
  /** The no-colour option, where there is one. */
  plain?: { on: boolean; label: string; onPick: () => void };
  onPick: (value: string) => void;
  onCustom: (value: string) => void;
}) {
  return (
    <div role="group" aria-labelledby={labelledBy} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      {plain && (
        <button
          type="button"
          aria-pressed={plain.on}
          title={plain.label}
          aria-label={`${plain.label}, ${name} button`}
          onClick={plain.onPick}
          style={{
            width: 34,
            height: 34,
            borderRadius: 999,
            background: "#FFFFFF",
            border: plain.on ? "3px solid var(--text)" : "3px solid transparent",
            boxShadow: "0 0 0 1px var(--border)",
            cursor: "pointer",
          }}
        />
      )}
      {Object.entries(EMBED_PALETTE).map(([swatch, hex]) => (
        <button
          key={swatch}
          type="button"
          aria-label={`${swatch}, ${name} button`}
          aria-pressed={picked === swatch}
          title={swatch}
          onClick={() => onPick(swatch)}
          style={{
            width: 34,
            height: 34,
            borderRadius: 999,
            background: hex,
            border: picked === swatch ? "3px solid var(--text)" : "3px solid transparent",
            boxShadow: "0 0 0 1px var(--border)",
            cursor: "pointer",
          }}
        />
      ))}
      <input
        value={custom}
        placeholder="#2F4A3A"
        aria-label={`Your own colour for the ${name} button, as a hex`}
        maxLength={7}
        style={{ maxWidth: 110, fontFamily: "var(--mono, ui-monospace, monospace)" }}
        onChange={(e) => onCustom(e.target.value.trim())}
      />
    </div>
  );
}

/** One button, drawn the way embed.js draws it. */
function PreviewFab({
  label,
  round,
  quiet,
  mark,
  accent,
  logoUrl = null,
  ring = false,
}: {
  label: string;
  round: boolean;
  quiet?: boolean;
  mark: "bell" | "bubble" | "wa";
  accent?: { bg: string; fg: string; mark: string };
  /** The venue's logo in place of the mark, in its white circle, as embed.js draws it. */
  logoUrl?: string | null;
  /** Ring as embed.js does (globals.css .widget-preview-ring; off under reduced motion). */
  ring?: boolean;
}) {
  const bg = quiet || !accent ? "#FFFFFF" : accent.bg;
  const fg = quiet || !accent ? "#1D1D1F" : accent.fg;
  const markColor = quiet || !accent ? "#0071E3" : accent.mark;
  // Falls back to the mark if the picture will not load, as the widget does.
  // Keyed by URL, so a newly uploaded logo gets its own chance to load.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const logo = logoUrl && logoUrl !== failedUrl ? logoUrl : null;
  return (
    <span
      className={ring ? "widget-preview-ring" : undefined}
      style={{
        ["--ring-colour" as string]: bg,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        padding: round ? 0 : logo ? "12px 22px 12px 14px" : "14px 22px 14px 18px",
        width: round ? 58 : undefined,
        height: round ? 58 : undefined,
        borderRadius: 999,
        background: bg,
        color: fg,
        font: "500 15px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        boxShadow: "0 14px 34px -14px rgba(0,0,0,.5)",
      }}
    >
      {logo ? (
        <span
          className="widget-preview-mark"
          aria-hidden="true"
          style={{
            display: "block",
            flex: "none",
            width: round ? 40 : 28,
            height: round ? 40 : 28,
            padding: round ? 2 : 1,
            boxSizing: "border-box",
            borderRadius: 999,
            background: "#FFFFFF",
            boxShadow: "0 0 0 1px rgba(29,29,31,.1)",
            overflow: "hidden",
          }}
        >
          <img
            src={logo}
            alt=""
            onError={() => setFailedUrl(logo)}
            style={{ display: "block", width: "100%", height: "100%", objectFit: "contain", borderRadius: 999 }}
          />
        </span>
      ) : (
      <svg className="widget-preview-mark" viewBox={mark === "bell" ? "0 0 48 48" : "0 0 24 24"} width="24" height="24" fill="none" aria-hidden="true" style={{ color: markColor }}>
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
      )}
      {!round && <span>{label}</span>}
    </span>
  );
}

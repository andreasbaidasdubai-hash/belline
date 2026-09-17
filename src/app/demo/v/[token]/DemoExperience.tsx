"use client";

import { useEffect, useRef, useState } from "react";
import VideoPanel from "@/app/embed/[key]/video/VideoPanel";

/**
 * The prospect's side of a personalised video demo.
 *
 * One page, two ways to talk to the same Belle: the video call (the widget's
 * own call panel, pointed at this link's routes) and a typed chat. Nothing
 * starts until the visitor asks for it. The disclosure that Belle is an AI and
 * that this is a demo stays on screen whichever is open.
 */

type Props = {
  token: string;
  businessName: string;
  firstName: string | null;
  opening: string;
  visitorToken: string;
  videoOn: boolean;
  provider: "tavus" | "mock";
  maxCallSeconds: number;
  previewClipUrl: string;
  previewPosterUrl: string;
};

type Line = { who: "belle" | "you"; text: string };

export default function DemoExperience(props: Props) {
  const { token, businessName, firstName, opening, visitorToken, videoOn } = props;
  const [mode, setMode] = useState<"video" | "chat">(videoOn ? "video" : "chat");
  const base = `/api/video-demo/${encodeURIComponent(token)}`;

  // "Opened": once per tab, from a real browser that rendered the page.
  useEffect(() => {
    try {
      const key = `belline.demo.opened.${token.slice(0, 24)}`;
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
    } catch {
      /* storage is a convenience */
    }
    void fetch(`${base}/track`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "opened" }),
      keepalive: true,
    }).catch(() => undefined);
  }, [base, token]);

  return (
    <main className="dx">
      <style>{CSS}</style>
      <header className="dx-top">
        <span className="dx-brand">Belline</span>
      </header>

      <section className="dx-head">
        <p className="dx-eyebrow">{firstName ? `For ${firstName}` : "Personal demo"}</p>
        <h1>A 2-minute personal demo for {businessName}</h1>
        <p className="dx-sub">
          Belle, Belline&rsquo;s AI receptionist, has a short pitch ready for {businessName}. Then ask her anything.
        </p>
      </section>

      <section className="dx-stage" aria-live="polite">
        {mode === "video" && videoOn ? (
          <div className="dx-video">
            <VideoPanel
              embedKey="demo"
              apiBase={base}
              freshToken={visitorToken}
              venueName="Belline"
              agentName="Belle"
              provider={props.provider}
              maxCallSeconds={props.maxCallSeconds}
              previewClipUrl={props.previewClipUrl}
              previewPosterUrl={props.previewPosterUrl}
              introTitle="Start your demo"
              introBody="When you start, your browser asks for your microphone so Belle can hear you. Your camera stays off."
              startLabel="Start your demo"
              onChat={() => setMode("chat")}
            />
          </div>
        ) : (
          <DemoChat base={base} visitorToken={visitorToken} opening={opening} />
        )}
      </section>

      <section className="dx-foot">
        {/* On video, the call panel's own "Chat instead" is the one way to switch; the "AI concierge" pill is on the circle. */}
        {mode === "video" && videoOn ? null : videoOn ? (
          <button type="button" className="dx-link" onClick={() => setMode("video")}>
            Talk to Belle on video instead
          </button>
        ) : (
          <p className="dx-note">Video isn&rsquo;t available right now, so Belle is here by chat.</p>
        )}

        <p className="dx-disclosure" role="note">
          <strong>This is a demo by Belline&rsquo;s AI receptionist.</strong> Belle is an AI, not a person. She prepared
          from {businessName}&rsquo;s public website; nothing is booked and none of your customers are contacted.
        </p>

        <a className="dx-cta" href={`${base}/go`} rel="noreferrer">
          Get started
        </a>
      </section>
    </main>
  );
}

function DemoChat({ base, visitorToken, opening }: { base: string; visitorToken: string; opening: string }) {
  const [lines, setLines] = useState<Line[]>([{ who: "belle", text: opening }]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const chatId = useRef(`c${Math.random().toString(36).slice(2, 14)}${Date.now().toString(36)}`);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [lines]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const said = text.trim();
    if (!said || busy) return;
    setText("");
    setNote(null);
    setBusy(true);
    setLines((l) => [...l, { who: "you", text: said }]);
    try {
      const res = await fetch(`${base}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: visitorToken, chatId: chatId.current, text: said }),
      });
      const data = (await res.json().catch(() => ({}))) as { reply?: string; error?: string };
      if (res.ok && data.reply) setLines((l) => [...l, { who: "belle", text: data.reply! }]);
      else if (data.error === "chat_limit" || data.error === "message_limit")
        setNote("That's as much as this demo link allows for today. Press Get started, or reply to the email and a person will help.");
      else setNote("Belle couldn't answer just now. Please try again.");
    } catch {
      setNote("You seem to be offline. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dx-chat">
      <div className="dx-lines">
        {lines.map((line, i) => (
          <p key={i} className={`dx-bubble is-${line.who}`}>
            {line.text}
          </p>
        ))}
        {busy && <p className="dx-bubble is-belle is-typing" aria-label="Belle is typing">…</p>}
        <div ref={endRef} />
      </div>
      {note && (
        <p className="dx-note" role="status">
          {note}
        </p>
      )}
      <form className="dx-form" onSubmit={send}>
        <label htmlFor="dx-input" className="dx-sr">
          Message Belle
        </label>
        <input
          id="dx-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ask Belle anything"
          maxLength={1000}
          autoComplete="off"
        />
        <button type="submit" disabled={busy || !text.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}

const CSS = `
.dx { min-height: 100dvh; background: var(--bl-surface); color: var(--bl-ink-900);
  font-family: var(--bl-font-text); -webkit-font-smoothing: antialiased;
  display: flex; flex-direction: column; align-items: center; padding: 0 16px 32px }
.dx > * { width: 100%; max-width: 560px }
.dx-top { display: flex; align-items: center; justify-content: space-between; padding: 16px 0 4px }
.dx-brand { font-family: var(--bl-font-display); font-weight: 600; font-size: 19px; letter-spacing: -0.01em }
.dx-head { text-align: center; padding: 18px 0 6px }
.dx-eyebrow { margin: 0 0 6px; font-size: 14px; color: var(--bl-text-2) }
.dx-head h1 { margin: 0; font-family: var(--bl-font-display); font-weight: 600; font-size: clamp(26px, 7vw, 34px);
  line-height: 1.12; letter-spacing: -0.015em; text-wrap: balance }
.dx-sub { margin: 10px auto 0; font-size: 17px; line-height: 1.47; color: var(--bl-text-2); max-width: 40ch }
.dx-stage { margin-top: 14px; background: var(--bl-ground); border-radius: 22px; overflow: hidden;
  box-shadow: 0 1px 2px rgba(0,0,0,.04), 0 12px 32px -18px rgba(0,0,0,.18) }
.dx-video .bv { height: auto; min-height: 0; overflow: visible; background: transparent }
.dx-video .bv-panel h1 { font-size: 21px }
.dx-foot { display: grid; gap: 12px; justify-items: center; text-align: center; margin-top: 16px }
.dx-link { background: none; border: 0; color: var(--bl-accent-text); font: inherit; font-size: 17px; cursor: pointer; padding: 8px 12px; min-height: 44px }
.dx-link:focus-visible, .dx-cta:focus-visible, .dx-form button:focus-visible { outline: var(--bl-focus); outline-offset: 2px }
.dx-disclosure { margin: 0; font-size: 13px; line-height: 1.5; color: var(--bl-text-2); max-width: 46ch }
.dx-disclosure strong { color: var(--bl-ink-900); font-weight: 600 }
.dx-note { margin: 0; font-size: 14px; color: var(--bl-text-2) }
.dx-cta { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 0 22px;
  border-radius: 999px; border: 1px solid var(--bl-rule-strong); color: var(--bl-ink-900); text-decoration: none; font-size: 17px }
.dx-chat { display: flex; flex-direction: column; height: min(62dvh, 560px) }
.dx-lines { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 8px }
.dx-bubble { margin: 0; max-width: 85%; padding: 10px 14px; border-radius: 18px; font-size: 16px; line-height: 1.42; white-space: pre-wrap }
.dx-bubble.is-belle { align-self: flex-start; background: var(--bl-surface); color: var(--bl-ink-900); border-bottom-left-radius: 6px }
.dx-bubble.is-you { align-self: flex-end; background: var(--bl-blue); color: #fff; border-bottom-right-radius: 6px }
.dx-bubble.is-typing { color: var(--bl-text-2) }
.dx-chat .dx-note { padding: 0 16px 8px }
.dx-form { display: flex; gap: 8px; padding: 10px; border-top: 1px solid var(--bl-rule-soft) }
.dx-form input { flex: 1; min-width: 0; min-height: 44px; border-radius: 999px; border: 1px solid var(--bl-rule-strong);
  padding: 0 16px; font: inherit; font-size: 16px; background: var(--bl-ground); color: var(--bl-ink-900) }
.dx-form input:focus-visible { outline: var(--bl-focus); outline-offset: 1px }
.dx-form button { min-height: 44px; padding: 0 18px; border: 0; border-radius: 999px; background: var(--bl-blue); color: #fff; font: inherit; font-size: 16px; cursor: pointer }
.dx-form button:disabled { opacity: .45; cursor: default }
.dx-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap }
@media (prefers-color-scheme: dark) {
  .dx-stage { box-shadow: 0 0 0 1px var(--bl-rule-soft) }
}
`;

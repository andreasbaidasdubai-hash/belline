"use client";

import { useEffect, useRef, useState } from "react";
import Brand from "@/components/Brand";
import VideoPanel from "@/app/embed/[key]/video/VideoPanel";
import type { DemoPackage } from "@/lib/sales/video-demo/packages";

/**
 * The prospect's side of a personalised video demo: a short sales page built
 * around one tap.
 *
 * The call comes first. Belle's face is on screen with "Tap to meet Belle" on
 * it; that one tap starts her session, her opening and the microphone prompt
 * together (VideoPanel `listenFirst`), so she is talking before the visitor
 * has answered the browser. Nothing is created before the tap, and the call
 * client's code is fetched on load so the tap has nothing to download.
 *
 * Then, for somebody who liked what they heard: what Belline does, what their
 * team gets, the packages (from the catalogue, never typed), how setup goes
 * (in the same words Belle uses), and three questions answered in Belle's own
 * prepared answers. One primary action, Get started; one secondary, talking to
 * Belle (or typing to her). The disclosure that Belle is an AI and that this
 * is a demo stays on the page.
 */

type Props = {
  token: string;
  businessName: string;
  firstName: string | null;
  opening: string;
  visitorToken: string;
  videoOn: boolean;
  /** The video receptionist may be described as working (plans.ts `videoLive`). */
  videoLive: boolean;
  provider: "tavus" | "mock";
  maxCallSeconds: number;
  /** What calls here really run to, for the intro's promise. Null: no number can be promised. */
  promisedSeconds: number | null;
  previewClipUrl: string;
  previewPosterUrl: string;
  siteOrigin: string;
  packages: DemoPackage[];
  setupClaim: string;
  faqs: { q: string; a: string }[];
};

type Line = { who: "belle" | "you"; text: string };

export default function DemoExperience(props: Props) {
  const { token, businessName, firstName, opening, visitorToken, videoOn, packages } = props;
  const [mode, setMode] = useState<"video" | "chat">(videoOn ? "video" : "chat");
  /**
   * The call the chat is carrying on from, when a call ended and the prospect
   * pressed "Continue in chat". Belle is given it too (api/video-demo/chat),
   * so the person does not say the same thing twice in two mediums.
   */
  const [fromVideo, setFromVideo] = useState<{ role: "agent" | "caller"; text: string }[]>([]);
  const [annual, setAnnual] = useState(false);
  const base = `/api/video-demo/${encodeURIComponent(token)}`;
  const go = (plan?: string) => {
    const q = new URLSearchParams();
    if (plan) q.set("plan", plan);
    if (plan && annual) q.set("cycle", "annual");
    const s = q.toString();
    return `${base}/go${s ? `?${s}` : ""}`;
  };

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

  const offers = [
    {
      icon: <IconVideo />,
      title: "Video receptionist on your website",
      body: `A face that greets ${businessName}'s visitors and answers them out loud, just like this call.`,
      soon: !props.videoLive,
    },
    { icon: <IconChat />, title: "Website chat and voice", body: "Every question on your site answered, typed or spoken, from your own hours, prices and policies." },
    { icon: <IconWhatsApp />, title: "WhatsApp AI", body: "Replies on a WhatsApp number we set up with you, while your own WhatsApp stays as it is." },
    { icon: <IconPhone />, title: "Phone answering", body: "Keep your number. Forward it to Belline and every call is answered." },
  ];

  return (
    <div className="dx">
      <style>{CSS}</style>

      <header className="dx-bar">
        <div className="dx-bar-in">
          <a href={props.siteOrigin} className="dx-logo" aria-label="Belline home" rel="noreferrer">
            <Brand size={22} />
          </a>
          <a className="dx-btn dx-btn-sm" href={go()} rel="noreferrer" data-cta="header">
            Get started
          </a>
        </div>
      </header>

      <main>
        <section className="dx-hero">
          <div className="dx-hero-copy">
            <p className="dx-eyebrow">Built for {businessName}</p>
            <h1>
              {firstName ? `${firstName}, meet Belle.` : "Meet Belle."} <span className="dx-soft">She&rsquo;s read up on {businessName}.</span>
            </h1>
            <p className="dx-lede">
              {videoOn
                ? "One tap and Belle, Belline’s AI receptionist, talks you through what she would do for you. Then ask her anything."
                : "Belle, Belline’s AI receptionist, has a short pitch ready for you. Ask her anything."}
            </p>
          </div>

          <div className="dx-stage" aria-live="polite">
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
                  tapLabel="Tap to meet Belle"
                  introBody="She starts talking straight away. Your browser asks for the microphone so she can hear you; your camera stays off."
                  listenFirst
                  preloadClient
                  promisedSeconds={props.promisedSeconds}
                  onChat={(recap) => {
                    setFromVideo(recap);
                    setMode("chat");
                  }}
                />
              </div>
            ) : (
              <>
                <DemoChat base={base} visitorToken={visitorToken} opening={opening} priorTurns={fromVideo} />
                {videoOn ? (
                  <button type="button" className="dx-link" onClick={() => setMode("video")}>
                    Talk to Belle on video instead
                  </button>
                ) : (
                  <p className="dx-note">Video isn&rsquo;t available right now, so Belle is here by chat.</p>
                )}
              </>
            )}
          </div>
        </section>

        <section className="dx-section" aria-labelledby="dx-does">
          <h2 id="dx-does">What Belline does for {businessName}</h2>
          <ul className="dx-offers">
            {offers.map((o) => (
              <li key={o.title}>
                <span className="dx-icon">{o.icon}</span>
                <div>
                  <h3>
                    {o.title}
                    {o.soon && <span className="dx-tag">Coming soon</span>}
                  </h3>
                  <p>{o.body}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="dx-section" aria-labelledby="dx-team">
          <h2 id="dx-team">What your team gets</h2>
          <ul className="dx-gets">
            <li>
              <h3>A summary of every conversation</h3>
              <p>What was asked and what was said, with the full transcript of every call and chat.</p>
            </li>
            <li>
              <h3>Every enquiry captured</h3>
              <p>Booking requests and contact details, passed to your team, day or night.</p>
            </li>
            <li>
              <h3>A clean handover</h3>
              <p>Your team can take over any chat, and on Growth and Scale urgent calls are put through live.</p>
            </li>
          </ul>
        </section>

        <section className="dx-section" aria-labelledby="dx-plans">
          <div className="dx-plans-head">
            <h2 id="dx-plans">Packages</h2>
            <div className="dx-cycle" role="group" aria-label="Billing">
              <button type="button" aria-pressed={!annual} onClick={() => setAnnual(false)}>
                Monthly
              </button>
              <button type="button" aria-pressed={annual} onClick={() => setAnnual(true)}>
                Annual
              </button>
            </div>
          </div>
          <div className="dx-plans">
            {packages.map((p) => (
              <article key={p.id} className={`dx-plan${p.recommended ? " is-best" : ""}`} data-plan={p.id}>
                {p.recommended && <span className="dx-best">Recommended</span>}
                <h3>{p.name}</h3>
                <p className="dx-plan-sub">{p.summary}</p>
                <p className="dx-price">
                  <span className="dx-amt">{annual ? p.annualPerMonth : p.monthly}</span>
                  <span className="dx-per">per location, per month</span>
                  <span className="dx-billed">{annual ? `${p.annualBilled} billed once a year` : "Billed monthly. Cancel anytime."}</span>
                </p>
                <ul className="dx-allow">
                  <li>{p.voice}</li>
                  {p.video && <li>{p.video}</li>}
                  <li>{p.text}</li>
                  {p.extras.map((e) => (
                    <li key={e} className="dx-extra">
                      {e}
                    </li>
                  ))}
                </ul>
                <a className={`dx-btn${p.recommended ? "" : " dx-btn-line"}`} href={go(p.id)} rel="noreferrer" data-cta={`plan-${p.id}`} aria-label={`Get started with ${p.name}`}>
                  Get started
                </a>
              </article>
            ))}
          </div>
        </section>

        <section className="dx-section" aria-labelledby="dx-setup">
          <h2 id="dx-setup">Setup is quick</h2>
          <p className="dx-claim" data-setup-claim>
            {props.setupClaim}
          </p>
          <ol className="dx-steps">
            <li>
              <h3>Paste your website</h3>
              <p>Belle reads it and drafts your information.</p>
            </li>
            <li>
              <h3>Check what Belle learned</h3>
              <p>Fix anything, fill the gaps.</p>
            </li>
            <li>
              <h3>Choose where bookings go</h3>
              <p>Decide how requests reach your team.</p>
            </li>
            <li>
              <h3>Go live</h3>
              <p>Forward your line and add the chat to your site.</p>
            </li>
          </ol>
        </section>

        {props.faqs.length > 0 && (
          <section className="dx-section" aria-labelledby="dx-faq">
            <h2 id="dx-faq">Questions</h2>
            <div className="dx-faq">
              {props.faqs.map((f) => (
                <details key={f.q}>
                  <summary>{f.q}</summary>
                  <p>{f.a}</p>
                </details>
              ))}
            </div>
          </section>
        )}

        <section className="dx-end">
          <h2>Ready when {businessName} is.</h2>
          <a className="dx-btn dx-btn-lg" href={go()} rel="noreferrer" data-cta="closer">
            Get started
          </a>
          <p className="dx-disclosure" role="note">
            <strong>This is a demo by Belline&rsquo;s AI receptionist.</strong> Belle is an AI, not a person. She prepared from {businessName}&rsquo;s
            public website; nothing is booked and none of your customers are contacted.
          </p>
        </section>
      </main>
    </div>
  );
}

function DemoChat({
  base,
  visitorToken,
  opening,
  priorTurns = [],
}: {
  base: string;
  visitorToken: string;
  opening: string;
  /** A video call this chat is carrying on from: shown here, and given to Belle on the first turn. */
  priorTurns?: { role: "agent" | "caller"; text: string }[];
}) {
  const [lines, setLines] = useState<Line[]>([
    { who: "belle", text: opening },
    ...priorTurns.map((t) => ({ who: t.role === "caller" ? ("you" as const) : ("belle" as const), text: t.text })),
  ]);
  // Spent on the first turn only: after that the server holds the thread.
  const carry = useRef(priorTurns);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const chatId = useRef(`c${Math.random().toString(36).slice(2, 14)}${Date.now().toString(36)}`);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
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
        body: JSON.stringify({
          token: visitorToken,
          chatId: chatId.current,
          text: said,
          ...(carry.current.length ? { priorTurns: carry.current } : {}),
        }),
      });
      carry.current = [];
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
      <div className="dx-lines" ref={listRef}>
        {lines.map((line, i) => (
          <p key={i} className={`dx-bubble is-${line.who}`}>
            {line.text}
          </p>
        ))}
        {busy && (
          <p className="dx-bubble is-belle is-typing" aria-label="Belle is typing">
            …
          </p>
        )}
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
        <input id="dx-input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask Belle anything" maxLength={1000} autoComplete="off" />
        <button type="submit" disabled={busy || !text.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}

const svg = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };

function IconVideo() {
  return (
    <svg {...svg}>
      <circle cx="12" cy="9" r="3.2" />
      <path d="M5.8 19.5a6.4 6.4 0 0 1 12.4 0" />
      <circle cx="12" cy="12" r="9.2" />
    </svg>
  );
}

function IconChat() {
  return (
    <svg {...svg}>
      <path d="M3.5 11.2c0-4.1 3.8-7.2 8.5-7.2s8.5 3.1 8.5 7.2-3.8 7.2-8.5 7.2a10 10 0 0 1-2.3-.26L5.6 20l.5-3A7 7 0 0 1 3.5 11.2Z" />
      <path d="M8.5 11.2h.01M12 11.2h.01M15.5 11.2h.01" strokeWidth="2.2" />
    </svg>
  );
}

function IconWhatsApp() {
  return (
    <svg {...svg}>
      <path d="M12 3.5a8.5 8.5 0 0 0-7.3 12.9L3.6 20.4l4.1-1.1A8.5 8.5 0 1 0 12 3.5Z" />
      <path d="M9.3 8.8c.3-.5 1-.5 1.2 0l.6 1.5-.7.9a5.6 5.6 0 0 0 2.5 2.4l.9-.7 1.5.6c.5.2.5.9 0 1.2-1.9 1.3-6.4-2.9-6-5.9Z" />
    </svg>
  );
}

function IconPhone() {
  return (
    <svg {...svg}>
      <path d="M6.6 3.8 9 4.3l1.2 3.4-1.7 1.4a11 11 0 0 0 6.4 6.4l1.4-1.7 3.4 1.2.5 2.4c.1.7-.4 1.4-1.1 1.5A15.6 15.6 0 0 1 5.1 5c.1-.7.8-1.2 1.5-1.2Z" />
    </svg>
  );
}

/**
 * On the brand tokens (public/brand/tokens.css). Paper, grey and the one blue;
 * a single column on a phone, the call beside the words from 900px.
 */
const CSS = `
.dx { min-height: 100dvh; background: var(--bl-ground); color: var(--bl-ink-900); font-family: var(--bl-font-text);
  -webkit-font-smoothing: antialiased; font-size: 17px; line-height: 1.47 }
.dx main { width: 100%; max-width: 1080px; margin: 0 auto; padding: 0 16px 40px }
.dx h1, .dx h2, .dx h3 { font-family: var(--bl-font-display); margin: 0; text-wrap: balance }
.dx p { margin: 0 }
.dx-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap }

.dx-bar { position: sticky; top: 0; z-index: 10; background: color-mix(in srgb, var(--bl-ground) 82%, transparent);
  -webkit-backdrop-filter: saturate(1.8) blur(18px); backdrop-filter: saturate(1.8) blur(18px); border-bottom: 1px solid var(--bl-rule-soft) }
.dx-bar-in { max-width: 1080px; margin: 0 auto; padding: 10px 16px; display: flex; align-items: center; justify-content: space-between; gap: 12px }
.dx-logo { color: var(--bl-ink-900); text-decoration: none; display: inline-flex; min-height: 44px; align-items: center }

.dx-btn { display: inline-flex; align-items: center; justify-content: center; min-height: 48px; padding: 0 24px; border-radius: var(--bl-radius-pill);
  background: var(--bl-blue); color: var(--bl-white); border: 1px solid var(--bl-blue); font: inherit; font-size: 17px; font-weight: 600;
  text-decoration: none; letter-spacing: -.01em; transition: background .15s ease; touch-action: manipulation }
.dx-btn:hover { background: var(--bl-blue-hover); border-color: var(--bl-blue-hover) }
.dx-btn-sm { min-height: 40px; padding: 0 18px; font-size: 15px }
.dx-btn-lg { min-height: 54px; padding: 0 34px; font-size: 18px }
.dx-btn-line { background: var(--bl-ground); color: var(--bl-accent-text); border-color: var(--bl-rule-strong) }
.dx-btn-line:hover { background: var(--bl-surface); border-color: var(--bl-rule-strong) }
.dx-btn:focus-visible, .dx-link:focus-visible, .dx-logo:focus-visible, .dx-form button:focus-visible, .dx-cycle button:focus-visible,
.dx-faq summary:focus-visible { outline: var(--bl-focus); outline-offset: 3px }

.dx-hero { display: grid; gap: 18px; padding: 22px 0 8px }
.dx .dx-eyebrow { font-size: 14px; font-weight: 600; color: var(--bl-accent-text); margin-bottom: 8px }
.dx-hero h1 { font-weight: 700; font-size: clamp(30px, 8.4vw, 52px); line-height: 1.06; letter-spacing: -.025em }
.dx-soft { color: var(--bl-text-2) }
.dx .dx-lede { margin-top: 16px; font-size: 18px; line-height: 1.45; color: var(--bl-text-2); max-width: 36ch }

.dx-stage { display: grid; justify-items: center; gap: 8px }
.dx-video { width: 100% }
.dx-video .bv { height: auto; min-height: 0; overflow: visible; background: transparent }
.dx-video .bv-stage { padding-top: 18px }
.dx-video .bv-orb { width: min(340px, 84vw) }
.dx-video .bv-panel { padding-bottom: 8px; justify-items: center; text-align: center }
.dx-video .bv-actions { justify-content: center }
/* Resting, the tap pill says it all: no "Ready when you are" under it. */
.dx-video .bv[data-phase="intro"] .bv-status { display: none }

.dx-section { padding: 44px 0 0 }
.dx-section > h2, .dx-plans-head h2 { font-weight: 700; font-size: clamp(24px, 6vw, 34px); line-height: 1.12; letter-spacing: -.02em }
.dx-section h3 { font-weight: 600; font-size: 17px; line-height: 1.3; letter-spacing: -.01em }
.dx-section li p { margin-top: 4px; font-size: 15px; line-height: 1.47; color: var(--bl-text-2) }

.dx-offers { list-style: none; margin: 18px 0 0; padding: 0; display: grid; gap: 10px }
.dx-offers li { display: grid; grid-template-columns: 44px 1fr; gap: 14px; align-items: start; padding: 16px; border-radius: 18px; background: var(--bl-surface) }
.dx-icon { width: 44px; height: 44px; border-radius: 12px; display: grid; place-items: center; background: var(--bl-ground); color: var(--bl-blue) }
.dx-icon svg { width: 24px; height: 24px }
.dx-tag { margin-left: 8px; font-family: var(--bl-font-text); font-size: 11.5px; font-weight: 600; padding: 2px 8px; border-radius: var(--bl-radius-pill);
  color: var(--bl-text-2); border: 1px solid var(--bl-rule-strong); vertical-align: 2px; white-space: nowrap }

.dx-gets { list-style: none; margin: 18px 0 0; padding: 0; display: grid; gap: 0 }
.dx-gets li { padding: 14px 0; border-top: 1px solid var(--bl-rule-soft) }
.dx-gets li:first-child { border-top: 0; padding-top: 4px }

.dx-plans-head { display: flex; align-items: end; justify-content: space-between; gap: 12px; flex-wrap: wrap }
.dx-cycle { display: inline-flex; padding: 3px; border-radius: var(--bl-radius-pill); background: var(--bl-surface) }
.dx-cycle button { appearance: none; border: 0; background: none; font: inherit; font-size: 14px; font-weight: 600; color: var(--bl-text-2);
  min-height: 36px; padding: 0 16px; border-radius: var(--bl-radius-pill); cursor: pointer }
.dx-cycle button[aria-pressed="true"] { background: var(--bl-ground); color: var(--bl-ink-900); box-shadow: 0 1px 3px rgba(0,0,0,.12) }
.dx-plans { margin-top: 18px; display: grid; gap: 12px }
.dx-plan { position: relative; display: flex; flex-direction: column; gap: 10px; padding: 22px 20px 20px; border-radius: 22px;
  background: var(--bl-ground); border: 1px solid var(--bl-rule-soft) }
.dx-plan.is-best { border: 2px solid var(--bl-blue); padding: 21px 19px 19px }
.dx-best { position: absolute; top: 0; left: 20px; transform: translateY(-50%); font-size: 12px; font-weight: 600; padding: 3px 10px;
  border-radius: var(--bl-radius-pill); background: var(--bl-blue); color: var(--bl-white) }
.dx-plan h3 { font-size: 21px }
.dx-plan-sub { font-size: 14.5px; color: var(--bl-text-2) }
.dx .dx-price { display: grid; gap: 2px; margin-top: 4px }
.dx-amt { font-family: var(--bl-font-display); font-size: 32px; font-weight: 700; letter-spacing: -.02em; line-height: 1.1 }
.dx-per, .dx-billed { font-size: 13px; color: var(--bl-text-2) }
.dx-allow { list-style: none; margin: 6px 0 4px; padding: 0; display: grid; gap: 8px; flex: 1; align-content: start }
.dx-allow li { position: relative; padding-left: 22px; font-size: 14.5px; line-height: 1.4 }
.dx-allow li::before { content: ""; position: absolute; left: 2px; top: .38em; width: 12px; height: 7px; border-left: 2px solid var(--bl-blue);
  border-bottom: 2px solid var(--bl-blue); transform: rotate(-45deg) }
.dx-allow .dx-extra { color: var(--bl-text-2) }
.dx-plan .dx-btn { width: 100% }

.dx .dx-claim { margin-top: 12px; font-size: 18px; line-height: 1.45; max-width: 44ch }
.dx-steps { list-style: none; counter-reset: step; margin: 18px 0 0; padding: 0; display: grid; gap: 10px }
.dx-steps li { counter-increment: step; position: relative; padding: 14px 16px 14px 58px; border-radius: 16px; background: var(--bl-surface) }
.dx-steps li::before { content: counter(step); position: absolute; left: 16px; top: 14px; width: 28px; height: 28px; border-radius: 50%;
  display: grid; place-items: center; background: var(--bl-blue); color: var(--bl-white); font-size: 14px; font-weight: 700 }
.dx-steps li p { margin-top: 2px }

.dx-faq { margin-top: 14px; border-top: 1px solid var(--bl-rule-soft) }
.dx-faq details { border-bottom: 1px solid var(--bl-rule-soft) }
.dx-faq summary { cursor: pointer; list-style: none; padding: 16px 32px 16px 0; font-weight: 600; font-size: 17px; position: relative; min-height: 44px }
.dx-faq summary::-webkit-details-marker { display: none }
.dx-faq summary::after { content: "+"; position: absolute; right: 4px; top: 13px; font-size: 22px; font-weight: 400; color: var(--bl-text-2) }
.dx-faq details[open] summary::after { content: "−" }
.dx-faq details p { padding: 0 0 16px; font-size: 15.5px; color: var(--bl-text-2); max-width: 64ch }

.dx-end { margin-top: 48px; padding: 36px 20px; border-radius: 26px; background: var(--bl-surface); display: grid; justify-items: center; gap: 16px; text-align: center }
.dx-end h2 { font-weight: 700; font-size: clamp(26px, 6.6vw, 38px); letter-spacing: -.02em; line-height: 1.1 }
.dx-disclosure { font-size: 13px; line-height: 1.5; color: var(--bl-text-2); max-width: 52ch }
.dx-disclosure strong { color: var(--bl-ink-900); font-weight: 600 }

.dx-link { background: none; border: 0; color: var(--bl-accent-text); font: inherit; font-size: 16px; cursor: pointer; padding: 8px 12px; min-height: 44px }
.dx-note { font-size: 14px; color: var(--bl-text-2); text-align: center }
.dx-chat { width: 100%; display: flex; flex-direction: column; height: min(60dvh, 520px); margin-top: 8px; border-radius: 22px; overflow: hidden;
  background: var(--bl-surface) }
.dx-lines { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 8px }
.dx-bubble { margin: 0; max-width: 85%; padding: 10px 14px; border-radius: 18px; font-size: 16px; line-height: 1.42; white-space: pre-wrap }
.dx-bubble.is-belle { align-self: flex-start; background: var(--bl-ground); color: var(--bl-ink-900); border-bottom-left-radius: 6px }
.dx-bubble.is-you { align-self: flex-end; background: var(--bl-blue); color: #fff; border-bottom-right-radius: 6px }
.dx-bubble.is-typing { color: var(--bl-text-2) }
.dx-chat .dx-note { padding: 0 16px 8px }
.dx-form { display: flex; gap: 8px; padding: 10px; border-top: 1px solid var(--bl-rule-soft); background: var(--bl-ground) }
.dx-form input { flex: 1; min-width: 0; min-height: 44px; border-radius: 999px; border: 1px solid var(--bl-rule-strong);
  padding: 0 16px; font: inherit; font-size: 16px; background: var(--bl-ground); color: var(--bl-ink-900) }
.dx-form input:focus-visible { outline: var(--bl-focus); outline-offset: 1px }
.dx-form button { min-height: 44px; padding: 0 18px; border: 0; border-radius: 999px; background: var(--bl-blue); color: #fff; font: inherit; font-size: 16px; font-weight: 600; cursor: pointer }
.dx-form button:disabled { opacity: .45; cursor: default }

@media (min-width: 700px) {
  .dx-offers { grid-template-columns: 1fr 1fr }
  .dx-gets { grid-template-columns: repeat(3, 1fr); gap: 20px }
  .dx-gets li, .dx-gets li:first-child { border-top: 2px solid var(--bl-blue); padding: 14px 0 0 }
  .dx-steps { grid-template-columns: repeat(4, 1fr) }
  .dx-steps li { padding: 54px 16px 16px }
  .dx-steps li::before { top: 16px }
}
@media (min-width: 900px) {
  .dx main { padding: 0 24px 56px }
  .dx-bar-in { padding: 10px 24px }
  .dx-hero { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: center; gap: 40px; padding: 48px 0 12px }
  .dx .dx-lede { font-size: 20px; max-width: 30ch }
  .dx-hero h1 { font-size: 46px }
  .dx-plans { grid-template-columns: repeat(3, 1fr); align-items: stretch }
  .dx-section { padding-top: 72px }
  .dx-end { margin-top: 72px; padding: 56px 24px }
}
@media (prefers-reduced-motion: reduce) {
  .dx-btn { transition: none }
}
`;

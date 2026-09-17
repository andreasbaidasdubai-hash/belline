"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  INITIAL,
  clock,
  durationView,
  errorCopy,
  micErrorCode,
  once,
  reduce,
  startErrorCode,
  statusText,
  type CallEvent,
} from "@/lib/video/client/machine";
import type { CallAdapter, CallSession } from "@/lib/video/client/calls";

/**
 * The video receptionist's panel.
 *
 * One screen that changes state rather than a sequence of pages, because the
 * visitor's eyes are on a face and the face should not move: intro, microphone,
 * connecting, live, ended, and an error that always offers the chat.
 *
 * Decisions worth keeping:
 *
 * **Nothing is spent before Start.** Opening the panel asks for nothing and
 * creates nothing. The microphone is asked for inside the Start press — which
 * is also the gesture iOS Safari needs before it will play the face's audio —
 * and the session is created only once the microphone is granted.
 *
 * **The camera is never asked for.** Perception is off, so there is no camera
 * button to find and no camera prompt to refuse.
 *
 * **"AI concierge" is always on screen.** Beside the business's name, in the
 * same place in every state, and the greeting says it too.
 *
 * **Leaving always cleans up.** End, switching to chat, closing the panel and
 * the page unloading all stop the microphone, leave the room and tell the
 * server — the last by beacon, which survives the page going away.
 *
 * `@daily-co/daily-js` is not imported here: `calls.ts` loads it on Start.
 */

type Props = {
  embedKey: string;
  freshToken: string;
  venueName: string;
  agentName: string;
  provider: "tavus" | "mock";
  maxCallSeconds: number;
  chatHref?: string;
  voiceHref?: string;
};

type Session = CallSession & { maxCallSeconds: number; warnBeforeSeconds: number; captions: boolean; perception: boolean };

const TOKEN_KEY = "belline.video.visitor";

export default function VideoPanel({ embedKey, freshToken, venueName, agentName, provider, maxCallSeconds, chatHref, voiceHref }: Props) {
  const [state, dispatch] = useReducer(reduce, INITIAL);
  const [now, setNow] = useState(() => Date.now());
  const [showCaptions, setShowCaptions] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [faceVisible, setFaceVisible] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const sessionRef = useRef<Session | null>(null);
  const callRef = useRef<CallAdapter | null>(null);
  const micRef = useRef<MediaStreamTrack | null>(null);
  const tokenRef = useRef(freshToken);
  const startedAtRef = useRef(0);
  const joinedAtRef = useRef(0);
  const firstResponseRef = useRef(false);
  const endingRef = useRef(false);
  const startButtonRef = useRef<HTMLButtonElement>(null);

  const base = `/api/video/${encodeURIComponent(embedKey)}`;

  // The visitor's identity for this browser tab, kept across a reload so a
  // refresh does not start a second session beside the first.
  useEffect(() => {
    try {
      const kept = sessionStorage.getItem(TOKEN_KEY);
      if (kept) tokenRef.current = kept;
      else sessionStorage.setItem(TOKEN_KEY, freshToken);
    } catch {
      /* storage is a convenience */
    }
  }, [freshToken]);

  const report = useCallback(
    (name: string, ms?: number, detail?: string) => {
      const session = sessionRef.current;
      const body = session
        ? { name, ms, detail, sessionId: session.sessionId, clientToken: session.clientToken }
        : { name, ms, detail, token: tokenRef.current };
      void fetch(`${base}/event`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        keepalive: true,
      }).catch(() => undefined);
    },
    [base],
  );

  useEffect(() => {
    report("video_selected");
  }, [report]);

  const stopMic = useCallback(() => {
    micRef.current?.stop();
    micRef.current = null;
  }, []);

  /** Tell the server. A beacon when the page is going away, a keepalive fetch otherwise. */
  const endOnServer = useCallback(
    (reason: string, beacon = false) => {
      const session = sessionRef.current;
      if (!session) return;
      const payload = JSON.stringify({ sessionId: session.sessionId, clientToken: session.clientToken, reason });
      if (beacon && typeof navigator.sendBeacon === "function") {
        navigator.sendBeacon(`${base}/session/end`, new Blob([payload], { type: "text/plain" }));
        return;
      }
      void fetch(`${base}/session/end`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
        keepalive: true,
      }).catch(() => undefined);
    },
    [base],
  );

  const end = useCallback(
    async (reason: string, opts: { silent?: boolean } = {}) => {
      if (endingRef.current) return;
      endingRef.current = true;
      const call = callRef.current;
      callRef.current = null;
      await call?.leave().catch(() => undefined);
      stopMic();
      if (videoRef.current) videoRef.current.srcObject = null;
      if (audioRef.current) audioRef.current.srcObject = null;
      setFaceVisible(false);
      endOnServer(reason);
      // Silent when a failure is about to be shown instead.
      if (!opts.silent) dispatch({ type: "ended", reason });
    },
    [endOnServer, stopMic],
  );

  const onCallEvent = useCallback(
    (event: CallEvent) => {
      dispatch({ type: "call", event, now: Date.now() });
      if (event.type === "joined") joinedAtRef.current = Date.now();
      if (event.type === "speaking" && event.who === "agent" && event.on && !firstResponseRef.current) {
        firstResponseRef.current = true;
        report("first_response", Date.now() - startedAtRef.current);
      }
      if (event.type === "network" && event.state === "reconnecting") report("reconnecting");
      if (event.type === "left") void end("visitor");
      if (event.type === "error") {
        report("client_error", undefined, event.code);
        void end("error", { silent: true });
      }
    },
    [end, report],
  );

  // The start sequence changes every render; the single-flight wrapper must not.
  const startRef = useRef<(() => Promise<void>) | null>(null);
  const start = useRef(once(async () => startRef.current?.())).current;

  startRef.current = async () => {
    endingRef.current = false;
    firstResponseRef.current = false;
    sessionRef.current = null;
    setNote(null);
    dispatch({ type: "start" });
    startedAtRef.current = Date.now();

    // Inside the press: the one moment iOS Safari lets a page start audio.
    void audioRef.current?.play().catch(() => undefined);

    if (!navigator.mediaDevices?.getUserMedia) {
      dispatch({ type: "fail", code: "mic_unsupported", retryable: false });
      report("client_error", undefined, "mic_unsupported");
      return;
    }
    report("mic_prompted");
    let track: MediaStreamTrack | undefined;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      track = stream.getAudioTracks()[0];
    } catch (err) {
      const code = micErrorCode(err);
      report(code === "mic_denied" ? "mic_denied" : "client_error", undefined, code);
      dispatch({ type: "fail", code, retryable: code !== "mic_denied" });
      return;
    }
    if (!track) {
      dispatch({ type: "fail", code: "mic_missing", retryable: true });
      return;
    }
    micRef.current = track;
    dispatch({ type: "mic_granted" });

    let res: Response;
    try {
      res = await fetch(`${base}/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: tokenRef.current }),
      });
    } catch {
      stopMic();
      report("client_error", undefined, "network");
      dispatch({ type: "fail", code: "network", retryable: true });
      return;
    }
    const data = (await res.json().catch(() => ({}))) as { session?: Session; error?: string; retryable?: boolean };
    if (!res.ok || !data.session) {
      stopMic();
      const code = startErrorCode(res.status, data.error);
      report("client_error", undefined, code);
      if (res.status === 401) {
        try {
          sessionStorage.removeItem(TOKEN_KEY);
        } catch {
          /* ignore */
        }
      }
      dispatch({ type: "fail", code, retryable: Boolean(data.retryable) || code === "failed" });
      return;
    }
    const session = data.session;
    sessionRef.current = session;

    try {
      const { createCall } = await import("@/lib/video/client/calls");
      const call = await createCall({
        session,
        micTrack: track,
        media: { video: videoRef.current, audio: audioRef.current },
        onEvent: onCallEvent,
        mockUrl: `${base}/mock`,
      });
      callRef.current = call;
      await call.join();
      report("ready", Date.now() - startedAtRef.current);
    } catch {
      report("client_error", undefined, "join_failed");
      await end("error", { silent: true });
      dispatch({ type: "fail", code: "network", retryable: true });
    }
  };

  // Leaving the page: stop everything, and tell the server by beacon.
  useEffect(() => {
    const leave = () => {
      if (!sessionRef.current || endingRef.current) return;
      endingRef.current = true;
      endOnServer("unload", true);
      void callRef.current?.leave();
      stopMic();
    };
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, [endOnServer, stopMic]);

  // The clock, the warning and the end.
  useEffect(() => {
    if (state.phase !== "live") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [state.phase]);

  const limit = sessionRef.current?.maxCallSeconds ?? maxCallSeconds;
  const warnBefore = sessionRef.current?.warnBeforeSeconds ?? 30;
  const duration = durationView(state.joinedAt, now, limit, warnBefore);

  useEffect(() => {
    if (state.phase !== "live") return;
    if (duration.phase === "warning" && !state.warned) dispatch({ type: "warn" });
    if (duration.phase === "over") void end("duration");
  }, [duration.phase, state.phase, state.warned, end]);

  // Focus follows the state, so a keyboard is never left on a button that vanished.
  useEffect(() => {
    if (state.phase === "intro" || state.phase === "ended" || state.phase === "error") {
      startButtonRef.current?.focus({ preventScroll: true });
    }
  }, [state.phase]);

  function toggleMute() {
    const muted = !state.muted;
    callRef.current?.setMuted(muted);
    dispatch({ type: "mute", muted });
  }

  async function handover() {
    const session = sessionRef.current;
    if (!session) return;
    const res = await fetch(`${base}/session/handover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: session.sessionId, clientToken: session.clientToken }),
    }).catch(() => null);
    const data = (await res?.json().catch(() => ({}))) as { say?: string } | undefined;
    if (res?.ok && data?.say) {
      callRef.current?.say(data.say);
      setNote(`${agentName} will take your details so someone from the team can get back to you.`);
    } else {
      setNote("That didn't go through. You can ask out loud to speak to a person.");
    }
  }

  async function switchTo(kind: "chat" | "voice") {
    const href = kind === "chat" ? chatHref : voiceHref;
    if (!href) return;
    report(kind === "chat" ? "fallback_chat" : "fallback_voice");
    await end(kind === "chat" ? "switch_chat" : "switch_voice");
    window.location.href = href;
  }

  function sendTyped(e: React.FormEvent) {
    e.preventDefault();
    const text = typed.trim();
    if (!text) return;
    callRef.current?.say(text);
    setTyped("");
  }

  const inCall = state.phase === "mic" || state.phase === "connecting" || state.phase === "live";
  const resting = state.phase === "intro" || state.phase === "ended" || state.phase === "error";
  const status = statusText(state, agentName);

  return (
    <div className="bv" data-phase={state.phase} data-provider={provider}>
      <style>{CSS}</style>

      <header className="bv-top">
        <span className="bv-ai">AI concierge</span>
        <span className="bv-who">
          <strong>{agentName}</strong>
          <em>{venueName}</em>
        </span>
        {state.phase === "live" && (
          <span className="bv-time" aria-label={`${clock(duration.remaining)} left in this call`}>
            {clock(duration.remaining)}
          </span>
        )}
      </header>

      <section className="bv-stage" aria-label={`Video call with ${agentName}`}>
        <video
          ref={videoRef}
          className={`bv-face${faceVisible ? " is-on" : ""}`}
          playsInline
          autoPlay
          muted
          aria-label={`${agentName}, AI concierge`}
          onLoadedData={() => {
            setFaceVisible(true);
            report("first_frame", Date.now() - startedAtRef.current);
          }}
        />
        {/* The face's voice. Separate from the video so the video can stay muted for autoplay. */}
        <audio ref={audioRef} autoPlay />

        {!faceVisible && (
          <div className={`bv-placeholder${state.phase === "connecting" || state.phase === "mic" ? " is-loading" : ""}`} aria-hidden="true">
            <span className={`bv-avatar${state.agentSpeaking ? " is-speaking" : ""}`}>{agentName.slice(0, 1)}</span>
          </div>
        )}

        {provider === "mock" && (
          <p className="bv-mock" role="note">
            MOCK — not a live avatar
          </p>
        )}

        <p className="bv-status" role="status" aria-live="polite">
          <span className={`bv-dot${state.agentSpeaking ? " is-speaking" : state.reconnecting ? " is-warn" : ""}`} aria-hidden="true" />
          {status}
        </p>

        {state.phase === "live" && showCaptions && (state.captions.agent || state.captions.visitor) && (
          <div className="bv-captions" aria-live="polite">
            {state.captions.visitor && (
              <p>
                <b>You:</b> {state.captions.visitor}
              </p>
            )}
            {state.captions.agent && (
              <p>
                <b>{agentName}:</b> {state.captions.agent}
              </p>
            )}
          </div>
        )}
      </section>

      {state.phase === "live" && state.warned && (
        <p className="bv-warning" role="alert">
          About {Math.max(1, Math.round(duration.remaining))} seconds left. {agentName} will wrap up soon.
        </p>
      )}
      {note && inCall && (
        <p className="bv-note" role="status">
          {note}
        </p>
      )}

      {resting && (
        <div className="bv-panel">
          {state.phase === "intro" && (
            <>
              <h1>Talk face to face with {agentName}</h1>
              <p>
                {agentName} is an AI concierge for {venueName}. When you start, your browser will ask to use your microphone so{" "}
                {agentName} can hear you. Your camera stays off and the call isn&rsquo;t recorded.
              </p>
            </>
          )}
          {state.phase === "error" && state.error && (
            <p className="bv-error" role="alert">
              {errorCopy(state.error, agentName)}
            </p>
          )}
          {state.phase === "ended" && <p>The call has ended. Thanks for talking with {agentName}.</p>}

          <div className="bv-actions">
            {(state.phase !== "error" || state.retryable) && state.error !== "unavailable" && state.error !== "expired" && (
              <button ref={startButtonRef} type="button" className="bv-btn bv-primary" onClick={() => void start()}>
                {state.phase === "intro" ? "Start video call" : state.phase === "ended" ? "Start again" : "Try again"}
              </button>
            )}
            {chatHref && (
              <button type="button" className="bv-btn" onClick={() => void switchTo("chat")}>
                Chat instead
              </button>
            )}
            {voiceHref && (
              <button type="button" className="bv-btn" onClick={() => void switchTo("voice")}>
                Voice call
              </button>
            )}
          </div>
          {state.phase === "intro" && <p className="bv-small">Calls end after {Math.round(maxCallSeconds / 60)} minutes.</p>}
        </div>
      )}

      {inCall && (
        <div className="bv-controls">
          {provider === "mock" && state.phase === "live" && (
            <form className="bv-type" onSubmit={sendTyped}>
              <label htmlFor="bv-typed" className="bv-sr">
                Say something (mock: typed instead of spoken)
              </label>
              <input
                id="bv-typed"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder="Mock: type what you'd say"
                autoComplete="off"
                maxLength={500}
              />
              <button type="submit" className="bv-btn">
                Say
              </button>
            </form>
          )}
          <div className="bv-row">
            <button
              type="button"
              className="bv-btn bv-round"
              aria-pressed={state.muted}
              aria-label={state.muted ? "Unmute microphone" : "Mute microphone"}
              onClick={toggleMute}
              disabled={state.phase !== "live"}
            >
              <MicIcon off={state.muted} />
              <span>{state.muted ? "Unmute" : "Mute"}</span>
            </button>
            <button type="button" className="bv-btn bv-round bv-end" aria-label="End call" onClick={() => void end("visitor")}>
              <EndIcon />
              <span>End</span>
            </button>
            {chatHref && (
              <button type="button" className="bv-btn bv-round" aria-label="Switch to chat" onClick={() => void switchTo("chat")}>
                <ChatIcon />
                <span>Chat</span>
              </button>
            )}
            <button
              type="button"
              className="bv-btn bv-round"
              aria-label="Talk to a person"
              onClick={() => void handover()}
              disabled={state.phase !== "live"}
            >
              <PersonIcon />
              <span>Person</span>
            </button>
            <button
              type="button"
              className="bv-btn bv-round"
              aria-pressed={showCaptions}
              aria-label={showCaptions ? "Hide captions" : "Show captions"}
              onClick={() => setShowCaptions((v) => !v)}
            >
              <CcIcon />
              <span>Captions</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function MicIcon({ off }: { off: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
      <path d="M6 11a6 6 0 0 0 12 0M12 17v3M9 20h6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      {off && <path d="M4 4l16 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />}
    </svg>
  );
}

function EndIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3.5 14.5c4.6-4.2 12.4-4.2 17 0l-2.3 2.6-3.3-1.4v-2.3a9.6 9.6 0 0 0-5.8 0v2.3l-3.3 1.4Z"
        fill="currentColor"
      />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 11.2C3 6.9 7.03 3.5 12 3.5s9 3.4 9 7.7c0 4.3-4.03 7.7-9 7.7a11 11 0 0 1-2.4-.26L5.4 20.5l.5-3.2A7.7 7.7 0 0 1 3 11.2Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PersonIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="8" r="3.6" stroke="currentColor" strokeWidth="1.6" />
      <path d="M5 20a7 7 0 0 1 14 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function CcIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="5.5" width="18" height="13" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M10.5 10.3a2.2 2.2 0 1 0 0 3.4M16.5 10.3a2.2 2.2 0 1 0 0 3.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/**
 * On the brand tokens (public/brand/tokens.css), loaded by the root layout.
 * The stage is the navy band — a face reads best on dark — and everything
 * around it is the paper of the chat panel beside it.
 */
const CSS = `
* { box-sizing: border-box }
html, body { margin: 0; height: 100%; background: var(--bl-ground) }
.bv {
  height: 100dvh; min-height: 100%;
  display: grid; grid-template-rows: auto minmax(0, 1fr) auto;
  background: var(--bl-ground); color: var(--bl-ink-900);
  font-family: var(--bl-font-text); font-size: 15px; line-height: 1.5;
  padding: env(safe-area-inset-top) env(safe-area-inset-right) 0 env(safe-area-inset-left);
  overflow: hidden; -webkit-font-smoothing: antialiased;
}
.bv-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap }

.bv-top { display: flex; align-items: center; gap: var(--bl-space-3); padding: var(--bl-space-3) var(--bl-space-4);
  border-bottom: 1px solid var(--bl-border); min-width: 0 }
.bv-ai { flex: none; font-size: 11.5px; font-weight: 600; letter-spacing: var(--bl-track-label); text-transform: uppercase;
  color: var(--bl-accent-text); background: var(--bl-blue-tint); border-radius: var(--bl-radius-pill); padding: 4px 9px }
.bv-who { display: grid; min-width: 0 }
.bv-who strong { font-family: var(--bl-font-display); font-weight: var(--bl-weight-heading); font-size: 15px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
.bv-who em { font-style: normal; font-size: 12.5px; color: var(--bl-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
.bv-time { margin-left: auto; font-variant-numeric: tabular-nums; font-size: 13px; color: var(--bl-text-2) }

.bv-stage { position: relative; min-height: 0; background: var(--bl-navy); color: var(--bl-on-navy); overflow: hidden;
  display: grid; place-items: center }
.bv-face { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0; transition: opacity .3s ease }
.bv-face.is-on { opacity: 1 }
.bv-placeholder { position: absolute; inset: 0; display: grid; place-items: center;
  background: radial-gradient(circle at 50% 40%, var(--bl-navy-card), var(--bl-navy) 70%) }
.bv-placeholder.is-loading::after { content: ""; position: absolute; inset: 0;
  background: linear-gradient(100deg, transparent 30%, var(--bl-navy-line) 50%, transparent 70%);
  background-size: 200% 100%; animation: bv-shimmer 1.6s linear infinite }
.bv-avatar { width: 112px; height: 112px; border-radius: 50%; display: grid; place-items: center;
  font-family: var(--bl-font-display); font-size: 44px; font-weight: 600;
  background: var(--bl-navy-card); color: var(--bl-blue-lit); border: 2px solid var(--bl-navy-line);
  transition: box-shadow .2s ease }
.bv-avatar.is-speaking { box-shadow: 0 0 0 6px var(--bl-navy-line), 0 0 0 12px var(--bl-navy-line) }
.bv-mock { position: absolute; top: var(--bl-space-3); left: 50%; transform: translateX(-50%); margin: 0;
  background: var(--bl-warning-tint); color: var(--bl-warning); border: 1px solid var(--bl-warning);
  font-weight: 700; font-size: 12.5px; letter-spacing: .02em; padding: 5px 12px; border-radius: var(--bl-radius-pill);
  white-space: nowrap; z-index: 2 }
.bv-status { position: absolute; left: var(--bl-space-3); bottom: var(--bl-space-3); margin: 0; z-index: 2;
  display: inline-flex; align-items: center; gap: 8px; font-size: 13px; padding: 5px 11px;
  border-radius: var(--bl-radius-pill); background: var(--bl-navy-card); color: var(--bl-on-navy) }
.bv-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--bl-on-navy-2) }
.bv-dot.is-speaking { background: var(--bl-blue-lit) }
.bv-dot.is-warn { background: var(--bl-warning-tint) }
.bv-captions { position: absolute; left: var(--bl-space-3); right: var(--bl-space-3); bottom: 52px; z-index: 2;
  display: grid; gap: 4px; max-height: 40%; overflow: hidden }
.bv-captions p { margin: 0; padding: 6px 10px; border-radius: var(--bl-radius-input); background: var(--bl-navy-card);
  color: var(--bl-on-navy); font-size: 14px; line-height: 1.4 }
.bv-captions b { color: var(--bl-on-navy-2); font-weight: 600 }

.bv-warning, .bv-note { margin: 0; padding: var(--bl-space-2) var(--bl-space-4); font-size: 13.5px }
.bv-warning { background: var(--bl-warning-tint); color: var(--bl-warning); font-weight: 600 }
.bv-note { background: var(--bl-surface); color: var(--bl-text-2) }

.bv-panel { padding: var(--bl-space-4) var(--bl-space-4) max(var(--bl-space-4), env(safe-area-inset-bottom)); display: grid; gap: var(--bl-space-3) }
.bv-panel h1 { margin: 0; font-family: var(--bl-font-display); font-weight: var(--bl-weight-heading);
  letter-spacing: var(--bl-track-h2); font-size: 19px; line-height: 1.25 }
.bv-panel p { margin: 0; color: var(--bl-text-2); font-size: 14px }
.bv-panel .bv-error { color: var(--bl-danger) }
.bv-small { font-size: 12.5px !important; color: var(--bl-muted) !important }
.bv-actions { display: flex; flex-wrap: wrap; gap: var(--bl-space-2) }

.bv-btn { appearance: none; border: 1px solid var(--bl-rule-strong); background: var(--bl-ground); color: var(--bl-ink-900);
  font: inherit; font-weight: 600; font-size: 14.5px; min-height: 48px; padding: 0 18px; border-radius: var(--bl-radius-pill);
  cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 8px; touch-action: manipulation }
.bv-btn:hover { background: var(--bl-sunken) }
.bv-btn:focus-visible { outline: var(--bl-focus); outline-offset: var(--bl-focus-offset) }
.bv-btn:disabled { opacity: .45; cursor: default }
.bv-btn svg { width: 22px; height: 22px; flex: none }
.bv-primary { background: var(--bl-blue); border-color: var(--bl-blue); color: var(--bl-white) }
.bv-primary:hover { background: var(--bl-blue-hover) }

.bv-controls { padding: var(--bl-space-3) var(--bl-space-3) max(var(--bl-space-3), env(safe-area-inset-bottom));
  border-top: 1px solid var(--bl-border); display: grid; gap: var(--bl-space-2) }
.bv-row { display: flex; justify-content: center; gap: var(--bl-space-2); flex-wrap: nowrap }
.bv-round { flex-direction: column; gap: 2px; min-width: 60px; min-height: 60px; padding: 6px 8px; border-radius: var(--bl-radius-card);
  font-size: 11.5px; font-weight: 600 }
.bv-round[aria-pressed="true"] { background: var(--bl-blue-tint); border-color: var(--bl-blue-line); color: var(--bl-accent-text) }
.bv-end { background: var(--bl-danger); border-color: var(--bl-danger); color: var(--bl-white) }
.bv-end:hover { background: var(--bl-danger); filter: brightness(.92) }
.bv-type { display: flex; gap: var(--bl-space-2) }
.bv-type input { flex: 1; min-width: 0; min-height: 44px; padding: 0 12px; border-radius: var(--bl-radius-input);
  border: 1px solid var(--bl-rule-strong); font: inherit; font-size: 16px; color: var(--bl-ink-900); background: var(--bl-ground) }
.bv-type input:focus-visible { outline: var(--bl-focus); outline-offset: 1px }

@keyframes bv-shimmer { from { background-position: 200% 0 } to { background-position: -200% 0 } }

@media (max-width: 520px) {
  /* embed.js puts its close button in the top corner over the frame on a phone. */
  .bv-top { padding-right: 56px }
  .bv-round { min-width: 56px; min-height: 60px }
  .bv-row { gap: 6px }
}
@media (orientation: landscape) and (max-height: 500px) {
  .bv { grid-template-columns: minmax(0, 1fr) auto; grid-template-rows: auto minmax(0, 1fr) }
  .bv-top { grid-column: 1 / -1 }
  .bv-stage { grid-row: 2; grid-column: 1 }
  .bv-controls, .bv-panel { grid-row: 2; grid-column: 2; border-top: 0; border-left: 1px solid var(--bl-border);
    align-content: center; max-width: 320px; overflow-y: auto }
  .bv-row { flex-wrap: wrap; max-width: 200px }
  .bv-warning, .bv-note { display: none }
}
@media (prefers-reduced-motion: reduce) {
  .bv-face, .bv-avatar { transition: none }
  .bv-placeholder.is-loading::after { animation: none }
}
`;

"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  INITIAL,
  captionLine,
  clock,
  durationView,
  durationWords,
  errorCopy,
  micErrorCode,
  once,
  reduce,
  startErrorCode,
  statusText,
  type CallEvent,
} from "@/lib/video/client/machine";
import type { CallAdapter, CallSession } from "@/lib/video/client/calls";
import Greenscreen from "./Greenscreen";

/**
 * The video receptionist's call view.
 *
 * One round face that changes state rather than a sequence of pages, because
 * the visitor's eyes are on a face and the face should not move: microphone,
 * connecting, live, ended, and an error that always offers the chat.
 *
 * Two ways it is shown:
 *
 * **Inside the bubble** (`bubble`, from embed-video.js). Chromeless and
 * transparent: the frame is exactly the circle's width and is laid over the
 * page's own greeting circle, so the call happens in the circle the visitor
 * tapped. Under it, one status pill, one caption line when captions are on,
 * and two controls, Mute and End, with a small "…" menu (a person, captions)
 * and "Type instead". "AI concierge" is the page's pill on the circle's top
 * edge; the timer is this frame's pill on its bottom edge. The frame tells the
 * page its height, when it is drawn, when the face appears, and when the call
 * has ended or moved to chat, by postMessage to the one origin that framed it.
 *
 * **On its own** (the widget's fallback, a direct link). The same circle and
 * controls on a page of their own, with an intro and a Start button.
 *
 * Decisions worth keeping:
 *
 * **Nothing is spent before the tap.** The microphone is asked for inside
 * Start (or straight away when the bubble's tap already said "talk"), and the
 * session is created only once the microphone is granted.
 *
 * **The camera is never asked for.** Perception is off, so there is no camera
 * button to find and no camera prompt to refuse.
 *
 * **Never silently mute.** The face's voice plays through its own <audio>. If
 * the browser refuses it, or leaves it paused, "Tap to hear Belle" sits on the
 * circle until a tap lets it play (calls.ts `playVoice`).
 *
 * **Leaving always cleans up.** End, switching to chat, the page's ×, and the
 * page unloading all stop the microphone, leave the room and tell the server,
 * the last by beacon, which survives the page going away.
 *
 * `@daily-co/daily-js` is not imported here: `calls.ts` loads it on start.
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
  /** Opened from the greeting bubble's tap: start at once, the tap was the intent. */
  autostart?: boolean;
  /** Drawn inside the page's bubble: chromeless, transparent, sized by the page. */
  bubble?: boolean;
  /** The page that framed us, already checked against the venue's list: where our messages go. */
  hostOrigin?: string;
  /** The face's muted preview (and its still), shown in the circle until the live face arrives. */
  previewClipUrl?: string;
  previewPosterUrl?: string;
};

type Session = CallSession & { maxCallSeconds: number; warnBeforeSeconds: number; captions: boolean; perception: boolean };

const TOKEN_KEY = "belline.video.visitor";
/** How long "Call ended" shows in the bubble before the page shrinks it back. */
const ENDED_LINGER_MS = 1200;

export default function VideoPanel({
  embedKey,
  freshToken,
  venueName,
  agentName,
  provider,
  maxCallSeconds,
  chatHref,
  voiceHref,
  autostart,
  bubble,
  hostOrigin,
  previewClipUrl,
  previewPosterUrl,
}: Props) {
  const [state, dispatch] = useReducer(reduce, INITIAL);
  const [now, setNow] = useState(() => Date.now());
  // Off until asked for: the face is the conversation, words under it are an aid.
  const [showCaptions, setShowCaptions] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [faceVisible, setFaceVisible] = useState(false);
  // The venue's background, when the session has one: the face is keyed onto it (Greenscreen.tsx).
  const [background, setBackground] = useState("");
  const [keyed, setKeyed] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const sessionRef = useRef<Session | null>(null);
  const callRef = useRef<CallAdapter | null>(null);
  const micRef = useRef<MediaStreamTrack | null>(null);
  const tokenRef = useRef(freshToken);
  const startedAtRef = useRef(0);
  const firstResponseRef = useRef(false);
  const endingRef = useRef(false);
  const startButtonRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);

  const base = `/api/video/${encodeURIComponent(embedKey)}`;

  /** A message for the page around the bubble, and only for the origin that framed us. */
  const tellHost = useCallback(
    (message: Record<string, unknown>) => {
      if (!bubble || !hostOrigin || typeof window === "undefined" || window.parent === window) return;
      try {
        window.parent.postMessage({ source: "belline-video", ...message }, hostOrigin);
      } catch {
        /* a page that went away cannot be told */
      }
    },
    [bubble, hostOrigin],
  );

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
      setMoreOpen(false);
      endOnServer(reason);
      // Silent when a failure is about to be shown instead.
      if (!opts.silent) dispatch({ type: "ended", reason });
    },
    [endOnServer, stopMic],
  );

  const onCallEvent = useCallback(
    (event: CallEvent) => {
      dispatch({ type: "call", event, now: Date.now() });
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

    // Everything slow starts at once, after the tap and never before it: the
    // call client's code (and Daily's, for a live face), the session (3–4 s at
    // Tavus), and the microphone prompt. Only a microphone the browser has
    // already refused holds the session back, since it could never be used.
    const client = import("@/lib/video/client/calls").then((m) => {
      m.preloadCallClient(provider);
      return m;
    });
    client.catch(() => undefined);
    const refused = await micAlreadyRefused();
    const sessionReply = refused ? null : requestSession();

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
      discardSession(sessionReply, "mic_refused");
      return;
    }
    if (!track) {
      dispatch({ type: "fail", code: "mic_missing", retryable: true });
      discardSession(sessionReply, "mic_missing");
      return;
    }
    micRef.current = track;
    dispatch({ type: "mic_granted" });

    const reply = await (sessionReply ?? requestSession());
    if (!reply.res) {
      stopMic();
      report("client_error", undefined, "network");
      dispatch({ type: "fail", code: "network", retryable: true });
      return;
    }
    const { res, data } = reply;
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
    setBackground(session.background?.src ?? "");
    // Closed while the session was being made: it ends now rather than waiting out its timer.
    if (endingRef.current) {
      endOnServer("visitor");
      stopMic();
      return;
    }

    try {
      const { createCall } = await client;
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

  type SessionReply = { res: Response | null; data: { session?: Session; error?: string; retryable?: boolean } };

  /** Create the session. Never throws: a network failure is `res: null`. */
  function requestSession(): Promise<SessionReply> {
    return fetch(`${base}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: tokenRef.current }),
    }).then(
      async (res) => ({ res, data: (await res.json().catch(() => ({}))) as SessionReply["data"] }),
      () => ({ res: null, data: {} }),
    );
  }

  /** A session made beside a microphone that then failed: ended at once, never left to its timer. */
  function discardSession(reply: Promise<SessionReply> | null, reason: string) {
    void reply?.then(({ res, data }) => {
      const session = data.session;
      if (!res?.ok || !session) return;
      void fetch(`${base}/session/end`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: session.sessionId, clientToken: session.clientToken, reason }),
        keepalive: true,
      }).catch(() => undefined);
    });
  }
  // The bubble's tap already said "talk": start without a second press. The
  // microphone prompt is the browser's own, with the hint on screen beside it.
  useEffect(() => {
    if (autostart) void start();
    // Once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The page around the frame closed the call (its ×): end it properly here.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { source?: string; type?: string } | null;
      if (e.source !== window.parent || data?.source !== "belline-host" || data.type !== "end") return;
      void end("visitor");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [end]);

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

  // Inside the bubble: say we are drawn, and keep the page told of our height.
  useEffect(() => {
    if (!bubble) return;
    const node = rootRef.current;
    if (!node) return;
    let last = 0;
    const send = () => {
      const height = Math.ceil(node.getBoundingClientRect().height);
      if (height && height !== last) {
        last = height;
        tellHost({ type: "size", height });
      }
    };
    send();
    const raf = requestAnimationFrame(() => {
      send();
      tellHost({ type: "ready" });
    });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(send) : null;
    observer?.observe(node);
    return () => {
      cancelAnimationFrame(raf);
      observer?.disconnect();
    };
  }, [bubble, tellHost]);

  useEffect(() => {
    if (faceVisible) tellHost({ type: "face" });
  }, [faceVisible, tellHost]);

  // Inside the bubble, an ended call gives the page back its resting bubble.
  useEffect(() => {
    if (!bubble || state.phase !== "ended") return;
    const timer = setTimeout(() => tellHost({ type: "ended" }), ENDED_LINGER_MS);
    return () => clearTimeout(timer);
  }, [bubble, state.phase, tellHost]);

  // Escape: the menu first, then (inside the bubble) the call.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (moreOpen) {
        setMoreOpen(false);
        return;
      }
      if (bubble) {
        void end("visitor", { silent: true });
        tellHost({ type: "ended" });
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [bubble, end, moreOpen, tellHost]);

  // The menu closes on a tap anywhere else.
  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: PointerEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [moreOpen]);

  // While the voice is blocked, any tap on the call is the gesture that unblocks it.
  const unlockAudio = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    void audio
      .play()
      .then(() => dispatch({ type: "audio_unlocked" }))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!state.audioBlocked) return;
    document.addEventListener("pointerdown", unlockAudio);
    return () => document.removeEventListener("pointerdown", unlockAudio);
  }, [state.audioBlocked, unlockAudio]);

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
    setMoreOpen(false);
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
    // Inside the bubble the page opens its own chat or call where the bubble was.
    if (bubble && hostOrigin) {
      await end(kind === "chat" ? "switch_chat" : "switch_voice", { silent: true });
      tellHost({ type: "switch", to: kind });
      return;
    }
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
  // About as many characters as fit on one line of the circle's width.
  const captionChars = bubble && typeof window !== "undefined" ? Math.max(28, Math.floor((window.innerWidth - 48) / 7.4)) : 90;
  const caption = showCaptions && state.phase === "live" ? captionLine(state, agentName, captionChars) : "";
  const canRetry = (state.phase !== "error" || state.retryable) && state.error !== "unavailable" && state.error !== "expired";

  return (
    <div
      ref={rootRef}
      className={`bv${bubble ? " is-bubble" : ""}`}
      data-phase={state.phase}
      data-provider={provider}
    >
      <style>{CSS + (bubble ? BUBBLE_CSS : "")}</style>

      <section className="bv-stage" aria-label={`Video call with ${agentName}, AI concierge for ${venueName}`}>
        <div className={`bv-orb${state.agentSpeaking ? " is-speaking" : ""}`}>
          {/* Inside the bubble the page's own pill says it, on the same edge. */}
          {!bubble && <span className="bv-ai">AI concierge</span>}
          <div className="bv-circle">
            <video
              ref={videoRef}
              className={`bv-face${faceVisible && !keyed ? " is-on" : ""}`}
              playsInline
              autoPlay
              muted
              aria-label={`${agentName}, AI concierge`}
              onLoadedData={() => {
                setFaceVisible(true);
                report("first_frame", Date.now() - startedAtRef.current);
              }}
            />
            {background && <Greenscreen videoRef={videoRef} src={background} live={faceVisible} onKeyed={setKeyed} />}
            {/* The face's voice. Separate from the video so the video can stay muted for autoplay. Played by calls.ts
                `playVoice`, never by the autoplay attribute, so a refusal is always seen and never silent. */}
            <audio ref={audioRef} onPlaying={() => dispatch({ type: "audio_unlocked" })} />

            {/* While connecting, the face's own preview, so the wait looks like her and not a letter.
                The live stream fades in over it. */}
            {previewPosterUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="bv-preview" src={previewPosterUrl} alt="" aria-hidden="true" />
            )}
            {previewClipUrl && !faceVisible && (
              <video className="bv-preview bv-preview-clip" src={previewClipUrl} poster={previewPosterUrl || undefined} muted loop autoPlay playsInline aria-hidden="true" />
            )}
            {!faceVisible && !previewClipUrl && !previewPosterUrl && (
              <div className={`bv-placeholder${state.phase === "connecting" || state.phase === "mic" ? " is-loading" : ""}`} aria-hidden="true">
                <span className={`bv-avatar${state.agentSpeaking ? " is-speaking" : ""}`}>{agentName.slice(0, 1)}</span>
              </div>
            )}

            {provider === "mock" && (
              <p className="bv-mock" role="note">
                MOCK — not a live avatar
              </p>
            )}
          </div>

          {state.audioBlocked && inCall && (
            <button type="button" className="bv-sound" onClick={unlockAudio}>
              <SpeakerIcon />
              Tap to hear {agentName}
            </button>
          )}

          {state.phase === "live" && (
            <span className="bv-time" aria-label={`${clock(duration.remaining)} left in this call`}>
              {clock(duration.remaining)}
            </span>
          )}
        </div>

        <p className="bv-status" role="status" aria-live="polite">
          <span className={`bv-dot${state.agentSpeaking ? " is-speaking" : state.reconnecting ? " is-warn" : ""}`} aria-hidden="true" />
          {status}
        </p>

        {caption && (
          <p className="bv-caption" aria-live="polite">
            {caption}
          </p>
        )}

        {state.phase === "mic" && <p className="bv-hint">Allow your microphone so {agentName} can hear you. Your camera stays off.</p>}
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
      </section>

      {resting && !(bubble && state.phase !== "error") && (
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
            {canRetry && (
              <button ref={startButtonRef} type="button" className="bv-btn bv-primary" onClick={() => void start()}>
                {state.phase === "intro" ? "Start video call" : state.phase === "ended" ? "Start again" : "Try again"}
              </button>
            )}
            {chatHref && (
              <button type="button" className="bv-btn" onClick={() => void switchTo("chat")}>
                {bubble ? "Type instead" : "Chat instead"}
              </button>
            )}
            {voiceHref && !bubble && (
              <button type="button" className="bv-btn" onClick={() => void switchTo("voice")}>
                Voice call
              </button>
            )}
          </div>
          {state.phase === "intro" && <p className="bv-small">Calls end after {durationWords(maxCallSeconds)}.</p>}
        </div>
      )}

      {inCall && (
        <div className="bv-controls">
          <div className="bv-row">
            <span aria-hidden="true" />
            <button
              type="button"
              className="bv-ctl"
              aria-pressed={state.muted}
              aria-label={state.muted ? "Unmute microphone" : "Mute microphone"}
              onClick={toggleMute}
              disabled={state.phase !== "live"}
            >
              <span className="bv-ctl-i">
                <MicIcon off={state.muted} />
              </span>
              <span className="bv-ctl-t">{state.muted ? "Unmute" : "Mute"}</span>
            </button>
            <button type="button" className="bv-ctl bv-end" aria-label="End call" onClick={() => void end("visitor")}>
              <span className="bv-ctl-i">
                <EndIcon />
              </span>
              <span className="bv-ctl-t">End</span>
            </button>
            <div className="bv-more" ref={moreRef}>
              <button
                type="button"
                className="bv-ctl bv-ctl-more"
                aria-label="More options"
                aria-haspopup="menu"
                aria-expanded={moreOpen}
                onClick={() => setMoreOpen((v) => !v)}
              >
                <span className="bv-ctl-i">
                  <MoreIcon />
                </span>
                <span className="bv-ctl-t">More</span>
              </button>
              {moreOpen && (
                <div className="bv-menu" role="menu" aria-label="More options">
                  <button type="button" role="menuitem" onClick={() => void handover()} disabled={state.phase !== "live"}>
                    <PersonIcon />
                    <span>Talk to a person</span>
                  </button>
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={showCaptions}
                    onClick={() => {
                      setShowCaptions((v) => !v);
                      setMoreOpen(false);
                    }}
                  >
                    <CcIcon />
                    <span>Captions</span>
                    <em>{showCaptions ? "On" : "Off"}</em>
                  </button>
                </div>
              )}
            </div>
          </div>
          {chatHref && (
            <button type="button" className="bv-link" onClick={() => void switchTo("chat")}>
              Type instead
            </button>
          )}
          {provider === "mock" && state.phase === "live" && !bubble && (
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
        </div>
      )}
    </div>
  );
}

/** The browser has already said no to the microphone for this site (where it will say). */
async function micAlreadyRefused(): Promise<boolean> {
  try {
    const query = navigator.permissions?.query({ name: "microphone" as PermissionName });
    if (!query) return false;
    // Never a wait of its own: a browser slow to say is treated as not having refused.
    const status = await Promise.race([query, new Promise<null>((resolve) => setTimeout(() => resolve(null), 150))]);
    return status?.state === "denied";
  } catch {
    return false;
  }
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

function MoreIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="6" cy="12" r="1.7" fill="currentColor" />
      <circle cx="12" cy="12" r="1.7" fill="currentColor" />
      <circle cx="18" cy="12" r="1.7" fill="currentColor" />
    </svg>
  );
}

function SpeakerIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4Z" fill="currentColor" />
      <path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.6 7.6 0 0 1 0 11" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
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
 * The face is on the navy circle; everything around it is paper, grey and the
 * one blue.
 */
const CSS = `
* { box-sizing: border-box }
html, body { margin: 0; height: 100%; background: var(--bl-ground) }
.bv {
  height: 100dvh; min-height: 100%;
  display: grid; grid-template-rows: minmax(0, 1fr) auto;
  background: var(--bl-ground); color: var(--bl-ink-900);
  font-family: var(--bl-font-text); font-size: 15px; line-height: 1.5;
  padding: env(safe-area-inset-top) env(safe-area-inset-right) 0 env(safe-area-inset-left);
  overflow: hidden; -webkit-font-smoothing: antialiased;
}
.bv-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap }

/* The face in a circle, one status pill under it, one caption line, two controls. */
.bv-stage { position: relative; min-height: 0; background: transparent;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 18px; padding: 28px 16px 8px }
.bv-orb { position: relative; flex: none; width: min(300px, 72vw, 46dvh) }
.bv-circle { position: relative; width: 100%; aspect-ratio: 1; border-radius: 50%;
  overflow: hidden; background: var(--bl-navy); color: var(--bl-on-navy);
  box-shadow: 0 0 0 3px var(--bl-ground), 0 0 0 4px var(--bl-blue-line), var(--bl-elev-float); transition: box-shadow .2s ease }
.bv-orb.is-speaking .bv-circle { box-shadow: 0 0 0 3px var(--bl-ground), 0 0 0 5px var(--bl-blue), var(--bl-elev-float) }
.bv-preview { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block }
.bv-face { position: absolute; inset: 0; z-index: 1; width: 100%; height: 100%; object-fit: cover; opacity: 0; transition: opacity .4s ease }
.bv-face.is-on { opacity: 1 }
.bv-placeholder { position: absolute; inset: 0; display: grid; place-items: center;
  background: radial-gradient(circle at 50% 40%, var(--bl-navy-card), var(--bl-navy) 70%) }
.bv-placeholder.is-loading::after { content: ""; position: absolute; inset: 0;
  background: linear-gradient(100deg, transparent 30%, var(--bl-navy-line) 50%, transparent 70%);
  background-size: 200% 100%; animation: bv-shimmer 1.6s linear infinite }
.bv-avatar { width: 38%; aspect-ratio: 1; border-radius: 50%; display: grid; place-items: center;
  font-family: var(--bl-font-display); font-size: clamp(32px, 9vw, 52px); font-weight: 600;
  background: var(--bl-navy-card); color: var(--bl-blue-lit); border: 2px solid var(--bl-navy-line);
  transition: box-shadow .2s ease }
.bv-avatar.is-speaking { box-shadow: 0 0 0 6px var(--bl-navy-line), 0 0 0 12px var(--bl-navy-line) }
.bv-mock { position: absolute; top: 15%; left: 50%; transform: translateX(-50%); margin: 0; z-index: 2;
  background: var(--bl-warning-tint); color: var(--bl-warning); border: 1px solid var(--bl-warning);
  font-weight: 700; font-size: 10.5px; letter-spacing: .02em; padding: 2px 8px; border-radius: var(--bl-radius-pill);
  white-space: nowrap; z-index: 2 }

/* The pills on the circle's edges, outside its clip. */
.bv-ai, .bv-time { position: absolute; left: 50%; z-index: 3; white-space: nowrap; border-radius: var(--bl-radius-pill) }
.bv-ai { top: 0; transform: translate(-50%, -50%); font-size: 10.5px; line-height: 1.3; font-weight: 600;
  letter-spacing: .06em; text-transform: uppercase; padding: 3px 9px;
  color: var(--bl-accent-text); background: var(--bl-blue-tint); border: 1px solid var(--bl-blue-line) }
.bv-time { bottom: 0; transform: translate(-50%, 50%); font-size: 11.5px; line-height: 1.3; font-weight: 600;
  font-variant-numeric: tabular-nums; padding: 2px 9px;
  color: var(--bl-ink-900); background: var(--bl-ground); border: 1px solid var(--bl-blue-line) }
.bv-sound { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 4;
  display: inline-flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 16px 0 13px;
  border: 0; border-radius: var(--bl-radius-pill); background: var(--bl-ground); color: var(--bl-accent-text);
  font: inherit; font-size: 14px; font-weight: 600; white-space: nowrap; cursor: pointer;
  box-shadow: 0 10px 30px -10px rgba(0, 0, 0, .45) }
.bv-sound svg { width: 20px; height: 20px; flex: none }
.bv-sound:focus-visible { outline: var(--bl-focus); outline-offset: 3px }

.bv-status { margin: 0; display: inline-flex; align-items: center; gap: 7px; font-size: 13px; line-height: 1.3; padding: 5px 12px;
  border-radius: var(--bl-radius-pill); background: var(--bl-surface); color: var(--bl-ink-900); white-space: nowrap }
.bv-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--bl-muted); flex: none }
.bv-dot.is-speaking { background: var(--bl-blue) }
.bv-dot.is-warn { background: var(--bl-warning) }
.bv-caption { margin: -8px 0 0; max-width: min(100%, 420px); font-size: 13.5px; line-height: 1.4; color: var(--bl-text-2);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: center }
.bv-hint, .bv-warning, .bv-note { margin: -6px 0 0; max-width: 34ch; text-align: center; font-size: 13px; line-height: 1.4; color: var(--bl-text-2) }
.bv-warning { color: var(--bl-warning); font-weight: 600 }

.bv-panel { padding: 8px 20px calc(24px + env(safe-area-inset-bottom)); display: grid; gap: 12px; max-width: 460px; width: 100%; margin: 0 auto }
.bv-panel h1 { margin: 0; font-family: var(--bl-font-display); font-weight: var(--bl-weight-heading);
  letter-spacing: var(--bl-track-h2); font-size: 19px; line-height: 1.25 }
.bv-panel p { margin: 0; color: var(--bl-text-2); font-size: 14px }
.bv-panel .bv-error { color: var(--bl-danger) }
.bv-small { font-size: 12.5px !important; color: var(--bl-muted) !important }
.bv-actions { display: flex; flex-wrap: wrap; gap: 8px }

.bv-btn { appearance: none; border: 1px solid var(--bl-rule-strong); background: var(--bl-ground); color: var(--bl-ink-900);
  font: inherit; font-weight: 600; font-size: 14.5px; min-height: 48px; padding: 0 18px; border-radius: var(--bl-radius-pill);
  cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 8px; touch-action: manipulation }
.bv-btn:hover { background: var(--bl-surface) }
.bv-btn:focus-visible { outline: var(--bl-focus); outline-offset: var(--bl-focus-offset) }
.bv-btn:disabled { opacity: .45; cursor: default }
.bv-primary { background: var(--bl-blue); border-color: var(--bl-blue); color: var(--bl-white) }
.bv-primary:hover { background: var(--bl-blue-hover) }

/* Two controls, centred, with the small menu beside them and a spacer opposite. */
.bv-controls { padding: 8px 16px calc(20px + env(safe-area-inset-bottom)); display: grid; justify-items: center; gap: 4px }
.bv-row { display: grid; grid-template-columns: 40px 64px 64px 40px; column-gap: 14px; align-items: start }
.bv-ctl { appearance: none; border: 0; background: none; padding: 0; margin: 0; color: var(--bl-ink-900); font: inherit;
  display: flex; flex-direction: column; align-items: center; gap: 6px; cursor: pointer; touch-action: manipulation;
  min-width: 0; width: 100% }
.bv-ctl:disabled { cursor: default }
.bv-ctl:disabled .bv-ctl-i { opacity: .5 }
.bv-ctl-i { width: 56px; height: 56px; border-radius: 50%; display: grid; place-items: center;
  background: var(--bl-surface); color: var(--bl-ink-900); border: 1px solid rgba(0, 0, 0, .06); transition: background .15s ease }
.bv-ctl-i svg { width: 24px; height: 24px }
.bv-ctl:hover:not(:disabled) .bv-ctl-i { background: var(--bl-sunken) }
.bv-ctl[aria-pressed="true"] .bv-ctl-i { background: var(--bl-ink-900); color: var(--bl-white); border-color: var(--bl-ink-900) }
.bv-end .bv-ctl-i, .bv-end:hover .bv-ctl-i { background: var(--bl-danger) !important; color: var(--bl-white); border-color: var(--bl-danger) }
.bv-end:hover .bv-ctl-i { filter: brightness(.94) }
.bv-ctl-t { font-size: 12px; line-height: 1.2; font-weight: 600; color: var(--bl-ink-900) }
.bv-ctl-more .bv-ctl-i { width: 40px; height: 40px; margin-top: 8px }
.bv-ctl-more .bv-ctl-i svg { width: 20px; height: 20px }
.bv-ctl-more .bv-ctl-t { margin-top: 8px; font-weight: 500; color: var(--bl-text-2) }
.bv-ctl-more[aria-expanded="true"] .bv-ctl-i { background: var(--bl-sunken) }
.bv-ctl:focus-visible { outline: none }
.bv-ctl:focus-visible .bv-ctl-i { outline: var(--bl-focus); outline-offset: 3px }
.bv-more { position: relative; width: 40px }
.bv-menu { position: absolute; right: -6px; bottom: calc(100% + 8px); z-index: 6; min-width: 204px; padding: 6px;
  background: var(--bl-ground); border: 1px solid var(--bl-blue-line); border-radius: 14px;
  box-shadow: 0 18px 40px -18px rgba(0, 0, 0, .35); display: grid }
.bv-menu button { appearance: none; border: 0; background: none; display: flex; align-items: center; gap: 10px;
  min-height: 44px; padding: 0 10px; border-radius: 10px; font: inherit; font-size: 14px; font-weight: 500;
  color: var(--bl-ink-900); text-align: left; cursor: pointer; white-space: nowrap }
.bv-menu button:hover:not(:disabled) { background: var(--bl-surface) }
.bv-menu button:disabled { opacity: .5; cursor: default }
.bv-menu button:focus-visible { outline: var(--bl-focus); outline-offset: -2px }
.bv-menu svg { width: 20px; height: 20px; flex: none; color: var(--bl-blue) }
.bv-menu span { flex: 1 }
.bv-menu em { font-style: normal; font-size: 12.5px; color: var(--bl-text-2) }
.bv-link { appearance: none; border: 0; background: none; font: inherit; font-size: 13.5px; font-weight: 600;
  color: var(--bl-accent-text); min-height: 40px; padding: 0 12px; cursor: pointer; border-radius: var(--bl-radius-pill) }
.bv-link:hover { text-decoration: underline; text-underline-offset: 3px }
.bv-link:focus-visible { outline: var(--bl-focus); outline-offset: 0 }
.bv-type { display: flex; gap: 8px; width: 100%; max-width: 420px; margin-top: 4px }
.bv-type input { flex: 1; min-width: 0; min-height: 44px; padding: 0 12px; border-radius: var(--bl-radius-input);
  border: 1px solid var(--bl-rule-strong); font: inherit; font-size: 16px; color: var(--bl-ink-900); background: var(--bl-ground) }
.bv-type input:focus-visible { outline: var(--bl-focus); outline-offset: 1px }
.bv-type .bv-btn { min-height: 44px }

@keyframes bv-shimmer { from { background-position: 200% 0 } to { background-position: -200% 0 } }

@media (orientation: landscape) and (max-height: 500px) {
  .bv { grid-template-columns: minmax(0, 1fr) auto; grid-template-rows: minmax(0, 1fr) }
  .bv-stage { padding-top: 22px }
  .bv-orb { width: min(52dvh, 220px) }
  .bv-controls, .bv-panel { align-content: center; max-width: 320px; overflow-y: auto }
}
@media (prefers-reduced-motion: reduce) {
  .bv-face, .bv-avatar, .bv-circle, .bv-ctl-i { transition: none }
  .bv-preview-clip { display: none }
  .bv-placeholder.is-loading::after { animation: none }
}
`;

/**
 * Inside the page's bubble: no ground, no chrome. The circle is the frame's
 * width and sits exactly over the page's own circle, which shows through until
 * the live face arrives. What lies over somebody else's page (the pills, the
 * caption line, the controls) carries its own paper so it reads on any colour.
 */
const BUBBLE_CSS = `
html, body { background: transparent !important; height: auto; overflow: hidden }
.bv.is-bubble { height: auto; min-height: 0; display: flow-root; background: transparent; padding: 0; overflow: visible }
.is-bubble .bv-stage { justify-content: flex-start; gap: 18px; padding: 0 0 2px }
.is-bubble .bv-orb { width: 100vw }
.is-bubble .bv-circle { background: transparent; box-shadow: none }
.is-bubble .bv-orb.is-speaking .bv-circle { box-shadow: inset 0 0 0 3px var(--bl-blue) }
.is-bubble .bv-placeholder { display: none }
.is-bubble .bv-status { background: var(--bl-ground); border: 1px solid var(--bl-blue-line); box-shadow: var(--bl-elev-float) }
.is-bubble .bv-caption { margin-top: -10px; max-width: 100%; padding: 4px 10px; border-radius: 10px;
  background: var(--bl-ground); border: 1px solid var(--bl-blue-line); color: var(--bl-ink-900); font-size: 13px }
.is-bubble .bv-hint, .is-bubble .bv-warning, .is-bubble .bv-note { max-width: calc(100vw - 8px); padding: 6px 12px; border-radius: 12px;
  background: var(--bl-ground); border: 1px solid var(--bl-blue-line) }
.is-bubble .bv-controls { width: max-content; max-width: 100vw; margin: 10px auto 22px; padding: 12px 10px 4px; gap: 0;
  background: var(--bl-ground); border: 1px solid var(--bl-blue-line); border-radius: 28px; box-shadow: 0 8px 18px -12px rgba(0, 0, 0, .28) }
.is-bubble .bv-row { grid-template-columns: 36px 60px 60px 36px; column-gap: 10px }
.is-bubble .bv-more { width: 36px }
.is-bubble .bv-ctl-more .bv-ctl-i { width: 36px; height: 36px; margin-top: 10px }
.is-bubble .bv-ctl-more .bv-ctl-t { margin-top: 6px }
.is-bubble .bv-ctl-i { width: 52px; height: 52px }
.is-bubble .bv-ctl-more .bv-ctl-i { width: 36px; height: 36px }
.is-bubble .bv-menu { right: -10px }
.is-bubble .bv-link { min-height: 36px; font-size: 13px }
.is-bubble .bv-panel { margin: 10px auto 12px; padding: 14px 16px; gap: 10px; width: auto; max-width: 100vw;
  background: var(--bl-ground); border: 1px solid var(--bl-blue-line); border-radius: 18px; box-shadow: var(--bl-elev-float) }
.is-bubble .bv-panel p { font-size: 13px; line-height: 1.45 }
.is-bubble .bv-actions { justify-content: center }
.is-bubble .bv-btn { min-height: 40px; font-size: 13.5px; padding: 0 14px }
`;

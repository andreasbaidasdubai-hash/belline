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
  promiseLine,
  reduce,
  startErrorCode,
  statusText,
  VIDEO_HEARTBEAT_SECONDS,
  type CallEvent,
  type VideoErrorCode,
} from "@/lib/video/client/machine";
import { END_ACTIONS, endCopy, endedUnexpectedly, type VideoEndCause } from "@/lib/video/end-reason";
import { hostGreeting, noGreeting, playGreeting, type PlayingGreeting } from "@/lib/video/client/greeting";
import { HANDOVER_LEAD_MS, QUIET_NUDGE_MS } from "@/lib/video/greeting-clip";
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
 * and two controls, Mute and End, with a small Captions toggle beside them
 * and "Type instead". (No "Talk to a person" button: asked out loud, Belle
 * takes a message or hands over.) "AI concierge" is the page's pill on the circle's top
 * edge; the timer is this frame's pill on its bottom edge. The frame tells the
 * page its height, when it is drawn, when the face appears, and when the call
 * has ended or moved to chat, by postMessage to the one origin that framed it.
 *
 * **On its own** (the widget's fallback, a direct link). The same circle and
 * controls on a page of their own, with an intro and a Start button.
 *
 * Decisions worth keeping:
 *
 * **Nothing is spent before the tap, and no room before the microphone.** The
 * microphone is asked for inside Start (or straight away when the bubble's tap
 * already said "talk"), and the session is created only once the browser has
 * granted it — a room whose visitor is still at a permission dialog is a room
 * she talks into alone while the provider's absent timer runs it out. The
 * greeting clip is what pays for that wait. `listenFirst` is the one surface
 * that still creates the room first, deliberately.
 *
 * **She is never left mute.** After the handover, if nobody in the room makes a
 * sound for `QUIET_NUDGE_MS`, she says one line of her own — different
 * depending on whether a microphone ever arrived — and the panel says so in
 * words with the typing offer beside it.
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
  /**
   * Play the preview clip aloud on the tap, as the call's opening words.
   *
   * The clip is the same face saying the one part of the greeting that is true
   * on every surface, so the visitor hears Belle immediately instead of
   * watching a silent face connect. It only works from inside the press, which
   * is why it is a property of the surfaces that have one — the bubble's tap
   * happens in the page around us, so that page plays it instead
   * (`hostGreetingMs`).
   */
  speakGreeting?: boolean;
  /**
   * The page around the bubble is playing the greeting clip, with its own tap.
   *
   * Cross-origin, a frame cannot borrow a gesture from the page that holds it,
   * and mobile Safari will not let us make a sound without one. So the bubble
   * plays the clip itself and tells us here that it did: we skip our own,
   * shorten the live greeting the same way, and wait for the page to say the
   * last word has been said before letting the live face in.
   *
   * The clip's length in milliseconds, or 0 when the page is not playing one.
   * It arrives with the frame's URL rather than as a message because the tap
   * and the frame happen in the same instant, and a message would race this
   * frame's own listener into existence.
   */
  hostGreetingMs?: number;
  /**
   * Where the session, end, event and mock requests go. The widget's own by
   * default; a personalised demo page (`/demo/v/<token>`) uses its link's.
   */
  apiBase?: string;
  /** The intro's heading, text and Start label, where a page has its own words. */
  introTitle?: string;
  introBody?: string;
  startLabel?: string;
  /**
   * Switching to chat is handled by the page (the demo page's own chat), not a
   * navigation. `recap` is the call's turns, so the chat can open with the
   * conversation already in it and the visitor does not start again from
   * nothing. Empty when the call ended before anything was said.
   */
  onChat?: (recap: { role: "agent" | "caller"; text: string }[]) => void;
  /**
   * How long a call really runs, for the intro's promise: what we have been
   * delivering, not what we ask the provider for (lib/video/delivery.ts).
   * Null: recent calls do not agree on a length, so the page promises none.
   * Undefined: no measurement was passed, so `maxCallSeconds` stands.
   */
  promisedSeconds?: number | null;
  /**
   * One tap and the face talks (the personalised demo page). The tap starts the
   * session, the call client and the microphone prompt together; the call joins
   * listening only, so the face's opening never waits on the prompt, and the
   * microphone is added when the browser grants it. Refused, she keeps talking
   * and the chat is offered. Nothing is created before the tap.
   */
  listenFirst?: boolean;
  /** A large start button laid over the face while resting, in place of the intro's heading and Start button. */
  tapLabel?: string;
  /** Fetch the call client's code (Daily, for a live face) on load, so the tap is instant. Code only: no session, no room. */
  preloadClient?: boolean;
};

type Session = CallSession & {
  maxCallSeconds: number;
  warnBeforeSeconds: number;
  captions: boolean;
  perception: boolean;
  /** What she says if the room goes quiet, in the venue's language (lib/video/sessions.ts). */
  quiet?: { noMic: string; waiting: string };
};

/** What `POST /session/end` answers (lib/video/http.ts `endedPayload`). */
type EndedAnswer = { cause: VideoEndCause; seconds: number; recap: { role: "agent" | "caller"; text: string }[] };

const TOKEN_KEY = "belline.video.visitor";
/** How long "Call ended" shows in the bubble before the page shrinks it back. */
const ENDED_LINGER_MS = 1200;
/** How long the bubble waits for the end route to say why, before giving up on a reason. */
const CAUSE_WAIT_MS = 2000;
/**
 * The crossfade from the greeting clip to the live face, and how long the clip
 * stays in the tree to perform it. Matches `.bv-face`'s own opacity
 * transition, so the two halves of the dissolve are the same length: the same
 * face in the same chair, one becoming the other rather than replacing it.
 */
const HANDOVER_FADE_MS = 400;
/** How long to let the page around the bubble say its clip was refused, before trusting it. */
const HOST_CONFIRM_MS = 250;

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
  apiBase,
  introTitle,
  introBody,
  startLabel,
  onChat,
  promisedSeconds,
  listenFirst,
  tapLabel,
  preloadClient,
  speakGreeting,
  hostGreetingMs,
}: Props) {
  const [state, dispatch] = useReducer(reduce, INITIAL);
  const [now, setNow] = useState(() => Date.now());
  // Off until asked for: the face is the conversation, words under it are an aid.
  const [showCaptions, setShowCaptions] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [faceVisible, setFaceVisible] = useState(false);
  // The greeting clip is speaking: its words are the call's opening, so the
  // circle keeps showing it (and holds its last frame) until the live face is
  // ready to take over.
  const [greetingSpeaking, setGreetingSpeaking] = useState(false);
  // The venue's background, when the session has one: the face is keyed onto it (Greenscreen.tsx).
  const [background, setBackground] = useState("");
  const [keyed, setKeyed] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  /** The pre-rendered greeting, when this surface plays it itself. */
  const greetingRef = useRef<HTMLVideoElement>(null);
  /** What the current start is doing about the greeting. Reset on every start. */
  const greetingPlayRef = useRef<PlayingGreeting>(noGreeting());
  /** Told by the page around the bubble that its clip has said the last word. */
  const hostFinishRef = useRef<(() => void) | null>(null);
  /** …or that it never said one. */
  const hostFailedRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const sessionRef = useRef<Session | null>(null);
  const callRef = useRef<CallAdapter | null>(null);
  const micRef = useRef<MediaStreamTrack | null>(null);
  const tokenRef = useRef(freshToken);
  const startedAtRef = useRef(0);
  const firstResponseRef = useRef(false);
  const endingRef = useRef(false);
  /** When anybody in the room last made a sound. The quiet prompt counts from here. */
  const lastVoiceRef = useRef(0);
  /** She has already said the quiet prompt on this call. Once is a nudge; twice is nagging. */
  const nudgedRef = useRef(false);
  /** The call's turns, handed over when the visitor carries on in chat. */
  const recapRef = useRef<{ role: "agent" | "caller"; text: string }[]>([]);
  const startButtonRef = useRef<HTMLButtonElement>(null);

  const base = apiBase ?? `/api/video/${encodeURIComponent(embedKey)}`;

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

  /**
   * Tell the server, and hear back why the call ended.
   *
   * The answer is the only place the real reason exists: from here our own
   * ceiling, the provider's, and a room that simply went away are the same
   * event — the face leaves. A beacon on unload cannot read an answer, and
   * does not need one, because there is no panel left to tell.
   */
  const endOnServer = useCallback(
    async (reason: string, beacon = false): Promise<EndedAnswer | null> => {
      const session = sessionRef.current;
      if (!session) return null;
      const payload = JSON.stringify({ sessionId: session.sessionId, clientToken: session.clientToken, reason });
      if (beacon && typeof navigator.sendBeacon === "function") {
        navigator.sendBeacon(`${base}/session/end`, new Blob([payload], { type: "text/plain" }));
        return null;
      }
      try {
        const res = await fetch(`${base}/session/end`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: payload,
          keepalive: true,
        });
        if (!res.ok) return null;
        const body = (await res.json()) as Partial<EndedAnswer>;
        return typeof body?.cause === "string"
          ? { cause: body.cause, seconds: Number(body.seconds) || 0, recap: Array.isArray(body.recap) ? body.recap : [] }
          : null;
      } catch {
        // The server will end it anyway, on its own timer. The panel keeps
        // the calm generic wording rather than inventing a reason.
        return null;
      }
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
      // Silent when a failure is about to be shown instead.
      if (!opts.silent) dispatch({ type: "ended", reason });
      const answer = await endOnServer(reason);
      if (!answer) return;
      recapRef.current = answer.recap;
      if (!opts.silent) dispatch({ type: "end_cause", cause: answer.cause, seconds: answer.seconds });
    },
    [endOnServer, stopMic],
  );

  const onCallEvent = useCallback(
    (event: CallEvent) => {
      dispatch({ type: "call", event, now: Date.now() });
      // Anything anybody says, and the moment the room opens, resets the quiet
      // clock. `on: false` counts too: the wait that matters starts when the
      // last voice stops, not when it started.
      if (event.type === "joined" || event.type === "speaking" || event.type === "caption") lastVoiceRef.current = Date.now();
      if (event.type === "speaking" && event.who === "agent" && event.on && !firstResponseRef.current) {
        firstResponseRef.current = true;
        report("first_response", Date.now() - startedAtRef.current);
      }
      if (event.type === "network" && event.state === "reconnecting") report("reconnecting");
      // The room closing is not the visitor's doing until the server says it
      // was. `dropped` is what makes an early provider shutdown visible
      // instead of being filed as one more person who hung up.
      if (event.type === "left") void end(event.reason === "left" ? "visitor" : "dropped");
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
    // "Start again" is a new room and a new silence: she may nudge once more.
    nudgedRef.current = false;
    lastVoiceRef.current = 0;
    recapRef.current = [];
    sessionRef.current = null;
    setNote(null);
    // "Start again" gets the whole opening again, clip included.
    setFaceVisible(false);
    setGreetingSpeaking(false);
    hostFinishRef.current = null;
    dispatch({ type: "start" });
    startedAtRef.current = Date.now();

    // Inside the press: the one moment iOS Safari lets a page start audio.
    void audioRef.current?.play().catch(() => undefined);

    // Still inside the press, and before anything is awaited: Belle's first
    // words. From here on `greetingPlayRef` is the whole handover — whether
    // the live session may drop its hello, and when the live face may come in.
    await beginGreeting();

    if (listenFirst) return startListening();

    if (!navigator.mediaDevices?.getUserMedia) {
      dispatch({ type: "fail", code: "mic_unsupported", retryable: false });
      report("client_error", undefined, "mic_unsupported");
      return;
    }

    // The call client's code (and Daily's, for a live face) downloads from here,
    // after the tap and never before it. The room does not: see below.
    const client = import("@/lib/video/client/calls").then((m) => {
      m.preloadCallClient(provider);
      return m;
    });
    client.catch(() => undefined);

    /**
     * The microphone first, and only then the room.
     *
     * This used to be the other way round — the session was created beside the
     * prompt so the two waits overlapped — and it cost us the worst bug this
     * surface has had. A first-time visitor gets a browser permission dialog
     * they may not answer for half a minute, and meanwhile the room at Tavus
     * exists with its `participant_absent_timeout` already running: the face
     * says her opening line into an empty room, the browser arrives after it or
     * not at all, and the visitor watches a silent picture until the provider
     * shuts it down. Measured in production on 18 September: two sessions dead
     * at 53s and 66s of a 60s absent timeout, with not one model request
     * between them. From the visitor's chair that is exactly "Belle is not
     * speaking".
     *
     * The overlap was worth having when the tap was followed by nine seconds of
     * silence. It is not worth having now: the greeting clip covers the wait
     * out of the tap (`beginGreeting`), so the seconds this gives back to the
     * prompt are seconds the visitor spends listening to her rather than
     * watching nothing. A browser that has already been granted the microphone
     * — every visit after the first — resolves this in a few milliseconds and
     * loses nothing at all.
     */
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

    const reply = await requestSession();
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
      void endOnServer("visitor");
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
      await handOverToLiveFace(call);
      report("ready", Date.now() - startedAtRef.current);
    } catch {
      report("client_error", undefined, "join_failed");
      await end("error", { silent: true });
      dispatch({ type: "fail", code: "network", retryable: true });
    }
  };

  /**
   * `listenFirst`: the session, the call client and the microphone prompt all
   * start on the tap; the call joins listening only, so the face starts
   * talking whatever the prompt is doing, and the microphone joins it later.
   */
  async function startListening() {
    const client = import("@/lib/video/client/calls").then((m) => {
      m.preloadCallClient(provider);
      return m;
    });
    client.catch(() => undefined);
    const sessionReply = requestSession();
    report("mic_prompted");
    const mic: Promise<MediaStreamTrack | { error: VideoErrorCode }> = navigator.mediaDevices?.getUserMedia
      ? navigator.mediaDevices
          .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false })
          .then(
            (stream): MediaStreamTrack | { error: VideoErrorCode } => stream.getAudioTracks()[0] ?? { error: "mic_missing" },
            (err: unknown) => ({ error: micErrorCode(err) }),
          )
      : Promise.resolve({ error: "mic_unsupported" });
    const dropMic = () => void mic.then((got) => ("error" in got ? undefined : got.stop()));

    const reply = await sessionReply;
    if (!reply.res) {
      dropMic();
      report("client_error", undefined, "network");
      dispatch({ type: "fail", code: "network", retryable: true });
      return;
    }
    const { res, data } = reply;
    if (!res.ok || !data.session) {
      dropMic();
      const code = startErrorCode(res.status, data.error);
      report("client_error", undefined, code);
      dispatch({ type: "fail", code, retryable: Boolean(data.retryable) || code === "failed" });
      return;
    }
    const session = data.session;
    sessionRef.current = session;
    setBackground(session.background?.src ?? "");
    if (endingRef.current) {
      void endOnServer("visitor");
      dropMic();
      return;
    }
    try {
      const { createCall } = await client;
      const call = await createCall({
        session,
        micTrack: null,
        media: { video: videoRef.current, audio: audioRef.current },
        onEvent: onCallEvent,
        mockUrl: `${base}/mock`,
      });
      callRef.current = call;
      await handOverToLiveFace(call);
      report("ready", Date.now() - startedAtRef.current);
    } catch {
      dropMic();
      report("client_error", undefined, "join_failed");
      await end("error", { silent: true });
      dispatch({ type: "fail", code: "network", retryable: true });
      return;
    }

    const got = await mic;
    const call = callRef.current;
    const typeInstead = chatHref || onChat ? "; to reply, type instead" : "";
    if ("error" in got) {
      report(got.error === "mic_denied" ? "mic_denied" : "client_error", undefined, got.error);
      if (call && !endingRef.current) {
        setNote(`${agentName} can't hear you: ${got.error === "mic_denied" ? "the microphone is blocked" : "no microphone could be used"}. She'll keep talking${typeInstead}.`);
      }
      return;
    }
    if (!call || endingRef.current) {
      got.stop();
      return;
    }
    micRef.current = got;
    dispatch({ type: "mic_granted" });
    try {
      await call.setMicTrack(got);
    } catch {
      setNote(`${agentName} can't hear your microphone just now${typeInstead}.`);
    }
  }

  /**
   * Belle's first words, from the visitor's own tap.
   *
   * Called before anything is awaited in the start sequence, because a browser
   * only counts a gesture for as long as the handler is still its own. What it
   * settles is `greetingPlayRef`, and everything downstream reads that rather
   * than the properties: whether the live session may drop its hello
   * (`requestSession`), and when the live face may take the circle
   * (`handOverToLiveFace`).
   *
   * Nothing here can fail loudly. A surface with no clip, a page that is not
   * playing one, a file that never loaded, a browser that refuses the sound —
   * all of them leave the silent default in place, and the call goes on
   * exactly as it did before any of this existed.
   */
  async function beginGreeting(): Promise<void> {
    const at = Date.now();
    const tell = (detail: string) => report("greeting_clip", Date.now() - at, detail);
    greetingPlayRef.current = noGreeting();
    hostFailedRef.current = false;
    if (hostGreetingMs && hostGreetingMs > 0) {
      const fromHost = hostGreeting(hostGreetingMs);
      hostFinishRef.current = fromHost.finish;
      // A page whose clip was refused says so within a few milliseconds of the
      // tap. Give it that long before believing the URL, because the belief is
      // what shortens the live greeting, and a wrong one is a visitor nobody
      // says hello to. It costs nothing anybody can feel: the call client is
      // downloading through the same moment.
      await new Promise((r) => setTimeout(r, HOST_CONFIRM_MS));
      if (hostFailedRef.current) return tell("host_failed");
      greetingPlayRef.current = fromHost;
      setGreetingSpeaking(true);
      void fromHost.done.then(() => setGreetingSpeaking(false));
      return tell("host");
    }
    if (!speakGreeting) return tell("no_clip");
    const clip = greetingRef.current;
    const playing = await playGreeting(clip);
    greetingPlayRef.current = playing;
    if (!playing.played) {
      // Hidden and refused are the same shape and different things: the first
      // is a choice the visitor made (reduced motion), the second is a browser
      // saying no. Only one of them is worth chasing.
      const visible = Boolean(clip && clip.offsetWidth && clip.offsetHeight);
      if (visible) tell("refused");
      else tell("hidden");
      return;
    }
    setGreetingSpeaking(true);
    void playing.done.then(() => setGreetingSpeaking(false));
    tell("spoken");
  }

  /**
   * Join the room so the live face arrives as the clip finishes, not after it.
   *
   * The provider speaks its greeting once somebody is in the room, so the join
   * is the moment the live Belle starts — which makes it the one thing worth
   * holding. Held until the clip is nearly done, the two run together: the
   * room connects under the clip's last words and the face fades in as they
   * end. Without a clip this waits on nothing and the call joins exactly when
   * it always did.
   */
  async function handOverToLiveFace(call: CallAdapter): Promise<void> {
    await greetingPlayRef.current.beforeEnd(HANDOVER_LEAD_MS);
    if (endingRef.current) return;
    await call.join();
  }

  type SessionReply = { res: Response | null; data: { session?: Session; error?: string; retryable?: boolean } };

  /** Create the session. Never throws: a network failure is `res: null`. */
  function requestSession(): Promise<SessionReply> {
    return fetch(`${base}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // `greeted` is the handover's only word to the server: the visitor has
      // heard the clip, so this session must not say hello again. False
      // whenever the clip is not really playing, which keeps the greeting
      // whole on every fallback.
      body: JSON.stringify({ token: tokenRef.current, greeted: greetingPlayRef.current.played }),
    }).then(
      async (res) => ({ res, data: (await res.json().catch(() => ({}))) as SessionReply["data"] }),
      () => ({ res: null, data: {} }),
    );
  }

  // The call client's code only, on load, where the page asked: the tap then has nothing to download.
  useEffect(() => {
    if (!preloadClient) return;
    void import("@/lib/video/client/calls").then((m) => m.preloadCallClient(provider)).catch(() => undefined);
  }, [preloadClient, provider]);

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

  /**
   * The page around the bubble has finished saying the greeting.
   *
   * Its own clip, its own tap, its own last word — this frame only learns of
   * it here. The message is the authority; the length that came with the URL
   * is just a backstop for a page that never sends one, so a clip that stalls
   * cannot keep the live face waiting for ever.
   */
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { source?: string; type?: string } | null;
      if (e.source !== window.parent || data?.source !== "belline-host") return;
      if (data.type === "greeting_ended") hostFinishRef.current?.();
      // The page's clip never made a sound after all. Nothing is waiting on it,
      // and — if the session has not gone out yet — nothing was heard, so the
      // live Belle keeps her whole greeting.
      if (data.type === "greeting_failed") {
        hostFailedRef.current = true;
        hostFinishRef.current?.();
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // The page's small picture-in-picture face has its own mute: it asks here, and hears back below.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { source?: string; type?: string; muted?: unknown } | null;
      if (e.source !== window.parent || data?.source !== "belline-host" || data.type !== "mute") return;
      if (typeof data.muted !== "boolean" || state.phase !== "live") return;
      callRef.current?.setMuted(data.muted);
      dispatch({ type: "mute", muted: data.muted });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [state.phase]);

  useEffect(() => {
    tellHost({ type: "muted", muted: state.muted });
  }, [state.muted, tellHost]);

  // Leaving the page: stop everything, and tell the server by beacon.
  useEffect(() => {
    const leave = () => {
      if (!sessionRef.current || endingRef.current) return;
      endingRef.current = true;
      void endOnServer("unload", true);
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

  /**
   * The live face has the circle.
   *
   * Both halves matter. `faceVisible` is the stream having painted a frame —
   * without it there is nothing to show. `greetingSpeaking` is Belle still
   * talking in the clip — cutting to the live face then would interrupt her
   * mid-sentence, which is the jump cut this whole feature exists to avoid.
   * The live stream only takes over when it can do so without either.
   */
  const liveFaceOn = faceVisible && !greetingSpeaking;

  useEffect(() => {
    if (liveFaceOn) tellHost({ type: "face" });
  }, [liveFaceOn, tellHost]);


  /**
   * Inside the bubble, an ended call gives the page back its resting bubble —
   * but only when the visitor ended it.
   *
   * A call that stopped on its own is the one moment the bubble must not just
   * fold away: "it vanished and I don't know why" is exactly what the founder
   * met. So an unexpected end keeps the frame open with the reason and the two
   * ways on, and the visitor closes it themselves.
   */
  const lingering = state.phase === "ended" && state.endedCause !== undefined && endedUnexpectedly(state.endedCause);
  useEffect(() => {
    if (!bubble || state.phase !== "ended" || lingering) return;
    // Until the end route has answered, the bubble waits: folding away first
    // and learning why second is how the reason got lost in the first place.
    const wait = state.endedCause === undefined ? CAUSE_WAIT_MS : 0;
    const timer = setTimeout(() => tellHost({ type: "ended" }), ENDED_LINGER_MS + wait);
    return () => clearTimeout(timer);
  }, [bubble, state.phase, state.endedCause, lingering, tellHost]);

  // Escape (inside the bubble) ends the call.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (bubble) {
        void end("visitor", { silent: true });
        tellHost({ type: "ended" });
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [bubble, end, tellHost]);

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

  /**
   * Say we are still here, while a call is on.
   *
   * Every tidy way of leaving already tells the server — the End button, the
   * panel closing, the `pagehide` beacon. This is for the untidy ones: a phone
   * that sleeps, a tab the OS kills, a beacon lost on a dead connection. Without
   * it the server keeps believing the room is live until the call's own maximum,
   * and that belief is what refuses the next visitor with "busy" while nothing
   * at all is running (lib/video/sessions.ts).
   */
  useEffect(() => {
    if (state.phase !== "connecting" && state.phase !== "live") return;
    const timer = setInterval(() => {
      if (sessionRef.current && !endingRef.current) report("alive");
    }, VIDEO_HEARTBEAT_SECONDS * 1000);
    return () => clearInterval(timer);
  }, [state.phase, report]);

  /**
   * A room that has gone quiet, and the one thing that gets her out of it.
   *
   * The handover leaves Belle having said her opening and then stopped, and a
   * visitor who does not know they are allowed to talk — or whose microphone is
   * blocked, missing, muted at the operating system, or simply picking up
   * nothing — meets a face that has finished speaking and never starts again.
   * Nothing on the screen says anything is wrong, because nothing is: she is
   * listening to silence, politely, for five minutes. That is the shape the
   * founder reported as "Belle is not speaking".
   *
   * So once, after `QUIET_NUDGE_MS` of nobody making a sound, she says
   * something. Her words, not a paraphrase: the line comes from the server in
   * the venue's own language (`video.quiet.*`) and is echoed verbatim rather
   * than run through the model, which could answer it with anything. Which of
   * the two lines it is, is the one thing only the browser knows — whether a
   * microphone ever arrived at all.
   *
   * Once. A visitor who is reading something else does not need to be asked
   * twice, and the typing offer stays on screen after she has stopped.
   */
  useEffect(() => {
    if (state.phase !== "live" || nudgedRef.current) return;
    const timer = setInterval(() => {
      const call = callRef.current;
      const quiet = sessionRef.current?.quiet;
      if (!call || endingRef.current || nudgedRef.current) return;
      if (state.agentSpeaking || state.visitorSpeaking) return;
      if (!lastVoiceRef.current || Date.now() - lastVoiceRef.current < QUIET_NUDGE_MS) return;
      nudgedRef.current = true;
      const deaf = !micRef.current;
      const line = deaf ? quiet?.noMic : quiet?.waiting;
      if (line) call.speak(line);
      report("quiet_prompt", Date.now() - startedAtRef.current, deaf ? "no_mic" : "waiting");
      const typeInstead = chatHref || onChat ? ", or type instead" : "";
      setNote(
        deaf
          ? `${agentName} can't hear you: no microphone is reaching her. Check it${typeInstead}.`
          : `${agentName} is listening. Ask her whenever you're ready${typeInstead}.`,
      );
    }, 1000);
    return () => clearInterval(timer);
  }, [state.phase, state.agentSpeaking, state.visitorSpeaking, agentName, chatHref, onChat, report]);

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

  async function switchTo(kind: "chat" | "voice") {
    if (kind === "chat" && onChat) {
      report("fallback_chat");
      // Silent only while the call is still up: from an ended panel the words
      // on screen are the reason they are switching, and must not be wiped.
      await end("switch_chat", { silent: state.phase !== "ended" });
      // The turns go with them, so the chat opens on the conversation they
      // were already having rather than on an empty box.
      onChat(recapRef.current);
      return;
    }
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
  const status = statusText(state, agentName, greetingSpeaking);
  // About as many characters as fit on one line of the circle's width.
  const captionChars = bubble && typeof window !== "undefined" ? Math.max(28, Math.floor((window.innerWidth - 48) / 7.4)) : 90;
  const caption = showCaptions && state.phase === "live" ? captionLine(state, agentName, captionChars) : "";
  const canRetry = (state.phase !== "error" || state.retryable) && state.error !== "unavailable" && state.error !== "expired";
  // What this page promised about length, and what it says when the call is
  // over. The promise is only quoted back in the one case where we kept it.
  const promised = promisedSeconds === undefined ? maxCallSeconds : promisedSeconds;
  const ended = endCopy(state.endedCause ?? "visitor", agentName, promised === null ? "" : durationWords(promised));

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
              className={`bv-face${liveFaceOn && !keyed ? " is-on" : ""}`}
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
            {/* The same element twice over: the silent loop that fills the wait, and — once
                the tap has unmuted it — Belle's opening words. It stays on the circle until
                the live face is both here and no longer interrupting her, then fades out
                under it rather than being cut away (`greeting.ts`, `greeting-clip.ts`).
                It is never unmounted, only faded: the face is drawn over it anyway, and a
                clip that left the tree would take its element with it, so "Start again"
                would have nothing to speak with and would meet a silent wait again. */}
            {previewClipUrl && (
              <video
                ref={greetingRef}
                className={`bv-preview bv-preview-clip${liveFaceOn ? " is-gone" : ""}`}
                src={previewClipUrl}
                poster={previewPosterUrl || undefined}
                muted={!greetingSpeaking}
                loop={!greetingSpeaking}
                autoPlay
                playsInline
                aria-hidden={greetingSpeaking ? undefined : "true"}
              />
            )}
            {!liveFaceOn && !previewClipUrl && !previewPosterUrl && (
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

          {tapLabel && state.phase === "intro" && (
            <button ref={startButtonRef} type="button" className="bv-tap" onClick={() => void start()}>
              <span className="bv-tap-pill">
                <span className="bv-tap-i" aria-hidden="true">
                  <PlayIcon />
                </span>
                {tapLabel}
              </span>
            </button>
          )}

          {state.audioBlocked && inCall && (
            <button type="button" className="bv-sound" onClick={unlockAudio}>
              <SpeakerIcon />
              Tap to hear {agentName}
            </button>
          )}

          {/* Inside the circle, not on its edge: every small state clips the
              frame to the circle (embed-video.js `is-pip`), so a pill straddling
              the edge is the one that cannot be read at all. Near the top, clear
              of a thumb, on its own dark paper so it reads on any face. */}
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

      {resting && !(bubble && state.phase !== "error" && !lingering) && (
        <div className="bv-panel">
          {state.phase === "intro" && tapLabel && introBody && <p className="bv-small">{introBody}</p>}
          {state.phase === "intro" && !tapLabel && (
            <>
              <h1>{introTitle ?? `Talk face to face with ${agentName}`}</h1>
              <p>
                {introBody ??
                  `${agentName} is an AI concierge for ${venueName}. When you start, your browser will ask to use your microphone so ${agentName} can hear you. Your camera stays off and the call isn’t recorded.`}
              </p>
            </>
          )}
          {state.phase === "error" && state.error && (
            <p className="bv-error" role="alert">
              {errorCopy(state.error, agentName)}
            </p>
          )}
          {/* An ended call says what happened and offers the way on. Never the
              raw reason, never the provider's name, and never a word that
              suggests the visitor broke it (lib/video/end-reason.ts). */}
          {state.phase === "ended" && (
            <div className="bv-ended" role="status">
              <h2 className="bv-ended-t">{ended.title}</h2>
              <p>{ended.body}</p>
            </div>
          )}

          <div className="bv-actions">
            {canRetry && !(tapLabel && state.phase === "intro") && (
              <button ref={startButtonRef} type="button" className="bv-btn bv-primary" onClick={() => void start()}>
                {state.phase === "intro" ? (startLabel ?? "Start video call") : state.phase === "ended" ? END_ACTIONS.again : "Try again"}
              </button>
            )}
            {(chatHref || onChat) && (
              <button type="button" className="bv-btn" onClick={() => void switchTo("chat")}>
                {state.phase === "ended" ? END_ACTIONS.chat : bubble ? "Type instead" : "Chat instead"}
              </button>
            )}
            {voiceHref && !bubble && (
              <button type="button" className="bv-btn" onClick={() => void switchTo("voice")}>
                Voice call
              </button>
            )}
          </div>
          {state.phase === "intro" && <p className="bv-small">{promiseLine(promised)}</p>}
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
            {/* Captions, the one small extra: a toggle of its own, not a menu of one. A person is
                asked for out loud; Belle takes a message or hands over when asked. */}
            <div className="bv-more">
              <button
                type="button"
                className="bv-ctl bv-ctl-more"
                aria-label="Captions"
                aria-pressed={showCaptions}
                onClick={() => setShowCaptions((v) => !v)}
              >
                <span className="bv-ctl-i">
                  <CcIcon />
                </span>
                <span className="bv-ctl-t">Captions</span>
              </button>
            </div>
          </div>
          {(chatHref || onChat) && (
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

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 5.2v13.6a1 1 0 0 0 1.52.85l10.9-6.8a1 1 0 0 0 0-1.7L9.52 4.35A1 1 0 0 0 8 5.2Z" fill="currentColor" />
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
.bv-preview-clip.is-gone { opacity: 0; pointer-events: none; transition: opacity .4s ease }
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
/* Under the timer, never across it: the badge is a development note and the
   clock is the one thing a visitor in a call needs to be able to read. */
.bv-mock { position: absolute; top: 24%; left: 50%; transform: translateX(-50%); margin: 0; z-index: 2;
  background: var(--bl-warning-tint); color: var(--bl-warning); border: 1px solid var(--bl-warning);
  font-weight: 700; font-size: 10.5px; letter-spacing: .02em; padding: 2px 8px; border-radius: var(--bl-radius-pill);
  white-space: nowrap; z-index: 2 }

/* The pill on the circle's top edge, outside its clip. */
.bv-ai, .bv-time { position: absolute; left: 50%; z-index: 3; white-space: nowrap; border-radius: var(--bl-radius-pill) }
.bv-ai { top: 0; transform: translate(-50%, -50%); font-size: 10.5px; line-height: 1.3; font-weight: 600;
  letter-spacing: .06em; text-transform: uppercase; padding: 3px 9px;
  color: var(--bl-accent-text); background: var(--bl-blue-tint); border: 1px solid var(--bl-blue-line) }

/* How long is left, in every state a call can be in.
 *
 * It used to be an 11.5px hairline-bordered pill straddling the circle's
 * bottom edge: too small to read in the bubble, under the thumb on a phone,
 * and cut in half by the clip in every small state — a frame carried or tucked
 * into a corner is clipped to its circle (embed-video.js, is-pip), so
 * anything on the edge is simply gone. So it is inside the circle, near the
 * top, well clear of where a thumb rests, on its own dark paper (white on
 * ~#454545 at worst, about 9:1) so it reads over any face, light or dark. */
.bv-time { top: 7%; bottom: auto; transform: translateX(-50%);
  font-size: 14px; line-height: 1.3; font-weight: 700; letter-spacing: .01em;
  font-variant-numeric: tabular-nums; padding: 4px 12px;
  color: #FFFFFF; background: rgba(17, 17, 19, .78); border: 1px solid rgba(255, 255, 255, .3);
  box-shadow: 0 2px 10px rgba(0, 0, 0, .35);
  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px) }
/* The one place the circle is small enough that 14px would crowd it: the 96px
   button a host can still ask for. Never smaller than 12px. */
@media (max-width: 220px) {
  .bv-time { top: 6%; font-size: 12px; padding: 3px 8px }
}
.bv-sound { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 4;
  display: inline-flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 16px 0 13px;
  border: 0; border-radius: var(--bl-radius-pill); background: var(--bl-ground); color: var(--bl-accent-text);
  font: inherit; font-size: 14px; font-weight: 600; white-space: nowrap; cursor: pointer;
  box-shadow: 0 10px 30px -10px rgba(0, 0, 0, .45) }
.bv-sound svg { width: 20px; height: 20px; flex: none }
/* One tap to meet her: the whole face is the button, the pill says so. */
.bv-tap { position: absolute; inset: 0; z-index: 4; border: 0; padding: 0 0 12%; margin: 0; border-radius: 50%; cursor: pointer;
  display: flex; align-items: flex-end; justify-content: center; touch-action: manipulation;
  background: linear-gradient(180deg, transparent 50%, rgba(0, 0, 0, .34) 100%); font: inherit; color: inherit }
.bv-tap-pill { display: inline-flex; align-items: center; gap: 10px; min-height: 52px; padding: 0 22px 0 7px;
  border-radius: var(--bl-radius-pill); background: var(--bl-white); color: var(--bl-ink-900);
  font-size: 17px; font-weight: 600; letter-spacing: -.01em; white-space: nowrap;
  box-shadow: 0 12px 30px -10px rgba(0, 0, 0, .5); transition: transform .18s ease }
.bv-tap-i { width: 38px; height: 38px; border-radius: 50%; display: grid; place-items: center; background: var(--bl-blue); color: var(--bl-white) }
.bv-tap-i svg { width: 18px; height: 18px; margin-left: 2px }
.bv-tap:hover .bv-tap-pill { transform: scale(1.03) }
.bv-tap:focus-visible { outline: none }
.bv-tap:focus-visible .bv-tap-pill { outline: var(--bl-focus); outline-offset: 3px }
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
/* The end of a call: a calm heading and one sentence, never an alarm colour —
   a call ending early is our problem to fix, not a warning to the visitor. */
.bv-ended { display: grid; gap: 6px }
.bv-ended-t { margin: 0; font-family: var(--bl-font-display); font-weight: var(--bl-weight-heading);
  letter-spacing: var(--bl-track-h2); font-size: 17px; line-height: 1.3; color: var(--bl-ink-900) }
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
.bv-ctl-more[aria-pressed="true"] .bv-ctl-t { color: var(--bl-ink-900) }
.bv-ctl:focus-visible { outline: none }
.bv-ctl:focus-visible .bv-ctl-i { outline: var(--bl-focus); outline-offset: 3px }
.bv-more { position: relative; width: 40px }
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
  .bv-face, .bv-avatar, .bv-circle, .bv-ctl-i, .bv-tap-pill { transition: none }
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
.is-bubble .bv-ctl-more .bv-ctl-t { margin-top: 6px; font-size: 10.5px; letter-spacing: -.01em }
.is-bubble .bv-ctl-i { width: 52px; height: 52px }
.is-bubble .bv-ctl-more .bv-ctl-i { width: 36px; height: 36px }
.is-bubble .bv-link { min-height: 36px; font-size: 13px }
.is-bubble .bv-panel { margin: 10px auto 12px; padding: 14px 16px; gap: 10px; width: auto; max-width: 100vw;
  background: var(--bl-ground); border: 1px solid var(--bl-blue-line); border-radius: 18px; box-shadow: var(--bl-elev-float) }
.is-bubble .bv-panel p { font-size: 13px; line-height: 1.45 }
.is-bubble .bv-ended-t { font-size: 15px }
.is-bubble .bv-ended { text-align: center }
.is-bubble .bv-actions { justify-content: center }
.is-bubble .bv-btn { min-height: 40px; font-size: 13.5px; padding: 0 14px }
`;

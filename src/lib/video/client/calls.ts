import { createTavusMapper, echoMessage, readSseText, respondMessage, type CallEvent } from "./machine";

/**
 * The two ways the panel talks to a face: a Tavus room over Daily, or the mock.
 *
 * Both present the same small surface so the panel does not branch on which
 * one it holds. `@daily-co/daily-js` is imported here and only here, inside
 * `createTavusCall` — so the chunk is fetched when a visitor has pressed Start
 * on a live provider, and never for the mock, the chat or the bell.
 */

export interface CallSession {
  sessionId: string;
  provider: "tavus" | "mock";
  roomUrl: string;
  meetingToken?: string;
  conversationId?: string;
  clientToken: string;
  greeting: string;
  /** The venue's background: the stream is a green screen to key onto it (chroma.ts). */
  background?: { id: string; src: string; tone: "light" | "dark" };
}

export interface CallMedia {
  video: HTMLVideoElement | null;
  audio: HTMLAudioElement | null;
}

export interface CallAdapter {
  join(): Promise<void>;
  setMuted(muted: boolean): void;
  /**
   * The visitor's microphone, when it arrives after the call has started (a
   * page that lets the face start talking while the browser asks). Until then
   * the visitor only listens.
   */
  setMicTrack(track: MediaStreamTrack): Promise<void>;
  /** Say this on the visitor's behalf: the face answers as if they had spoken it. */
  say(text: string): void;
  /**
   * Have the face say exactly this, with no model in between. For lines that
   * are ours and must not be paraphrased — the quiet prompt when a room has
   * gone silent (`machine.ts` `echoMessage`).
   */
  speak(text: string): void;
  /** Leave the room, stop everything, and never emit again. Safe to call twice. */
  leave(): Promise<void>;
}

export interface CallOptions {
  session: CallSession;
  /** Null: join listening only, and add the microphone with `setMicTrack` once it is granted. */
  micTrack: MediaStreamTrack | null;
  media: CallMedia;
  onEvent: (event: CallEvent) => void;
  /** The mock's model relay. */
  mockUrl: string;
}

export async function createCall(opts: CallOptions): Promise<CallAdapter> {
  return opts.session.provider === "mock" ? createMockCall(opts) : createTavusCall(opts);
}

/**
 * Start fetching the live call client (Daily, for Tavus) the moment the visitor
 * taps, so it downloads while the session is being created instead of after.
 * The same dynamic import `createTavusCall` uses, so it is fetched once.
 */
export function preloadCallClient(provider: CallSession["provider"]): void {
  if (provider === "tavus") void import("@daily-co/daily-js").catch(() => undefined);
}

/** How long a voice may sit paused, with a stream attached, before the visitor is asked to tap. */
export const AUDIO_WATCH_MS = 1500;

/**
 * Play the face's voice, and never stay silent without saying so.
 *
 * A refused play() (autoplay policy, iOS in a frame) is reported at once. Some
 * browsers neither play nor refuse until there is a gesture, so a voice still
 * paused a moment later is reported too. Either way the panel shows "Tap to
 * hear", whose tap is the gesture that lets it play.
 */
export function playVoice(audio: HTMLAudioElement, emit: (event: CallEvent) => void): void {
  try {
    const playing = audio.play();
    if (playing && typeof playing.catch === "function") playing.catch(() => emit({ type: "audio_blocked" }));
  } catch {
    emit({ type: "audio_blocked" });
  }
  setTimeout(() => {
    if (audio.srcObject && audio.paused) emit({ type: "audio_blocked" });
  }, AUDIO_WATCH_MS);
}

// ---------------------------------------------------------------------------
// Tavus, through Daily

async function createTavusCall(opts: CallOptions): Promise<CallAdapter> {
  const { default: Daily } = await import("@daily-co/daily-js");
  const { session, micTrack, media } = opts;
  let gone = false;
  let hasMic = Boolean(micTrack);
  let muted = false;
  const emit = (event: CallEvent) => {
    if (!gone) opts.onEvent(event);
  };

  // Camera never: perception is off, so nothing needs to see the visitor.
  const call = Daily.createCallObject({
    // No track yet: listening only, never Daily's own microphone request.
    audioSource: micTrack ?? false,
    videoSource: false,
    startVideoOff: true,
    startAudioOff: !micTrack,
    subscribeToTracksAutomatically: true,
  });
  const mapTavus = createTavusMapper();

  call.on("joined-meeting", () => emit({ type: "joined" }));
  call.on("track-started", (e) => {
    if (!e?.participant || e.participant.local) return;
    if (e.type === "video" && media.video) {
      media.video.srcObject = new MediaStream([e.track]);
      void media.video.play().catch(() => undefined);
    }
    if (e.type === "audio" && media.audio) {
      media.audio.srcObject = new MediaStream([e.track]);
      playVoice(media.audio, emit);
    }
  });
  call.on("app-message", (e) => {
    const event = mapTavus(e?.data);
    if (event) emit(event);
  });
  call.on("participant-left", (e) => {
    // The face is the only other participant: it leaving is the call ending.
    if (e?.participant && !e.participant.local) emit({ type: "left", reason: "agent_left" });
  });
  call.on("left-meeting", () => emit({ type: "left", reason: "left" }));
  call.on("network-connection", (e) => {
    emit({ type: "network", state: e?.event === "interrupted" ? "reconnecting" : "ok" });
  });
  call.on("error", () => emit({ type: "error", code: "network" }));

  return {
    async join() {
      await call.join({ url: session.roomUrl, ...(session.meetingToken ? { token: session.meetingToken } : {}) });
    },
    setMuted(value) {
      muted = value;
      // Before the microphone arrives there is nothing to switch.
      if (hasMic) call.setLocalAudio(!muted);
    },
    async setMicTrack(track) {
      if (gone) return;
      await call.setInputDevicesAsync({ audioSource: track });
      hasMic = true;
      call.setLocalAudio(!muted);
    },
    say(text) {
      if (session.conversationId) call.sendAppMessage(respondMessage(session.conversationId, text), "*");
    },
    speak(text) {
      if (session.conversationId) call.sendAppMessage(echoMessage(session.conversationId, text), "*");
    },
    async leave() {
      if (gone) return;
      gone = true;
      try {
        await call.leave();
      } catch {
        /* already left */
      }
      try {
        await call.destroy();
      } catch {
        /* already destroyed */
      }
    },
  };
}

/**
 * The mock's green-screen stand-in: an abstract head-and-shoulders shape, not
 * a person, drawn on Tavus's green (RGB 0, 255, 155) into a canvas stream.
 */
function mockGreenscreenStream(video: HTMLVideoElement): { stop(): void } | null {
  const canvas = document.createElement("canvas");
  canvas.width = 480;
  canvas.height = 480;
  const ctx = canvas.getContext("2d");
  if (!ctx || typeof canvas.captureStream !== "function") return null;
  let frame = 0;
  const timer = setInterval(() => {
    const bob = Math.sin(frame++ / 12) * 4;
    ctx.fillStyle = "rgb(0, 255, 155)";
    ctx.fillRect(0, 0, 480, 480);
    ctx.fillStyle = "#3A4150";
    ctx.beginPath();
    ctx.ellipse(240, 470 + bob / 2, 190, 150, 0, Math.PI, 0);
    ctx.fill();
    ctx.fillStyle = "#C9A58C";
    ctx.fillRect(215, 250 + bob, 50, 80);
    ctx.beginPath();
    ctx.ellipse(240, 205 + bob, 78, 96, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#4A3428";
    ctx.beginPath();
    ctx.ellipse(240, 160 + bob, 86, 62, 0, Math.PI, 0);
    ctx.fill();
  }, 1000 / 24);
  const stream = canvas.captureStream(24);
  video.srcObject = stream;
  void video.play().catch(() => undefined);
  return {
    stop() {
      clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}

// ---------------------------------------------------------------------------
// The mock: no face, no room — typed turns through the real model route

function createMockCall(opts: CallOptions): CallAdapter {
  const { session } = opts;
  let gone = false;
  let muted = false;
  let mic = opts.micTrack;
  let turn: AbortController | null = null;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const emit = (event: CallEvent) => {
    if (!gone) opts.onEvent(event);
  };
  const later = (fn: () => void, ms: number) => timers.push(setTimeout(fn, ms));
  const speakFor = (text: string) => Math.min(6000, Math.max(900, text.length * 45));
  // A silent voice, played through the same element and the same checks as a
  // real face's, so the mock exercises "Tap to hear" as a live call would.
  let silence: AudioContext | null = null;
  let stand: { stop(): void } | null = null;

  const online = () => emit({ type: "network", state: "ok" });
  const offline = () => emit({ type: "network", state: "reconnecting" });
  window.addEventListener("online", online);
  window.addEventListener("offline", offline);

  async function send(text: string) {
    turn?.abort();
    const controller = new AbortController();
    turn = controller;
    emit({ type: "caption", who: "visitor", text });
    emit({ type: "speaking", who: "agent", on: false });
    let said = "";
    try {
      const res = await fetch(opts.mockUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: session.sessionId, clientToken: session.clientToken, text }),
        signal: controller.signal,
      });
      if (res.status === 410 || res.status === 404) {
        emit({ type: "left", reason: "ended" });
        return;
      }
      if (!res.ok || !res.body) {
        emit({ type: "network", state: "reconnecting" });
        return;
      }
      emit({ type: "network", state: "ok" });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const [text, rest] = readSseText(buffer);
        buffer = rest;
        if (text) {
          if (!said) emit({ type: "speaking", who: "agent", on: true });
          said += text;
          emit({ type: "caption", who: "agent", text: said.trim() });
        }
      }
    } catch {
      if (!controller.signal.aborted) emit({ type: "network", state: "reconnecting" });
      return;
    }
    later(() => emit({ type: "speaking", who: "agent", on: false }), speakFor(said));
  }

  return {
    async join() {
      await new Promise((resolve) => setTimeout(resolve, 250));
      emit({ type: "joined" });
      if (opts.media.audio) {
        try {
          const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
          if (Context) {
            silence = new Context();
            opts.media.audio.srcObject = silence.createMediaStreamDestination().stream;
            playVoice(opts.media.audio, emit);
          }
        } catch {
          /* no audio stack: the mock carries on in captions */
        }
      }
      // With a background, a drawn stand-in on Tavus's green, so the key and
      // the composite run in the mock exactly as they would on a live face.
      if (session.background && opts.media.video) stand = mockGreenscreenStream(opts.media.video);
      emit({ type: "speaking", who: "agent", on: true });
      emit({ type: "caption", who: "agent", text: session.greeting });
      later(() => emit({ type: "speaking", who: "agent", on: false }), speakFor(session.greeting));
    },
    setMuted(value) {
      muted = value;
      if (mic) mic.enabled = !muted;
    },
    async setMicTrack(track) {
      mic = track;
      mic.enabled = !muted;
    },
    say(text) {
      void send(text);
    },
    speak(text) {
      // Verbatim here too: the mock's face says the line rather than answering it.
      emit({ type: "speaking", who: "agent", on: true });
      emit({ type: "caption", who: "agent", text });
      later(() => emit({ type: "speaking", who: "agent", on: false }), speakFor(text));
    },
    async leave() {
      if (gone) return;
      gone = true;
      turn?.abort();
      timers.forEach(clearTimeout);
      void silence?.close().catch(() => undefined);
      silence = null;
      stand?.stop();
      stand = null;
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    },
  };
}

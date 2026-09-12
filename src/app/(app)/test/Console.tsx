"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ToolTrace } from "@/lib/types";

/**
 * The test console.
 *
 * Two ways in: type, or talk. Typing exercises the agent, the tools and the
 * booking engine with no speech vendors involved, which makes it the fastest
 * way to iterate on a prompt or a policy. Talking exercises the whole thing
 * including endpointing and barge-in.
 *
 * The right-hand column is the point of the page. Anyone can demo a voice
 * bot; the question a venue actually asks is "what did it do to my book?" —
 * so every tool call, its arguments, its result and its latency are on screen
 * as they happen.
 */

interface Line {
  role: "caller" | "agent" | "system";
  text: string;
  latencyMs?: number;
}

interface Status {
  llm: boolean;
  stt: boolean;
  tts: boolean;
}

const CAPTURE_WORKLET = `
class Capture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(new Float32Array(channel));
    return true;
  }
}
registerProcessor("capture", Capture);
`;

/**
 * "Thursday", or "Thu 18 Sep" once it is far enough away to be ambiguous.
 *
 * Parsed as midday UTC rather than midnight: a bare `YYYY-MM-DD` is parsed as
 * UTC midnight, which in any timezone west of London is the previous evening,
 * and the strip would be headed with yesterday.
 */
function niceDay(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  const days = Math.round((d.getTime() - Date.now()) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Tomorrow";
  // en-GB, not the visitor's locale. The whole page is in English and the
  // agent has just said the day out loud in English; a German browser was
  // rendering "SONNTAG" under a sentence that said Sunday.
  if (days < 7) return d.toLocaleDateString("en-GB", { weekday: "long" });
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

/** Linear resample to 16 kHz, which is what the speech model wants. */
function toPcm16(samples: Float32Array, fromRate: number): Int16Array {
  const ratio = fromRate / 16000;
  const out = new Int16Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = samples[idx] ?? 0;
    const b = samples[idx + 1] ?? a;
    const value = a + (b - a) * frac;
    out[i] = Math.max(-1, Math.min(1, value)) * 0x7fff;
  }
  return out;
}

export default function Console({
  locationId,
  locationName,
  demoToken,
  compact = false,
  prompts = [
    "Hi, do you have a table for four on Friday around eight?",
    "Actually can you make that six people?",
  ],
  oneTap = false,
  auto = false,
  minimal = false,
  logoUrl,
  chatHref,
}: {
  locationId: string;
  locationName: string;
  /**
   * Signed entitlement for a public demo page. When present the socket goes
   * to /ws/demo and carries no session — the token is what says which venue
   * this call belongs to.
   */
  demoToken?: string;
  /** Drop the operator-facing panes: a prospect wants the conversation. */
  compact?: boolean;
  /**
   * Two things worth saying first, shown before the call starts.
   *
   * Defaulted to a restaurant booking because that is what a venue's own test
   * console is usually for — but on Belline's own line it was telling visitors
   * to ask us for a table for four, which is nonsense and the first thing they
   * read.
   */
  prompts?: [string, string];
  /**
   * One button: connect and open the microphone together.
   *
   * The operator console is three decisions deep before anybody speaks — a
   * number to type, a call to start, then a microphone to switch on. That is
   * right for a venue testing its own agent and wrong for a stranger on the
   * website, who should press one thing and be talking. The mic is opened
   * inside the click because browsers only grant it from a real gesture.
   */
  oneTap?: boolean;
  /**
   * Start the call as soon as this mounts.
   *
   * For the panel the website's bell opens: the tap that opened it was the
   * decision, and asking for a second one inside is the product making the
   * visitor say yes twice.
   */
  auto?: boolean;
  /**
   * Just the call, no transcript.
   *
   * A running transcript is operator tooling — a venue auditing what its
   * agent said. On our own site it turns a phone call into a chat window and
   * invites people to read instead of listen, which is the opposite of the
   * thing being demonstrated.
   */
  minimal?: boolean;
  /** The venue's mark, shown behind the call. Falls back to the bell. */
  logoUrl?: string;
  /**
   * Where to go to type instead.
   *
   * The other half of the 2-in-1, and the half that matters more: somebody who
   * opened the bell on a train, in an open-plan office or beside a sleeping
   * child has already decided they want an answer and just cannot say it out
   * loud. Without this they close the panel. Set only where the venue has both
   * switched on.
   */
  chatHref?: string;
}) {
  const [connected, setConnected] = useState(false);
  const [listening, setListening] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [partial, setPartial] = useState("");
  const [traces, setTraces] = useState<ToolTrace[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState("");
  /**
   * What the speaker is actually doing. "Cannot hear it" is the worst failure
   * this product has, and without this the three causes — no audio sent, a
   * suspended context, and a muted device — are indistinguishable.
   */
  const [audioState, setAudioState] = useState<string>("idle");
  const [heardBytes, setHeardBytes] = useState(0);
  /** Belline is mid-sentence. Drives the call bar; see the effect below. */
  const [speaking, setSpeaking] = useState(false);
  /**
   * The times Belline is offering, if any.
   *
   * Sent by the session off the availability tool's own result, so the page
   * can never show a slot the engine did not offer.
   */
  const [slots, setSlots] = useState<{
    date: string;
    options: { time: string; spoken: string; with?: string }[];
  } | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const captureRef = useRef<{ ctx: AudioContext; stream: MediaStream } | null>(null);
  const playRef = useRef<{ ctx: AudioContext; cursor: number; nodes: AudioBufferSourceNode[] } | null>(null);
  /** Trailing byte of a 16-bit sample split across two websocket frames. */
  const carryRef = useRef<Uint8Array>(new Uint8Array(0));
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [lines, partial]);

  /**
   * Is Belline talking right now?
   *
   * Read off the playback queue rather than from a message, because the
   * server says "here is some audio" long before the speaker finishes
   * playing it. `cursor` is the audio-context time the queue runs dry, so
   * anything before that is speech still coming out. Polled rather than
   * scheduled: chunks arrive continuously and each one moves the target.
   */
  useEffect(() => {
    if (!connected) {
      setSpeaking(false);
      return;
    }
    const id = setInterval(() => {
      const play = playRef.current;
      setSpeaking(Boolean(play && play.ctx.currentTime < play.cursor - 0.05));
    }, 120);
    return () => clearInterval(id);
  }, [connected]);

  // --- playback ------------------------------------------------------------

  /**
   * Open the audio device while a click is still on the stack.
   *
   * Browsers only let audio start from a user gesture. Creating the context
   * lazily when the first chunk arrives puts it inside a websocket callback,
   * where `resume()` is refused — the agent then speaks into a suspended
   * context and the caller hears nothing at all, with no error anywhere.
   */
  const primeAudio = useCallback(async () => {
    if (!playRef.current) {
      playRef.current = { ctx: new AudioContext(), cursor: 0, nodes: [] };
    }
    const ctx = playRef.current.ctx;
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        setError("Your browser blocked audio. Click anywhere on the page, then start the call again.");
      }
    }
    setAudioState(`${ctx.state} @ ${Math.round(ctx.sampleRate / 1000)}kHz`);
  }, []);

  const enqueueAudio = useCallback(async (bytes: ArrayBuffer) => {
    if (!playRef.current) {
      const ctx = new AudioContext();
      playRef.current = { ctx, cursor: 0, nodes: [] };
    }
    const play = playRef.current;
    if (play.ctx.state === "suspended") await play.ctx.resume();

    // The stream arrives in arbitrary chunks that routinely split a 16-bit
    // sample down the middle. `new Int16Array(buffer)` throws outright on an
    // odd byte length, so carry the stray byte into the next chunk — both to
    // avoid the throw and to keep the samples aligned, since a one-byte slip
    // turns the rest of the stream into noise.
    const incoming = new Uint8Array(bytes);
    const joined = new Uint8Array(carryRef.current.length + incoming.length);
    joined.set(carryRef.current, 0);
    joined.set(incoming, carryRef.current.length);

    const usable = joined.length - (joined.length % 2);
    carryRef.current = joined.slice(usable);
    if (usable === 0) return;

    const pcm = new Int16Array(joined.buffer, joined.byteOffset, usable / 2);
    if (pcm.length === 0) return;
    // Declaring the buffer at 16 kHz lets the graph resample it to whatever
    // the output device actually runs at.
    const buffer = play.ctx.createBuffer(1, pcm.length, 16000);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 0x8000;

    const source = play.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(play.ctx.destination);

    setHeardBytes((n) => n + pcm.length * 2);
    if (play.ctx.state !== "running") {
      setAudioState(`${play.ctx.state} — blocked`);
      void play.ctx.resume();
    }

    const now = play.ctx.currentTime;
    // A small floor keeps consecutive chunks butted together rather than
    // clicking when the network delivers them late.
    const startAt = Math.max(now + 0.03, play.cursor);
    source.start(startAt);
    play.cursor = startAt + buffer.duration;
    play.nodes.push(source);
    source.onended = () => {
      play.nodes = play.nodes.filter((n) => n !== source);
    };
  }, []);

  const stopAudio = useCallback(() => {
    const play = playRef.current;
    if (!play) return;
    for (const node of play.nodes) {
      try {
        node.stop();
      } catch {
        // Already finished.
      }
    }
    play.nodes = [];
    play.cursor = 0;
    // A half-sample left over from the interrupted turn would misalign the
    // start of the next one.
    carryRef.current = new Uint8Array(0);
  }, []);

  // --- connection ----------------------------------------------------------

  const connect = useCallback(() => {
    if (socketRef.current) return;
    setError(null);
    setLines([]);
    setTraces([]);

    // Must happen here, in the click handler, not when audio first arrives.
    void primeAudio();

    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    // A signed token means this is a public demo page, where there is no
    // session to authenticate with — the token is the entitlement, and it
    // names the venue, so no locationId is sent or trusted from the client.
    const ws = new WebSocket(
      demoToken
        ? `${proto}://${window.location.host}/ws/demo?token=${encodeURIComponent(demoToken)}`
        : `${proto}://${window.location.host}/ws/voice?locationId=${encodeURIComponent(
            locationId,
          )}&from=${encodeURIComponent(from.trim())}`,
    );
    ws.binaryType = "arraybuffer";
    socketRef.current = ws;

    ws.onopen = () => setConnected(true);

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        // Surface failures. Swallowing them here is how a silent agent looks
        // identical to a working one.
        enqueueAudio(event.data).catch((err) =>
          setError(`Audio: ${err instanceof Error ? err.message : String(err)}`),
        );
        return;
      }
      const msg = JSON.parse(event.data as string);
      switch (msg.type) {
        case "ready":
          setStatus({ llm: msg.llm, stt: msg.stt, tts: msg.tts });
          break;
        case "partial":
          setPartial(msg.text);
          break;
        case "transcript":
          setPartial("");
          setLines((prev) => {
            // Agent turns stream in as fragments; merge them into one bubble.
            const last = prev[prev.length - 1];
            if (msg.role === "agent" && last?.role === "agent" && last.latencyMs === undefined) {
              return [...prev.slice(0, -1), { ...last, text: `${last.text} ${msg.text}` }];
            }
            return [...prev, { role: msg.role, text: msg.text }];
          });
          break;
        case "tool":
          setTraces((prev) => [msg.trace, ...prev]);
          break;
        case "slots":
          setSlots({ date: msg.date, options: msg.options });
          break;
        case "interrupted":
          stopAudio();
          break;
        case "clear":
          stopAudio();
          break;
        case "turn_end":
          setLines((prev) => {
            const last = prev[prev.length - 1];
            if (last?.role !== "agent") return prev;
            return [...prev.slice(0, -1), { ...last, latencyMs: msg.latencyMs }];
          });
          break;
        case "ended":
          setLines((prev) => [
            ...prev,
            { role: "system", text: `Call ended — ${msg.outcome ?? "no outcome"}. ${msg.summary ?? ""}` },
          ]);
          break;
        case "error":
        case "stt_error":
        case "tts_error":
          setError(`${msg.type}: ${msg.message}`);
          break;
      }
    };

    ws.onclose = () => {
      setConnected(false);
      socketRef.current = null;
      stopListening();
    };
    /**
     * Ask why, rather than shrugging.
     *
     * A failed websocket handshake tells JavaScript nothing — the browser
     * hides the status, so a refused token, a line at its daily limit and a
     * server that is simply down all arrive here identically. "Connection
     * failed" was the result, which helps nobody and hid a real cause for a
     * while. The status endpoint runs the same checks the upgrade does and
     * answers in words.
     */
    ws.onerror = () => {
      setError("Connection failed.");
      if (!demoToken) return;
      fetch(`/api/call/status?token=${encodeURIComponent(demoToken)}`)
        .then((r) => r.json())
        .then((why: { ok: boolean; say?: string }) => {
          if (!why.ok && why.say) setError(why.say);
        })
        .catch(() => {
          // The endpoint is unreachable too, so the network is the answer.
          setError("We could not reach Belline just now. Try again in a moment.");
        });
    };
  }, [locationId, from, demoToken, enqueueAudio, stopAudio, primeAudio]);

  const hangup = useCallback(() => {
    stopListening();
    stopAudio();
    socketRef.current?.send(JSON.stringify({ type: "hangup" }));
    socketRef.current?.close();
    socketRef.current = null;
    setConnected(false);
  }, [stopAudio]);

  // --- microphone ----------------------------------------------------------

  /**
   * One gesture: open the microphone, then connect.
   *
   * In that order, and deliberately. `getUserMedia` has to be called inside
   * the click or the browser refuses it — and asking first means the socket
   * is not already open and greeting an empty room while a permission prompt
   * sits on top of the page. If they decline, the call still goes ahead: they
   * can type, and a refused microphone is not a reason to refuse the
   * conversation.
   */
  const answerAndListen = useCallback(() => {
    // Playback first, and synchronously, while the click is still on the
    // stack. `getUserMedia` puts a permission prompt in front of the user,
    // and by the time they answer it the gesture has expired — `resume()` is
    // then refused, the greeting plays into a suspended context, and they
    // hear nothing at all with no error anywhere. Which is the single worst
    // failure this product has.
    void primeAudio();
    void startListening().finally(() => connect());
    // primeAudio/startListening/connect are stable for this component's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function stopListening() {
    const capture = captureRef.current;
    if (capture) {
      capture.stream.getTracks().forEach((t) => t.stop());
      void capture.ctx.close();
      captureRef.current = null;
    }
    setListening(false);
  }

  const startListening = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const ctx = new AudioContext();
      const blob = new Blob([CAPTURE_WORKLET], { type: "application/javascript" });
      await ctx.audioWorklet.addModule(URL.createObjectURL(blob));

      const source = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, "capture");
      node.port.onmessage = (event) => {
        const ws = socketRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        const pcm = toPcm16(event.data as Float32Array, ctx.sampleRate);
        ws.send(pcm.buffer);
      };
      source.connect(node);
      // Worklets are only pulled when connected to a destination; a muted
      // gain node keeps the graph running without echoing the mic to output.
      const sink = ctx.createGain();
      sink.gain.value = 0;
      node.connect(sink).connect(ctx.destination);

      captureRef.current = { ctx, stream };
      setListening(true);
    } catch (err) {
      setError(`Microphone: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  useEffect(() => () => {
    stopListening();
    socketRef.current?.close();
  }, []);

  // --- text ----------------------------------------------------------------

  function sendText() {
    const text = draft.trim();
    if (!text || !socketRef.current) return;
    socketRef.current.send(JSON.stringify({ type: "text", text }));
    setDraft("");
  }

  /**
   * Start on mount — but only when embedded.
   *
   * Inside the dock on belline.ai the tap that opened it was the decision,
   * and a second button is the product asking twice. Opened directly the page
   * has had no decision at all, and auto-starting would mean any crawler,
   * link preview or stray visit opens a real call — burning the daily cap and
   * spending with three vendors for a conversation nobody is having.
   *
   * `window.top` throws on a cross-origin parent in some browsers, hence the
   * try: a failure there means framed, which is the safe reading.
   */
  useEffect(() => {
    if (auto) answerAndListen();
  }, [auto, answerAndListen]);

  /**
   * Tell the page framing us how tall we need to be.
   *
   * The dock on belline.ai is a fixed 76px, which is right for a status bar
   * and clips a row of times to a sliver. An iframe cannot resize itself, so
   * it asks. Guarded by a fixed origin — a page that accepts layout
   * instructions from anywhere is a page anybody can reshape.
   */
  useEffect(() => {
    if (!minimal) return;
    try {
      if (window.self === window.top) return;
      window.parent.postMessage(
        { source: "belline-call", height: slots ? 178 : 76 },
        "*",
      );
    } catch {
      // Cross-origin parent we cannot reach. The dock keeps its default size.
    }
  }, [slots, minimal]);

  // --- render --------------------------------------------------------------

  if (minimal) {
    const sound = audioState.startsWith("running");
    // Opened directly rather than docked in the site: nothing has started, and
    // "Connecting…" forever would be a lie. Offer the call instead.
    // Only once we know we are *not* framed. Unknown is treated as connecting.
    // Only when nothing was asked to start. With `auto` the call is already
    // on its way, and offering a button for it is the second press this whole
    // thing exists to remove.
    const idle = !auto && !connected;

    const state = idle
      ? "Ask it anything, or book a call with us"
      : !connected
        ? "Connecting…"
        : !sound
          ? "Tap to turn sound on"
          : speaking
            ? "Belline is speaking"
            : listening
              ? "Listening — go ahead"
              : "Microphone off";

    /**
     * Sound blocked: the whole screen becomes the tap target.
     *
     * Navigating to this page spends the gesture that got here, so on a phone
     * the audio context can arrive suspended — Belline is talking and nobody
     * can hear it. A 100px button in the corner is a poor answer to that when
     * the entire screen is available and the instruction is "tap".
     */
    const blocked = connected && !sound;

    return (
      <div
        className={`callbar${blocked ? " is-blocked" : ""}`}
        onClick={blocked ? () => void primeAudio() : undefined}
      >
        {/*
          The waveform and the name sit together in the middle, because on a
          voice call the sound is the subject and everything else is chrome.
          Nine bars rather than five: at this size five read as a loading
          spinner, and the point is that it looks like something being said.
        */}
        {/*
          The mark behind the call. A venue's own, where they have given us
          one — this widget is the single place their customer sees Belline
          rather than them — and the bell otherwise. Faint and enormous, so it
          reads as a ground rather than as a thing competing with the voice.
        */}
        <div className="callbar-mark" aria-hidden="true">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt="" />
          ) : (
            // Dieselbe Geometrie wie public/mark.svg und components/Brand.tsx.
            // Vorher stand hier die alte, gerundete Glocke: wer auf der Seite
            // auf das neue Zeichen tippt, bekam das alte in Bildschirmgröße
            // präsentiert — dieselbe Marke in zwei Zeichnungen, einen Klick
            // voneinander entfernt.
            <svg viewBox="0 0 48 48" focusable="false">
              <g fill="currentColor">
                <circle cx="24" cy="9.5" r="3.5" />
                <path d="M9 31.5a15 15 0 0 1 30 0Z" />
                <rect x="5" y="35" width="38" height="5.5" rx="2.75" />
              </g>
            </svg>
          )}
        </div>

        <div className="callbar-main">
          <div className={`callbar-wave${speaking ? " is-on" : ""}`} aria-hidden="true">
            <span /><span /><span /><span /><span /><span /><span /><span /><span />
          </div>

          <div className="callbar-text">
            <strong>{locationName}</strong>
            <span>{error ?? state}</span>
          </div>

          {/*
            The times, while it is still saying them.
            Tapping one *speaks* it rather than booking it directly. That
            keeps one path through the booking engine instead of two, so a
            tap and a spoken sentence cannot diverge — and the caller hears
            Belline confirm, which is what makes it feel like a call rather
            than a form.
          */}
          {slots && connected && (
            <div className="callbar-slots">
              <div className="callbar-slots-day">{niceDay(slots.date)}</div>
              <div className="callbar-slots-row" role="list">
                {slots.options.map((o) => (
                  <button
                    key={`${o.time}-${o.with ?? ""}`}
                    type="button"
                    role="listitem"
                    className="callbar-slot"
                    onClick={() => {
                      socketRef.current?.send(
                        JSON.stringify({
                          type: "text",
                          text: o.with
                            ? `${o.spoken} with ${o.with}, please.`
                            : `${o.spoken}, please.`,
                        }),
                      );
                      setSlots(null);
                    }}
                  >
                    <strong>{o.time}</strong>
                    {o.with && <em>{o.with}</em>}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/*
          Sound can be blocked despite everything: a permission granted long
          ago means no prompt, and some browsers still will not start audio
          without a fresh gesture. Rather than leave somebody in silence
          wondering, this is one tap that fixes it.
        */}
        {idle ? (
          <button className="callbar-go" onClick={answerAndListen}>
            Talk to Belline
          </button>
        ) : connected && !sound ? (
          <button className="callbar-go" onClick={() => void primeAudio()}>
            Turn on sound
          </button>
        ) : (
          <button
            className="callbar-end"
            onClick={hangup}
            disabled={!connected}
            aria-label="End the call"
          >
            End
          </button>
        )}

        {/*
          Typing instead. Quiet, and below the thing it is an alternative to —
          the bell is what this product does that a chat widget does not, and
          this is the escape hatch for the person who cannot use it right now.
        */}
        {chatHref && (
          <a className="callbar-swap" href={chatHref}>
            Rather type? Send a message
          </a>
        )}
      </div>
    );
  }

  return (
    <div className={compact ? undefined : "split split-wide"}>
      <div className="panel console-pane" style={{ display: "flex", flexDirection: "column" }}>
        <div
          style={{
            padding: "12px 16px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontWeight: 600, fontSize: 13 }}>{locationName}</span>
          <span
            className="pill"
            style={{
              color: connected ? "var(--ok)" : "var(--muted)",
              borderColor: connected ? "var(--ok)" : "var(--border)",
              background: connected ? "var(--ok-soft)" : "var(--panel-2)",
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: 99,
                background: connected ? "var(--ok)" : "var(--muted)",
              }}
            />
            {connected ? "on the line" : "idle"}
          </span>
          {status && (
            <>
              <Capability on={status.llm} label="model" />
              <Capability on={status.stt} label="speech-in" />
              <Capability on={status.tts} label="speech-out" />
            </>
          )}
          {connected && (
            <span
              className="pill mono"
              title="Web Audio state, and how much audio the browser has been handed"
              style={{
                color: audioState.startsWith("running") ? "var(--ok)" : "var(--bad)",
                borderColor: audioState.startsWith("running") ? "var(--ok)" : "var(--bad)",
              }}
            >
              🔊 {audioState}
              {heardBytes > 0 ? ` · ${Math.round(heardBytes / 1024)}KB` : " · no audio yet"}
            </span>
          )}
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            {!connected ? (
              <>
                {/*
                  The "calling from" box is operator tooling: it makes the
                  agent recognise a number that already has a booking. On a
                  public line it is a field a stranger has to decide about
                  before they are allowed to speak, which is one step too many
                  in front of the only thing that matters.
                */}
                {!oneTap && (
                  <input
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                    placeholder="Calling from… (optional)"
                    title="Give a number that already has a booking and the agent will recognise the caller."
                    style={{ width: 190 }}
                  />
                )}
                <button className="btn btn-accent" onClick={oneTap ? answerAndListen : connect}>
                  {oneTap ? "Talk to Belline" : "Start call"}
                </button>
              </>
            ) : (
              <>
                <button
                  className="btn"
                  onClick={() => (listening ? stopListening() : void startListening())}
                  style={listening ? { borderColor: "var(--bad)", color: "var(--bad)" } : undefined}
                  disabled={status ? !status.stt : false}
                  title={status && !status.stt ? "Set DEEPGRAM_API_KEY to use the microphone" : ""}
                >
                  {listening ? "◼ Mute" : "◉ Speak"}
                </button>
                <button className="btn btn-danger" onClick={hangup}>
                  Hang up
                </button>
              </>
            )}
          </div>
        </div>

        <div
          ref={scrollRef}
          className="console-transcript"
          style={{ flex: 1, overflowY: "auto", padding: "16px" }}
        >
          {lines.length === 0 && !connected && (
            <p className="muted" style={{ fontSize: 13, lineHeight: 1.6 }}>
              {oneTap ? (
                <>
                  Press <strong>Talk to Belline</strong> and it will answer and start
                  speaking. Allow the microphone when your browser asks — or just type
                  instead.
                </>
              ) : (
                <>
                  Press <strong>Start call</strong>. The agent greets you first, then either
                  type below or press <strong>Speak</strong> and talk to it.
                </>
              )}
              <br />
              <br />
              Try: <em>&ldquo;{prompts[0]}&rdquo;</em>
              <br />
              Then: <em>&ldquo;{prompts[1]}&rdquo;</em>
            </p>
          )}
          {lines.map((line, i) => (
            <Bubble key={i} line={line} />
          ))}
          {partial && (
            <div style={{ opacity: 0.45, fontSize: 13, fontStyle: "italic", marginTop: 8 }}>
              {partial}…
            </div>
          )}
        </div>

        {error && (
          <div
            style={{
              padding: "9px 16px",
              borderTop: "1px solid var(--border)",
              color: "var(--bad)",
              fontSize: 12,
            }}
          >
            {error}
          </div>
        )}

        <div style={{ padding: 12, borderTop: "1px solid var(--border)", display: "flex", gap: 8 }}>
          <input
            value={draft}
            disabled={!connected}
            placeholder={connected ? "Type what the caller says…" : "Start a call first"}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && sendText()}
          />
          <button className="btn" onClick={sendText} disabled={!connected || !draft.trim()}>
            Send
          </button>
        </div>
      </div>

      <div className="panel console-pane" style={{ display: compact ? "none" : "flex", flexDirection: "column" }}>
        <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)", fontWeight: 600, fontSize: 13 }}>
          Tool calls
          <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>
            what it actually did
          </span>
        </div>
        <div className="console-tools" style={{ flex: 1, overflowY: "auto", padding: 12 }}>
          {traces.length === 0 ? (
            <p className="muted" style={{ fontSize: 12.5, padding: 6, margin: 0 }}>
              Nothing yet. Ask about a time and <span className="mono">check_availability</span>{" "}
              will appear here with its arguments and its answer.
            </p>
          ) : (
            traces.map((trace, i) => <Trace key={i} trace={trace} />)
          )}
        </div>
      </div>
    </div>
  );
}

function Capability({ on, label }: { on: boolean; label: string }) {
  return (
    <span className="pill" style={{ opacity: on ? 1 : 0.45 }}>
      {on ? "✓" : "·"} {label}
    </span>
  );
}

function Bubble({ line }: { line: Line }) {
  if (line.role === "system") {
    return (
      <div
        className="muted"
        style={{ fontSize: 12, textAlign: "center", margin: "14px 0", fontStyle: "italic" }}
      >
        {line.text}
      </div>
    );
  }
  const isAgent = line.role === "agent";
  return (
    <div style={{ display: "flex", justifyContent: isAgent ? "flex-start" : "flex-end", marginBottom: 10 }}>
      <div style={{ maxWidth: "82%" }}>
        <div
          style={{
            padding: "9px 13px",
            borderRadius: 11,
            fontSize: 13.5,
            lineHeight: 1.5,
            background: isAgent ? "var(--panel-2)" : "var(--accent)",
            color: isAgent ? "var(--text)" : "#fff",
            border: isAgent ? "1px solid var(--border)" : "none",
          }}
        >
          {line.text}
        </div>
        {line.latencyMs !== undefined && line.latencyMs > 0 && (
          <div
            className="muted mono"
            style={{ fontSize: 10.5, marginTop: 3, marginLeft: 3 }}
          >
            first audio {line.latencyMs} ms
          </div>
        )}
      </div>
    </div>
  );
}

function Trace({ trace }: { trace: ToolTrace }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        marginBottom: 8,
        background: "var(--panel-2)",
      }}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%",
          background: "none",
          border: "none",
          color: "inherit",
          padding: "9px 11px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span
          className="mono"
          style={{ fontSize: 12, fontWeight: 600, color: trace.ok ? "var(--accent)" : "var(--bad)" }}
        >
          {trace.name}
        </span>
        <span className="muted mono" style={{ fontSize: 11, marginLeft: "auto" }}>
          {trace.ms} ms
        </span>
        <span className="muted" style={{ fontSize: 10 }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div style={{ padding: "0 11px 11px" }}>
          <Json label="in" value={trace.input} />
          <Json label="out" value={trace.output} />
        </div>
      )}
    </div>
  );
}

function Json({ label, value }: { label: string; value: unknown }) {
  return (
    <div style={{ marginTop: 7 }}>
      <div className="muted" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em" }}>
        {label}
      </div>
      <pre
        className="mono"
        style={{
          margin: "3px 0 0",
          fontSize: 11,
          lineHeight: 1.45,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          color: "var(--muted)",
        }}
      >
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

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
}: {
  locationId: string;
  locationName: string;
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

  const socketRef = useRef<WebSocket | null>(null);
  const captureRef = useRef<{ ctx: AudioContext; stream: MediaStream } | null>(null);
  const playRef = useRef<{ ctx: AudioContext; cursor: number; nodes: AudioBufferSourceNode[] } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [lines, partial]);

  // --- playback ------------------------------------------------------------

  const enqueueAudio = useCallback(async (bytes: ArrayBuffer) => {
    if (!playRef.current) {
      const ctx = new AudioContext();
      playRef.current = { ctx, cursor: 0, nodes: [] };
    }
    const play = playRef.current;
    if (play.ctx.state === "suspended") await play.ctx.resume();

    const pcm = new Int16Array(bytes);
    if (pcm.length === 0) return;
    // Declaring the buffer at 16 kHz lets the graph resample it to whatever
    // the output device actually runs at.
    const buffer = play.ctx.createBuffer(1, pcm.length, 16000);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 0x8000;

    const source = play.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(play.ctx.destination);

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
  }, []);

  // --- connection ----------------------------------------------------------

  const connect = useCallback(() => {
    if (socketRef.current) return;
    setError(null);
    setLines([]);
    setTraces([]);

    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(
      `${proto}://${window.location.host}/ws/voice?locationId=${encodeURIComponent(
        locationId,
      )}&from=${encodeURIComponent(from.trim())}`,
    );
    ws.binaryType = "arraybuffer";
    socketRef.current = ws;

    ws.onopen = () => setConnected(true);

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        void enqueueAudio(event.data);
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
    ws.onerror = () => setError("Connection failed.");
  }, [locationId, from, enqueueAudio, stopAudio]);

  const hangup = useCallback(() => {
    stopListening();
    stopAudio();
    socketRef.current?.send(JSON.stringify({ type: "hangup" }));
    socketRef.current?.close();
    socketRef.current = null;
    setConnected(false);
  }, [stopAudio]);

  // --- microphone ----------------------------------------------------------

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

  // --- render --------------------------------------------------------------

  return (
    <div className="split split-wide">
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
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            {!connected ? (
              <>
                <input
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  placeholder="Calling from… (optional)"
                  title="Give a number that already has a booking and the agent will recognise the caller."
                  style={{ width: 190 }}
                />
                <button className="btn btn-accent" onClick={connect}>
                  Start call
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
                  {listening ? "◼ Stop mic" : "◉ Speak"}
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
              Press <strong>Start call</strong>. The agent greets you first, then either type
              below or press <strong>Speak</strong> and talk to it.
              <br />
              <br />
              Try: <em>&ldquo;Hi, do you have a table for four on Friday around eight?&rdquo;</em>
              <br />
              Then: <em>&ldquo;Actually can you make that six people?&rdquo;</em>
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

      <div className="panel console-pane" style={{ display: "flex", flexDirection: "column" }}>
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

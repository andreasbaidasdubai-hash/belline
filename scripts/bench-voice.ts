/**
 * Two ways to ask for speech, timed.
 *
 * Today every spoken clause is its own HTTPS request. The obvious objection is
 * that each one pays for a connection — but Node pools connections, so the
 * obvious objection may simply be wrong, and rewriting the voice layer on a
 * hunch would be a poor trade for the risk. So: measure.
 *
 * What is measured is time to the *first byte of audio*, because that is what
 * the caller experiences. Everything after the first byte arrives while they
 * are already listening.
 *
 *   run 0 is reported separately from the rest. A cold connection is a real
 *   cost, but it is paid once per call during the greeting, not once per
 *   clause, so averaging it into the per-turn number would flatter the
 *   websocket and slander the status quo.
 *
 *   npm run bench:voice
 */

import WebSocket from "ws";

const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) {
  console.log("\n  Needs ELEVENLABS_API_KEY. Set it and run again.\n");
  process.exit(0);
}

const VOICE = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";
const FORMAT = "ulaw_8000";

/** A real turn, cut where the sentence chunker would cut it. */
const TURN = [
  "Of course, let me have a look.",
  "I've got quarter past seven, or half past eight.",
  "Which would suit you better?",
];

const MODELS = ["eleven_v3_conversational", "eleven_flash_v2_5"];
const RUNS = 4;

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

// ---------------------------------------------------------------------------
// One HTTPS request per clause — what the product does today.
// ---------------------------------------------------------------------------

async function httpClause(text: string, model: string): Promise<number> {
  const t0 = Date.now();
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE}/stream?output_format=${FORMAT}`,
    {
      method: "POST",
      headers: { "xi-api-key": KEY!, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: model,
        voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.15, speed: 1.05 },
      }),
    },
  );
  if (!res.ok || !res.body) throw new Error(`${res.status}: ${(await res.text()).slice(0, 120)}`);
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value?.length) break; // first audio byte — the whole measurement
  }
  await reader.cancel().catch(() => {});
  return Date.now() - t0;
}

// ---------------------------------------------------------------------------
// One socket per call, one context per turn.
// ---------------------------------------------------------------------------

interface Socket {
  clause(text: string, contextId: string, first: boolean): Promise<number>;
  endContext(contextId: string): void;
  close(): void;
}

async function openSocket(model: string): Promise<Socket> {
  const url =
    `wss://api.elevenlabs.io/v1/text-to-speech/${VOICE}/multi-stream-input` +
    `?model_id=${model}&output_format=${FORMAT}`;
  const ws = new WebSocket(url, { headers: { "xi-api-key": KEY! } });

  let waiting: ((ms: number) => void) | null = null;
  let askedAt = 0;
  let failure: string | null = null;

  ws.on("message", (raw) => {
    let msg: { audio?: string | null; error?: string; message?: string };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.error || (msg.message && !msg.audio)) failure ??= msg.error ?? msg.message ?? null;
    // `audio` arrives base64, and is null on the bookkeeping frames.
    if (msg.audio && waiting) {
      waiting(Date.now() - askedAt);
      waiting = null;
    }
  });

  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once("error", reject);
  });

  return {
    clause(text, contextId, first) {
      askedAt = Date.now();
      // A trailing space is how the engine is told the clause is whole.
      const payload: Record<string, unknown> = { text: `${text} `, context_id: contextId };
      if (first) {
        payload.voice_settings = {
          stability: 0.5,
          similarity_boost: 0.8,
          style: 0.15,
          speed: 1.05,
        };
      }
      ws.send(JSON.stringify(payload));
      ws.send(JSON.stringify({ context_id: contextId, flush: true }));
      return new Promise<number>((resolve, reject) => {
        waiting = resolve;
        setTimeout(() => reject(new Error(failure ?? "no audio within 10s")), 10_000);
      });
    },
    endContext(contextId) {
      ws.send(JSON.stringify({ context_id: contextId, close_context: true }));
    },
    close() {
      try {
        ws.send(JSON.stringify({ close_socket: true }));
      } catch {
        /* already gone */
      }
      ws.close();
    },
  };
}

// ---------------------------------------------------------------------------

console.log("\n  Time to the first byte of audio, at 8 kHz µ-law\n");

for (const model of MODELS) {
  console.log(`  ${model}`);
  console.log("  " + "-".repeat(64));

  // --- HTTP, as shipped -----------------------------------------------------
  const httpFirst: number[] = [];
  const httpRest: number[] = [];
  for (let run = 0; run < RUNS; run++) {
    for (let i = 0; i < TURN.length; i++) {
      try {
        const ms = await httpClause(TURN[i], model);
        (run === 0 && i === 0 ? httpFirst : httpRest).push(ms);
      } catch (err) {
        console.log(`    http failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // --- Websocket, one socket held open for the whole "call" -----------------
  const wsFirst: number[] = [];
  const wsRest: number[] = [];
  let wsNote = "";
  try {
    const socket = await openSocket(model);
    for (let run = 0; run < RUNS; run++) {
      const ctx = `turn-${run}`;
      for (let i = 0; i < TURN.length; i++) {
        try {
          const ms = await socket.clause(TURN[i], ctx, i === 0);
          (run === 0 && i === 0 ? wsFirst : wsRest).push(ms);
        } catch (err) {
          wsNote ||= err instanceof Error ? err.message : String(err);
        }
      }
      socket.endContext(ctx);
    }
    socket.close();
  } catch (err) {
    wsNote = err instanceof Error ? err.message : String(err);
  }

  const row = (label: string, cold: number[], warm: number[], note: string) =>
    console.log(
      `    ${label.padEnd(12)} cold ${(cold.length ? `${Math.round(mean(cold))}ms` : "—").padStart(7)}` +
        `   warm ${(warm.length ? `${Math.round(mean(warm))}ms` : "—").padStart(7)}` +
        `   (n=${warm.length})${note ? `  ${note}` : ""}`,
    );

  row("http", httpFirst, httpRest, "");
  row("websocket", wsFirst, wsRest, wsNote ? `⚠ ${wsNote.slice(0, 60)}` : "");
  console.log();
}

console.log(
  "  'warm' is the number that matters: on a live call the connection is\n" +
    "  already open by the time anybody has said anything.\n",
);

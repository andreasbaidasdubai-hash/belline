import { createServer } from "node:http";
import { parse } from "node:url";
import next from "next";
import { WebSocketServer, type WebSocket } from "ws";

import { seedIfEmpty } from "./src/lib/seed";
import { getLocation, listLocations, saveCall } from "./src/lib/store";
import {
  canSeeLocation,
  sessionIdFromCookieHeader,
  userForSession,
  verifyStreamToken,
} from "./src/lib/auth";
import { reconcileStaleCalls, startCall } from "./src/lib/calls";
import type { User } from "./src/lib/types";
import { greetingFor } from "./src/lib/agent/runtime";
import { checkDemoGate } from "./src/lib/demo";
import { isMarketingHost, marketingSiteExists, serveMarketing } from "./src/lib/marketing";
import { speakClip, ttsEnabled } from "./src/lib/providers/tts";
import { VoiceSession } from "./src/lib/voice/session";
import { BrowserTransport, TwilioTransport } from "./src/lib/voice/transports";

/**
 * Custom server.
 *
 * Next's route handlers cannot hold a websocket open, and a realtime voice
 * bridge is nothing but held-open websockets. So Next runs as a request
 * handler inside a plain http server and the two voice endpoints are attached
 * to the same port — one process, one `npm run dev`, no second terminal.
 *
 * When this goes to production the dashboard can live on Vercel, but *this*
 * process cannot: serverless functions have no persistent socket. It belongs
 * on Fly, Railway, Render, or a container — somewhere a process stays up.
 */

const dev = !process.argv.includes("--prod") && process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT ?? 3000);
const app = next({ dev });
const handle = app.getRequestHandler();

await app.prepare();
// Only valid after prepare(); it is what keeps dev-mode hot reload working
// once we take over the upgrade event.
const upgradeHandler = app.getUpgradeHandler();
seedIfEmpty();
const reconciled = reconcileStaleCalls();
void warmGreetings();

// Built at image time. Absent in a bare dev checkout, where the marketing
// pages are served by Next out of public/ instead.
const marketingReady = marketingSiteExists();

const server = createServer((req, res) => {
  // The website and the product share this process, chosen by hostname. See
  // marketing.ts — anything that is not `app.` is the website, and a request
  // it does not recognise falls through to Next rather than 404ing.
  if (marketingReady && isMarketingHost(req.headers.host) && serveMarketing(req, res)) return;
  handle(req, res, parse(req.url ?? "/", true));
});

const browserWss = new WebSocketServer({ noServer: true });
const twilioWss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const { pathname, query } = parse(req.url ?? "/", true);

  if (pathname === "/ws/voice") {
    // The test console starts real, metered calls. Anyone who can open this
    // socket can spend money, so it needs the same session as the dashboard.
    const user = userForSession(sessionIdFromCookieHeader(req.headers.cookie));
    if (!user) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    browserWss.handleUpgrade(req, socket, head, (ws) => {
      handleBrowser(ws, String(query.locationId ?? ""), String(query.from ?? ""), user);
    });
    return;
  }

  // A prospect's personalised demo page has no session — the visitor has
  // never signed in and never will. The signed token issued when that page
  // rendered is the entitlement, and it names the venue, so the browser never
  // gets to choose which business it would like to spend a call on.
  if (pathname === "/ws/demo") {
    const locationId = verifyStreamToken(String(query.token ?? ""));
    const location = locationId ? getLocation(locationId) : undefined;
    if (!location?.prospect || !location.demo?.enabled) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const gate = checkDemoGate(location);
    if (!gate.allowed) {
      socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    browserWss.handleUpgrade(req, socket, head, (ws) => {
      handleBrowser(ws, location.id, "", null);
    });
    return;
  }

  if (pathname === "/ws/twilio") {
    twilioWss.handleUpgrade(req, socket, head, (ws) => {
      handleTwilio(ws);
    });
    return;
  }

  // Everything else is Next's — most importantly HMR in dev.
  void upgradeHandler(req, socket, head);
});

// ---------------------------------------------------------------------------
// Browser test console
// ---------------------------------------------------------------------------

function handleBrowser(
  ws: WebSocket,
  locationId: string,
  from: string,
  /** Null on a public prospect demo, where the signed token stood in for one. */
  user: User | null,
): void {
  const location = getLocation(locationId) ?? listLocations()[0];
  if (!location) {
    ws.send(JSON.stringify({ type: "error", message: "No locations configured." }));
    ws.close();
    return;
  }

  // Signed in is not the same as entitled to this venue. A null user only
  // arrives from /ws/demo, which has already verified a signed token naming
  // this exact venue — so there is nothing further to check here.
  if (user && !canSeeLocation(user, location.id)) {
    ws.send(JSON.stringify({ type: "error", message: "Not your venue." }));
    ws.close();
    return;
  }

  // A caller id can be supplied from the console so guest recognition and
  // "look up my booking" are testable without a phone line.
  const callerNumber = from.trim() || undefined;
  const call = startCall(location, "browser", callerNumber ?? "browser-console");
  const session = new VoiceSession(
    location,
    call,
    new BrowserTransport(ws),
    callerNumber,
  );

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      session.onAudio(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
      return;
    }
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "text" && typeof msg.text === "string") {
        void session.onText(msg.text);
      } else if (msg.type === "hangup") {
        void session.end("abandoned", "Caller hung up.");
      }
    } catch {
      // Ignore anything that is not one of our control frames.
    }
  });

  ws.on("close", () => void session.end("abandoned"));
  ws.on("error", () => void session.end("abandoned"));

  void session.start().catch((err) => {
    ws.send(JSON.stringify({ type: "error", message: String(err) }));
  });
}

// ---------------------------------------------------------------------------
// Twilio Media Streams
// ---------------------------------------------------------------------------

function handleTwilio(ws: WebSocket): void {
  let session: VoiceSession | null = null;

  ws.on("message", (data) => {
    let msg: {
      event?: string;
      start?: {
        streamSid?: string;
        customParameters?: Record<string, string>;
      };
      media?: { payload?: string };
    };
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    switch (msg.event) {
      case "start": {
        const params = msg.start?.customParameters ?? {};
        // The webhook signature protects the webhook; this protects the
        // socket the webhook points at. Without it, anyone who learns the
        // hostname can open metered calls straight into the media bridge.
        const locationId = verifyStreamToken(params.token);
        const location = locationId ? getLocation(locationId) : undefined;
        const streamSid = msg.start?.streamSid ?? "";
        if (!location || !streamSid) {
          ws.close();
          return;
        }
        const call = startCall(location, "phone", params.from ?? "unknown");
        if (location.demo?.enabled) {
          call.isDemo = true;
          saveCall(call);
        }
        session = new VoiceSession(
          location,
          call,
          new TwilioTransport(ws, streamSid),
          params.from,
        );
        void session.start();
        break;
      }
      case "media": {
        if (session && msg.media?.payload) {
          session.onAudio(Buffer.from(msg.media.payload, "base64"));
        }
        break;
      }
      case "stop": {
        void session?.end("abandoned", "Caller hung up.");
        session = null;
        break;
      }
    }
  });

  ws.on("close", () => void session?.end("abandoned"));
  ws.on("error", () => void session?.end("abandoned"));
}

/**
 * Synthesise each demo line's greeting once, at boot, into the clip cache.
 *
 * Without it the first caller after every deploy waits through a synthesis
 * round trip of silence before anyone speaks — and on a demo line the first
 * caller after a deploy is the one most likely to be a prospect. Costs a few
 * hundred characters per boot.
 *
 * Deliberately not awaited and never fatal: a cold cache is slower, a server
 * that refuses to start because a vendor is down is broken.
 */
async function warmGreetings(): Promise<void> {
  if (!ttsEnabled()) return;
  for (const location of listLocations().filter((l) => l.demo?.enabled)) {
    // Which voice is actually live is otherwise invisible from outside the
    // container — the store sits on a mounted disk, and "is it set to the
    // voice I picked?" is a question worth being able to answer from the logs.
    console.log(
      `[voice] ${location.name}: voice=${location.agent.voiceId} model=${
        location.agent.voiceModel ?? "default"
      } speed=${location.agent.voiceSpeed ?? "default"}`,
    );
    try {
      await speakClip(greetingFor(location), {
        voiceId: location.agent.voiceId,
        modelId: location.agent.voiceModel,
        speed: location.agent.voiceSpeed,
        format: "ulaw_8000",
      });
    } catch {
      // Left cold on purpose; the first real call will fill it.
    }
  }
}

server.listen(port, () => {
  const keys = [
    ["model", process.env.ANTHROPIC_API_KEY],
    ["speech-to-text", process.env.DEEPGRAM_API_KEY],
    ["text-to-speech", process.env.ELEVENLABS_API_KEY],
  ] as const;
  console.log(`\n  Belline  →  http://localhost:${port}\n`);
  for (const [name, key] of keys) {
    console.log(`   ${key ? "✓" : "·"} ${name}${key ? "" : "  (mocked — set the key in .env)"}`);
  }
  if (reconciled > 0) {
    console.log(`\n   closed ${reconciled} call${reconciled === 1 ? "" : "s"} left open by the last run`);
  }
  console.log("");
});

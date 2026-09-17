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
import { checkConsoleGate, checkDemoGate } from "./src/lib/demo";
import { paidWorkRefusal } from "./src/lib/abuse/gate";
import { checkEmbedGate } from "./src/lib/embed";
import { mayStreamTo, watchLiveness, sweepLiveness, type Liveness } from "./src/lib/voice/entitlement";
import { applyIndexing, isMarketingHost, marketingSiteExists, serveMarketing } from "./src/lib/marketing";
import { speakClip, ttsEnabled } from "./src/lib/providers/tts";
import { meterTts } from "./src/lib/billing/cost";
import { VoiceSession, greetingClip, acknowledgementClips } from "./src/lib/voice/session";
import { allowedLanguages } from "./src/lib/language";
import { ensureOwnWhatsAppAccount, ensureTwilioSandboxAccount } from "./src/lib/whatsapp";
import { BrowserTransport, TwilioTransport, publicEvent } from "./src/lib/voice/transports";
import { sendDueReminders } from "./src/lib/reminders";
import { flag, stubsRequested } from "./src/lib/flags";
import { graphClient } from "./src/lib/whatsapp-provision";
import { runWhatsAppChecks } from "./src/lib/whatsapp-selfserve";
import { PEER_HEADER } from "./src/lib/onboarding/limit";
import { sweepTrialEnds } from "./src/lib/billing/trial-end";
import { retryPendingAlerts } from "./src/lib/billing/usage-policy";
import { VIEW_AS_EXIT_PATH, decideViewAs, isViewAsSession } from "./src/lib/staff/view-as";
import { runReadOnly } from "./src/lib/staff/readonly";

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

// Local end-to-end runs only. Throws, and so refuses to boot, in production or
// next to a real database; otherwise every outbound fetch to a host that is
// not this machine throws from here on.
if (stubsRequested()) {
  const { installStubs } = await import("./src/lib/testing/stubs");
  installStubs();
  console.log("[stubs] FLAG_STUBS=on: fake providers, outbound requests to other hosts are blocked");
}

await app.prepare();
// Only valid after prepare(); it is what keeps dev-mode hot reload working
// once we take over the upgrade event.
const upgradeHandler = app.getUpgradeHandler();
seedIfEmpty();
// Local stubbed runs only: STUB_POOL's numbers go into the pool.
if (stubsRequested()) {
  const { seedStubPool } = await import("./src/lib/telephony/pool");
  seedStubPool();
}
const reconciled = reconcileStaleCalls();
void warmGreetings();
// The video receptionist's shared PALs, made before the first visitor taps
// (lib/video/prewarm.ts). Skipped unless video is on and uses Tavus.
void import("./src/lib/video/prewarm")
  .then(({ prewarmAllowlistedVenues }) => prewarmAllowlistedVenues())
  .then((warmed) => {
    if (Object.keys(warmed).length) console.log(`[video] shared PALs at boot: ${JSON.stringify(warmed)}`);
  })
  .catch(() => undefined);
// Our own WhatsApp number, connected the moment its credentials exist. Logged
// either way, because "is Belle on WhatsApp yet?" should be answerable from
// the boot log without opening Meta's console.
void ensureOwnWhatsAppAccount().then((r) =>
  console.log(
    r.state === "connected"
      ? `[whatsapp] Belline's own number is connected: ${r.number}`
      : `[whatsapp] not connected — ${r.why}`,
  ),
);
// The Twilio sandbox, for trying Belle on WhatsApp before Meta is ready.
void ensureTwilioSandboxAccount().then((r) => {
  if (r.state === "connected") console.log(`[whatsapp] Twilio sandbox answering on ${r.number}`);
});

// Built at image time. Absent in a bare dev checkout, where the marketing
// pages are served by Next out of public/ instead.
const marketingReady = marketingSiteExists();

// Reminder texts, swept every five minutes. In this process rather than the
// sales worker because the bookings live in this process's store. Idempotent
// per booking, so a restart mid-sweep cannot text anybody twice.
const REMINDER_SWEEP_MS = 5 * 60 * 1000;
function sweepReminders(): void {
  void sendDueReminders()
    .then((r) => {
      if (r.sent || r.failed) console.log(`[reminders] ${r.sent} sent, ${r.failed} failed`);
    })
    .catch((err) => console.error("[reminders] sweep failed:", err));
}
setTimeout(sweepReminders, 30_000).unref?.();
setInterval(sweepReminders, REMINDER_SWEEP_MS).unref?.();

// Bookings whose change has not reached the venue's Google Calendar or Outlook
// yet — the calendar refused, timed out, or the process restarted mid-write —
// are tried again every few minutes, each on its own back-off. Idempotent by
// event key. The same sweep notices connections that never came back, venues
// refused because of our own Google project or Entra app that are accepted
// again, and keeps quiet Outlook connections from idling out.
const CALENDAR_SWEEP_MS = 3 * 60 * 1000;
async function sweepCalendars(): Promise<void> {
  const { sweepCalendars: sweep } = await import("./src/lib/integrations/calendar-sync");
  const r = await sweep();
  if (r.attempted || r.abandoned || r.recovered || r.refreshed) {
    console.log(`[calendar] sweep: ${r.abandoned} abandoned connects, ${r.recovered} venues recovered, ${r.refreshed} Outlook tokens refreshed; retried ${r.attempted}: ${r.synced} written, ${r.failed} failed (${r.waiting} waiting on a reconnect)`);
  }
}
setTimeout(() => void sweepCalendars().catch((err) => console.error("[calendar] sweep failed:", err)), 45_000).unref?.();
setInterval(() => void sweepCalendars().catch((err) => console.error("[calendar] sweep failed:", err)), CALENDAR_SWEEP_MS).unref?.();

// WhatsApp numbers waiting on Meta's display-name review, asked about every
// ten minutes. Only with self-serve WhatsApp on; the fake Graph under stubs.
const WHATSAPP_CHECK_MS = 10 * 60 * 1000;
async function checkWhatsAppNames(): Promise<void> {
  if (!flag("channel.whatsapp.selfserve")) return;
  const graph = flag("stubs") ? (await import("./src/lib/testing/stubs")).stubGraph().graph : graphClient();
  const r = await runWhatsAppChecks(graph);
  if (r.moved) console.log(`[whatsapp] name reviews: ${r.checked} checked, ${r.moved} moved on`);
}
setInterval(() => void checkWhatsAppNames().catch((err) => console.error("[whatsapp] name check failed:", err)), WHATSAPP_CHECK_MS).unref?.();

// Billing, once a day and shortly after boot: trials that reach their end while
// card payments are closed are extended once (billing/trial-end.ts), and usage
// alerts whose email did not go are tried again (billing/usage-policy.ts).
const BILLING_SWEEP_MS = 24 * 60 * 60 * 1000;
async function sweepBilling(): Promise<void> {
  const trials = sweepTrialEnds();
  const alerts = await retryPendingAlerts();
  if (trials.extended || trials.raised || alerts.sent || alerts.pending) {
    console.log(`[billing] trials ${trials.extended} extended, ${trials.raised} raised; alerts ${alerts.sent} sent, ${alerts.pending} still pending`);
  }
}
setTimeout(() => void sweepBilling().catch((err) => console.error("[billing] sweep failed:", err)), 60_000).unref?.();
setInterval(() => void sweepBilling().catch((err) => console.error("[billing] sweep failed:", err)), BILLING_SWEEP_MS).unref?.();

const server = createServer((req, res) => {
  // The socket address, for the signup rate limit when no proxy header is
  // present. Always overwritten, so a client cannot choose its own bucket.
  req.headers[PEER_HEADER] = req.socket.remoteAddress ?? "";
  // Staging and preview hosts: X-Robots-Tag on everything, and a robots.txt
  // that disallows it all. Production hosts pass through untouched.
  if (applyIndexing(req, res)) return;
  // The website and the product share this process, chosen by hostname. See
  // marketing.ts — anything that is not `app.` is the website, and a request
  // it does not recognise falls through to Next rather than 404ing.
  if (marketingReady && isMarketingHost(req.headers.host) && serveMarketing(req, res)) return;
  const parsed = parse(req.url ?? "/", true);
  // "View as customer" (lib/staff/view-as.ts): staff looking at a customer's
  // dashboard as its owner. Every request on such a session is decided here,
  // before Next: anything that is not a read is refused, and the reads run
  // with every store and database write refused too.
  const view = decideViewAs(sessionIdFromCookieHeader(req.headers.cookie), req.method, parsed.pathname ?? "/");
  if (view.kind === "expired") {
    res.writeHead(303, { Location: VIEW_AS_EXIT_PATH });
    res.end();
    return;
  }
  if (view.kind === "refuse") {
    res.writeHead(view.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: view.error, readOnly: true }));
    return;
  }
  if (view.kind === "read_only") {
    void runReadOnly(
      { reason: "viewing as a customer", staffUserId: view.grant.staffUserId, tenantId: view.grant.tenantId },
      () => handle(req, res, parsed),
    );
    return;
  }
  handle(req, res, parsed);
});

const browserWss = new WebSocketServer({ noServer: true });
const twilioWss = new WebSocketServer({ noServer: true });

/**
 * Keep the socket alive through a silence.
 *
 * A voice call is mostly one side listening, and while somebody is thinking
 * about what to ask, nothing crosses the wire in either direction. Every
 * proxy in front of this — Railway's included — closes an idle connection
 * after a minute or so, which the caller experiences as the line going dead
 * mid-conversation for no reason they can see.
 *
 * A ping every 25 seconds is well inside any of those timeouts. The pong also
 * gives us liveness: a browser that was closed without a clean handshake, or
 * a laptop that went to sleep, stops answering, and the socket is terminated
 * on the next sweep rather than being held open with a voice session and
 * three vendor connections attached to it.
 */
const HEARTBEAT_MS = 25_000;

type Alive = WebSocket & { isAlive?: boolean };

/**
 * Start watching one socket.
 *
 * Called from the upgrade handler, and it has to be — `wss.on("connection")`
 * does not fire on a `noServer` server driven by `handleUpgrade`, because the
 * callback *is* the connection. Registering the pong listener there meant it
 * was never registered at all: the first sweep pinged and marked the socket
 * not-alive, no pong was ever recorded, and the second sweep terminated it.
 *
 * Every call died at almost exactly fifty seconds, and the code that did it
 * was the code added to stop calls dying.
 */
function watch(ws: WebSocket): void {
  watchLiveness(ws as unknown as Liveness);
}

function keepAlive(wss: WebSocketServer): void {
  const sweep = setInterval(() => {
    sweepLiveness(wss.clients as unknown as Iterable<Liveness>);
  }, HEARTBEAT_MS);

  // Never hold the process open on this alone.
  sweep.unref?.();
  wss.on("close", () => clearInterval(sweep));
}

keepAlive(browserWss);
keepAlive(twilioWss);

server.on("upgrade", (req, socket, head) => {
  const { pathname, query } = parse(req.url ?? "/", true);

  if (pathname === "/ws/voice") {
    // The test console starts real, metered calls. Anyone who can open this
    // socket can spend money, so it needs the same session as the dashboard.
    const sessionId = sessionIdFromCookieHeader(req.headers.cookie);
    // A read-only view of a customer's dashboard never starts a call.
    if (isViewAsSession(sessionId)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const user = userForSession(sessionId);
    if (!user) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    // Bounded. Not billed — test calls never are — but a signup is a minute
    // and a call is eight, and nothing else stood between the two.
    const consoleLocationId = String(query.locationId ?? "");
    const consoleVenue = getLocation(consoleLocationId) ?? listLocations()[0];
    // Test calls are real model and speech spend: not before the owner's email
    // is confirmed, nor on a trial staff have paused (lib/abuse/gate.ts).
    if (paidWorkRefusal(user, consoleVenue)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (consoleVenue && canSeeLocation(user, consoleVenue.id) && !checkConsoleGate(consoleVenue).allowed) {
      socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    browserWss.handleUpgrade(req, socket, head, (ws) => {
      watch(ws);
      handleBrowser(ws, consoleLocationId, String(query.from ?? ""), user, "browser");
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

    // The predicate lives in lib/voice/entitlement.ts so it can be tested.
    // It has already been wrong twice.
    if (!location || !mayStreamTo(location)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    // Two kinds of venue arrive here and each has its own ceiling. A demo
    // line is ours and counts its calls as demos; a customer's widget counts
    // against the cap the customer set. The page checks the same gate before
    // it mints a token, but a token lives an hour and opens as many sockets as
    // anybody cares to open — so the check that holds is this one.
    const demo = Boolean(location.demo?.enabled);
    const gate = demo ? checkDemoGate(location) : checkEmbedGate(location);
    if (!gate.allowed) {
      socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    browserWss.handleUpgrade(req, socket, head, (ws) => {
      watch(ws);
      handleBrowser(ws, location.id, "", null, demo ? "browser" : "embed");
    });
    return;
  }

  if (pathname === "/ws/twilio") {
    twilioWss.handleUpgrade(req, socket, head, (ws) => {
      watch(ws);
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
  /** Which door: the venue's own console and our demos, or a customer's widget. */
  channel: "browser" | "embed",
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
  const call = startCall(
    location,
    channel,
    callerNumber ?? (channel === "embed" ? "website" : "browser-console"),
  );
  // A demo line's calls are demos whichever way they arrive. This was set only
  // on the telephone path, so the bell on our own front page — the door most
  // strangers use — never counted toward the demo cap at all.
  if (location.demo?.enabled && channel === "browser" && !user) {
    call.isDemo = true;
    saveCall(call);
  }
  const session = new VoiceSession(
    location,
    call,
    // No user means /ws/demo: a public socket, which never sees vendor error text.
    new BrowserTransport(ws, !user),
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
    console.error("[voice] browser session failed to start:", String(err));
    const event = { type: "error", message: String(err) };
    ws.send(JSON.stringify(user ? event : publicEvent(event)));
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
        // An archived venue answers nothing (lib/locations.ts); the token may
        // have been minted by the voice webhook just before it was archived.
        if (!location || location.archivedAt || !streamSid) {
          ws.close();
          return;
        }
        const call = startCall(location, "phone", params.from ?? "unknown", { callSid: params.callSid });
        if (location.demo?.enabled) {
          call.isDemo = true;
          saveCall(call);
        }
        session = new VoiceSession(
          location,
          call,
          new TwilioTransport(ws, streamSid, params.callSid ?? ""),
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
  // `includeInternal` matters: Belline's own venue is the one behind the bell
  // on the website, so it is the single most likely first call after a deploy
  // — and marking it internal quietly dropped it out of this loop.
  for (const location of listLocations({ includeInternal: true }).filter(
    (l) => l.demo?.enabled,
  )) {
    // Which voice is actually live is otherwise invisible from outside the
    // container — the store sits on a mounted disk, and "is it set to the
    // voice I picked?" is a question worth being able to answer from the logs.
    console.log(
      `[voice] ${location.name}: voice=${location.agent.voiceId} model=${
        location.agent.voiceModel ?? "default"
      } speed=${location.agent.voiceSpeed ?? "default"}`,
    );
    // Both formats. The cache key includes the format, so warming only
    // `ulaw_8000` left every *browser* call paying full text-to-speech
    // latency for the greeting — which is precisely the call the bell on the
    // website makes, and the first thing anybody hears of the product.
    //
    // `greetingClip` rather than building the arguments here: the cache key is
    // the text and the speed, and this used to compose both by hand. It asked
    // for the raw greeting at the configured pace while the session asks for
    // the `toSpoken` rewrite at a pace derived from it — so nothing ever hit,
    // and the logs cheerfully reported a warm cache either way.
    for (const format of ["ulaw_8000", "pcm_16000"] as const) {
      try {
        // Warming spends real characters. They belong to the venue, and to the
        // channel the format serves: μ-law is the phone, PCM the website.
        const onBilled = (chars: number, model: string) =>
          meterTts(
            { venueId: location.id, channel: format === "ulaw_8000" ? "phone" : "embed_voice" },
            chars,
            model,
          );
        const { text, ...voice } = greetingClip(location, greetingFor(location), format);
        await speakClip(text, { ...voice, onBilled });
        // And the "sure" / "okay" said while an answer is being worked out.
        // Cold, the first one arrives too late to be worth saying and is
        // dropped — which is safe, and is also silence on the first turn of
        // the first call after a deploy, the one turn this is all for.
        // In every language the business answers in: a call can settle on any of them.
        for (const clip of acknowledgementClips(location, format, allowedLanguages(location))) {
          const { text: line, ...params } = clip;
          await speakClip(line, { ...params, onBilled });
        }
      } catch {
        // Left cold on purpose; the first real call will fill it.
      }
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

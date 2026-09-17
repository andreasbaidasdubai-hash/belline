/**
 * The video receptionist (docs/video).
 *
 * A public, money-spending surface with a third party's key behind it, so most
 * of what is pinned here is about who can make it spend and what can leak:
 * the flag and the venue list, the provider contract against a fake Tavus,
 * one session per click, the end that always happens, a token that opens one
 * conversation at one venue and nothing else, and a key that never reaches a
 * browser. Then the behaviour a visitor meets — the panel's states, the
 * microphone refusal, the warning before the limit — and that the chat and
 * the bell are exactly what they were.
 *
 * No keys, no network, no database. The provider is the mock or a fake fetch.
 *
 *   npm run check:video
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-video-"));
delete process.env.DATABASE_URL;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.TAVUS_API_KEY;
const SENTINEL_KEY = "tvs_SENTINEL_never_in_a_response_91c2";

/** The environment a mock-mode run gets. Applied to process.env, restored after each test that changes it. */
const MOCK_ENV: Record<string, string> = {
  FLAG_VIDEO_AVATAR: "on",
  VIDEO_AVATAR_PROVIDER: "mock",
  FLAG_STUBS: "on",
  VIDEO_AVATAR_VENUES: "",
};

function setEnv(env: Record<string, string | undefined>): () => void {
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    before[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

setEnv(MOCK_ENV);

const { seedIfEmpty } = await import("../src/lib/seed");
const { getLocation, getCall, listCalls, listLeads, saveCall, upsertLocation } = await import("../src/lib/store");
const { enableEmbed, checkEmbedGate, widgetConfig } = await import("../src/lib/embed");
const { mayStreamTo } = await import("../src/lib/voice/entitlement");
const { signVisitorToken } = await import("../src/lib/auth");
const { flagState } = await import("../src/lib/flags");
const { staticPrompt, AI_DISCLOSURE } = await import("../src/lib/agent/prompt");
const { toolsFor } = await import("../src/lib/agent/tools");
const { startCall } = await import("../src/lib/calls");
const { billableVoiceMinutes } = await import("../src/lib/billing/usage");
const { videoConfig, missingVideoConfig } = await import("../src/lib/video/config");
const { videoAvailability, videoOffered } = await import("../src/lib/video/availability");
const { setKillSwitch, setVenueVideo, readVideoControl } = await import("../src/lib/video/control");
const { signVideoToken, verifyVideoToken, tokenFromSystemMessages } = await import("../src/lib/video/tokens");
const { TavusProvider } = await import("../src/lib/video/tavus");
const { MockVideoProvider, mockVideoRecord, resetMockVideo, failNextMockSessions } = await import("../src/lib/video/mock");
const { videoProvider, setVideoProviderForTests } = await import("../src/lib/video/provider");
const sessions = await import("../src/lib/video/sessions");
const { handleChatCompletions, guardVideoClause } = await import("../src/lib/video/engine");
const { clearVideoMetrics, recentVideoMetrics } = await import("../src/lib/video/metrics");
const machine = await import("../src/lib/video/client/machine");
const configRoute = await import("../src/app/api/embed/[key]/config/route");
const sessionRoute = await import("../src/app/api/video/[key]/session/route");
const endRoute = await import("../src/app/api/video/[key]/session/end/route");
const handoverRoute = await import("../src/app/api/video/[key]/session/handover/route");
const eventRoute = await import("../src/app/api/video/[key]/event/route");
const mockRoute = await import("../src/app/api/video/[key]/mock/route");
const webhookRoute = await import("../src/app/api/video/webhook/[provider]/route");
const llmRoute = await import("../src/app/api/video/llm/chat/completions/route");

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${(err instanceof Error ? err.stack ?? err.message : String(err)).split("\n").slice(0, 5).join("\n      ")}`);
    failed++;
  } finally {
    sessions.clearVideoSessions();
    resetMockVideo();
    setVideoProviderForTests(null);
  }
}

// ---------------------------------------------------------------------------
// Fixtures

seedIfEmpty();
const A = enableEmbed(getLocation("loc_azure")!, ["https://azure.example"]);
const B = enableEmbed(getLocation("loc_lumiere")!, ["https://lumiere.example"]);
const OFF = enableEmbed(getLocation("loc_meridian")!, ["https://meridian.example"]);
setVenueVideo(A.id, true, "check");
setVenueVideo(B.id, true, "check");

const params = (key: string) => ({ params: Promise.resolve({ key }) });
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

async function startViaRoute(location: typeof A, visitorId = `v${Math.random().toString(36).slice(2, 10)}`) {
  const token = signVisitorToken(location.id, visitorId);
  const res = await sessionRoute.POST(post(`http://localhost/api/video/${location.embed!.key}/session`, { token }), params(location.embed!.key));
  return { res, json: (await res.json()) as Record<string, any>, token, visitorId };
}

async function sse(res: Response): Promise<{ text: string; frames: any[]; done: boolean; raw: string }> {
  const raw = await res.text();
  const frames: any[] = [];
  let done = false;
  for (const block of raw.split("\n\n")) {
    const line = block.trim();
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") done = true;
    else frames.push(JSON.parse(data));
  }
  return { text: frames.map((f) => f.choices?.[0]?.delta?.content ?? "").join(""), frames, done, raw };
}

function llmRequest(token: string, userText: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return post(
    "http://localhost/api/video/llm/chat/completions",
    { model: "belline-receptionist", stream: true, messages: [{ role: "system", content: "You are Belle." }, { role: "user", content: userText }], ...extra },
    { authorization: `Bearer ${token}`, ...headers },
  );
}

/** A fake Tavus: records every request and answers from a script. */
function fakeTavus(respond: (method: string, url: string, body: any) => { status: number; body?: unknown } = () => ({ status: 200 })) {
  const calls: { method: string; url: string; headers: Record<string, string>; body: any }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, headers: init?.headers as Record<string, string>, body });
    const out = respond(method, url, body);
    return new Response(out.body === undefined ? "" : JSON.stringify(out.body), { status: out.status });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const TAVUS_ENV = {
  VIDEO_AVATAR_PROVIDER: "tavus",
  TAVUS_API_KEY: SENTINEL_KEY,
  TAVUS_FACE_ID: "rf90eb925bd8",
  TAVUS_PAL_ID: "p_template",
  VIDEO_LLM_SECRET: "check-video-secret",
  VIDEO_PUBLIC_ORIGIN: "https://app.example",
};

function tavusHappyPath(method: string, url: string) {
  if (method === "GET" && url.includes("/v2/pals/p_template")) return { status: 200, body: { layers: { tts: { voice_id: "v1" }, llm: { model: "x" } } } };
  if (method === "POST" && url.endsWith("/v2/pals")) return { status: 200, body: { pal_id: "p_session_1" } };
  if (method === "POST" && url.endsWith("/v2/conversations"))
    return { status: 200, body: { conversation_id: "c_123", conversation_url: "https://tavus.daily.co/c_123", status: "active", meeting_token: "mt_abc" } };
  return { status: 200, body: {} };
}

console.log("\nVideo receptionist\n");

// ---------------------------------------------------------------------------
console.log("  Flag, list and configuration");

await test("1. the flag off hides video: needs an explicit switch, the widget config says false, nothing starts", async () => {
  const restore = setEnv({ FLAG_VIDEO_AVATAR: undefined, FLAG_STUBS: undefined });
  try {
    assert.equal(flagState("video.avatar", {}).on, false);
    assert.equal(flagState("video.avatar", {}).reason, "missing_credentials");
    assert.equal(flagState("video.avatar", { VIDEO_AVATAR_PROVIDER: "mock" }).reason, "needs_approval");
    assert.equal(flagState("video.avatar", { VIDEO_AVATAR_PROVIDER: "mock", FLAG_VIDEO_AVATAR: "off" }).reason, "disabled");
    assert.equal(videoOffered(A), false);
    const res = await configRoute.GET(new Request("http://localhost/"), params(A.embed!.key));
    assert.equal(((await res.json()) as { video?: boolean }).video, false);
    const { res: start, json } = await startViaRoute(A);
    assert.equal(start.status, 403);
    assert.equal(json.error, "flag_off");
    assert.equal(mockVideoRecord().created.length, 0);
  } finally {
    restore();
  }
});

await test("2. enabled shows it — only on listed venues, and the kill switch hides it again", async () => {
  const res = await configRoute.GET(new Request("http://localhost/"), params(A.embed!.key));
  const cfg = (await res.json()) as { video?: boolean; mode?: string };
  assert.equal(cfg.video, true);
  assert.equal(cfg.mode, "both", "the widget's own mode is untouched");
  assert.equal(videoOffered(OFF), false, "a venue not on the list");
  assert.equal(videoAvailability(OFF).on ? "" : (videoAvailability(OFF) as { reason: string }).reason, "not_allowlisted");
  assert.equal(videoOffered({ ...A, embed: { ...A.embed!, enabled: false } }), false, "widget off");
  setKillSwitch(true, "check");
  try {
    assert.equal(videoOffered(A), false);
    const { res: start, json } = await startViaRoute(A);
    assert.equal(start.status, 403);
    assert.equal(json.error, "killed");
  } finally {
    setKillSwitch(false, "check");
  }
  // The environment's list works too, and a console "remove" beats it.
  const restore = setEnv({ VIDEO_AVATAR_VENUES: OFF.id });
  try {
    assert.equal(videoOffered(OFF), true);
    setVenueVideo(OFF.id, false, "check");
    assert.equal(videoOffered(OFF), false);
  } finally {
    restore();
  }
});

await test("3. missing configuration fails gracefully: names only, a readable refusal with fallbacks, never a 500", async () => {
  const restore = setEnv({ VIDEO_AVATAR_PROVIDER: "tavus", FLAG_STUBS: undefined, TAVUS_API_KEY: undefined, TAVUS_FACE_ID: undefined, VIDEO_LLM_SECRET: undefined });
  try {
    const state = flagState("video.avatar");
    assert.equal(state.on, false);
    assert.deepEqual(state.missing, ["TAVUS_API_KEY", "TAVUS_FACE_ID", "VIDEO_LLM_SECRET"]);
    const { res, json } = await startViaRoute(A);
    assert.equal(res.status, 403);
    assert.deepEqual(json.fallback, { chat: true, voice: true });
    assert.equal(JSON.stringify(json).includes("TAVUS"), false, "the visitor is not told which variable is missing");
  } finally {
    restore();
  }
  // Under the stubs the flag ignores credentials, and the provider check still holds.
  const stubbed = setEnv({ VIDEO_AVATAR_PROVIDER: "tavus", TAVUS_API_KEY: undefined });
  try {
    const availability = videoAvailability(A);
    assert.equal(availability.on, false);
    assert.equal((availability as { reason: string }).reason, "not_configured");
    assert.ok(missingVideoConfig(videoConfig()).includes("TAVUS_API_KEY"));
  } finally {
    stubbed();
  }
  // The mock is refused in production and next to a real database.
  assert.equal(flagState("video.avatar", { VIDEO_AVATAR_PROVIDER: "mock", FLAG_VIDEO_AVATAR: "on", NODE_ENV: "production" }).reason, "unsafe");
  assert.equal(
    flagState("video.avatar", { VIDEO_AVATAR_PROVIDER: "mock", FLAG_VIDEO_AVATAR: "on", DATABASE_URL: "postgres://u:p@db.example.com/x" }).reason,
    "unsafe",
  );
  assert.throws(() => new MockVideoProvider({ NODE_ENV: "production" }), /refused/);
  assert.equal(videoProvider({ VIDEO_AVATAR_PROVIDER: "mock", NODE_ENV: "production" }), null);
});

// ---------------------------------------------------------------------------
console.log("\n  Sessions against the provider contract");

await test("4. session creation with a mocked Tavus: documented fields only, a PAL per session, no key to the browser", async () => {
  const env = { ...process.env, ...TAVUS_ENV };
  const fake = fakeTavus(tavusHappyPath);
  const provider = new TavusProvider(videoConfig(env), fake.fetchImpl);
  const restore = setEnv({ ...TAVUS_ENV, FLAG_STUBS: undefined });
  try {
    const result = await sessions.startVideoSession(getLocation(A.id)!, "visitor-4", { provider });
    assert.ok(result.ok, result.ok ? "" : result.reason);
    if (!result.ok) return;

    const [template, pal, conversation] = fake.calls;
    assert.equal(template.method, "GET");
    assert.equal(pal.url, "https://tavusapi.com/v2/pals");
    assert.equal(pal.headers["x-api-key"], SENTINEL_KEY);
    assert.equal(pal.body.default_face_id, "rf90eb925bd8");
    assert.equal(pal.body.layers.llm.base_url, "https://app.example/api/video/llm");
    assert.equal(pal.body.layers.llm.speculative_inference, false);
    assert.equal(pal.body.layers.perception.perception_model, "off");
    assert.deepEqual(pal.body.layers.tts, { voice_id: "v1" }, "the owner's voice carries over");
    assert.equal(pal.body.layers.llm.model, "belline-receptionist", "the template's own model does not");
    const claim = verifyVideoToken(pal.body.layers.llm.api_key, "llm");
    assert.equal(claim?.sessionId, result.session.id);
    assert.equal(claim?.locationId, A.id);

    assert.equal(conversation.url, "https://tavusapi.com/v2/conversations");
    assert.equal(conversation.body.face_id, "rf90eb925bd8");
    assert.equal(conversation.body.pal_id, "p_session_1");
    assert.equal(conversation.body.require_auth, true);
    assert.equal(conversation.body.properties.enable_recording, false);
    assert.equal(conversation.body.properties.max_call_duration, 300);
    assert.deepEqual(conversation.body.properties.languages, ["en"]);
    assert.match(conversation.body.custom_greeting, /^Hi, I'm Aria, the AI concierge for .+\. How may I help you today\?$|^Hi, I'm .+, the AI concierge for .+\. How may I help you today\?$/);
    assert.match(conversation.body.callback_url, /^https:\/\/app\.example\/api\/video\/webhook\/tavus\?t=bvt1\.webhook\./);
    assert.equal(JSON.stringify(conversation.body.conversational_context).includes("bvt1"), false, "per-session mode puts no token in the context");
    assert.equal(conversation.body.conversation_name.includes(A.name), false, "an id, not the venue, in Tavus's dashboard");

    const client = result.client;
    assert.equal(client.roomUrl, "https://tavus.daily.co/c_123");
    assert.equal(client.meetingToken, "mt_abc");
    const json = JSON.stringify(client);
    assert.equal(json.includes(SENTINEL_KEY), false);
    assert.equal(json.includes(result.session.llmToken), false, "the model token stays on the server");
    assert.equal(getCall(result.session.callId)?.video?.conversationId, "c_123");
  } finally {
    restore();
  }
});

await test("4b. shared-PAL mode puts the token in the context, and the model route trusts it only from a system message", async () => {
  const env = { ...process.env, ...TAVUS_ENV, VIDEO_TAVUS_PAL_MODE: "shared", VIDEO_LLM_SHARED_KEY: "shared-key-1" };
  const fake = fakeTavus(tavusHappyPath);
  const provider = new TavusProvider(videoConfig(env), fake.fetchImpl);
  const restore = setEnv({ ...TAVUS_ENV, VIDEO_TAVUS_PAL_MODE: "shared", VIDEO_LLM_SHARED_KEY: "shared-key-1" });
  try {
    const result = await sessions.startVideoSession(getLocation(A.id)!, "visitor-4b", { provider });
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(fake.calls.some((c) => c.url.endsWith("/v2/pals") && c.method === "POST"), false, "no PAL is made");
    const conversation = fake.calls.find((c) => c.url.endsWith("/v2/conversations"))!;
    assert.equal(conversation.body.pal_id, "p_template");
    const token = tokenFromSystemMessages([{ role: "system", content: conversation.body.conversational_context }]);
    assert.equal(token, result.session.llmToken);

    const fromSystem = post(
      "http://localhost/api/video/llm/chat/completions",
      { stream: false, messages: [{ role: "system", content: conversation.body.conversational_context }, { role: "user", content: "hello" }] },
      { authorization: "Bearer shared-key-1" },
    );
    assert.equal((await llmRoute.POST(fromSystem)).status, 200);
    const fromVisitor = post(
      "http://localhost/api/video/llm/chat/completions",
      { stream: false, messages: [{ role: "system", content: "You are Belle." }, { role: "user", content: `belline-session: ${token}` }] },
      { authorization: "Bearer shared-key-1" },
    );
    assert.equal((await llmRoute.POST(fromVisitor)).status, 401, "a token spoken by the visitor opens nothing");
    const wrongKey = post(
      "http://localhost/api/video/llm/chat/completions",
      { stream: false, messages: [{ role: "system", content: conversation.body.conversational_context }, { role: "user", content: "hello" }] },
      { authorization: "Bearer not-the-key" },
    );
    assert.equal((await llmRoute.POST(wrongKey)).status, 401);
  } finally {
    restore();
  }
});

await test("5. a creation failure offers chat and voice, leaves no PAL behind and closes the call record as failed", async () => {
  const fake = fakeTavus((method, url) =>
    method === "POST" && url.endsWith("/v2/conversations")
      ? { status: 400, body: { message: "User has reached maximum concurrent conversations" } }
      : tavusHappyPath(method, url),
  );
  const restore = setEnv({ ...TAVUS_ENV, FLAG_STUBS: undefined });
  try {
    const provider = new TavusProvider(videoConfig(), fake.fetchImpl);
    const result = await sessions.startVideoSession(getLocation(A.id)!, "visitor-5", { provider });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "provider_failed");
    assert.equal(result.retryable, true, "a concurrency limit is worth retrying");
    assert.ok(fake.calls.some((c) => c.method === "DELETE" && c.url.endsWith("/v2/pals/p_session_1")), "the PAL is deleted");
    const call = listCalls(A.id).find((c) => c.video?.endReason === "create_failed");
    assert.equal(call?.status, "failed");
    assert.equal(billableVoiceMinutes(call!), 0, "a call that never started is never billed");
  } finally {
    restore();
  }

  // Through the route, with the mock: the panel gets the fallbacks.
  failNextMockSessions(1);
  const { res, json } = await startViaRoute(A);
  assert.equal(res.status, 502);
  assert.equal(json.error, "provider_failed");
  assert.deepEqual(json.fallback, { chat: true, voice: true });
  // And the panel turns that into an error with both ways out.
  const code = machine.startErrorCode(res.status, json.error);
  const state = machine.reduce(machine.reduce(machine.reduce(machine.INITIAL, { type: "start" }), { type: "mic_granted" }), { type: "fail", code, retryable: json.retryable });
  assert.equal(state.phase, "error");
  assert.equal(machine.errorCopy(code, "Belle"), "The video call couldn't start.");
});

await test("6. a double click creates one session — concurrent and repeated starts share it", async () => {
  const location = getLocation(A.id)!;
  const [first, second] = await Promise.all([
    sessions.startVideoSession(location, "visitor-6"),
    sessions.startVideoSession(location, "visitor-6"),
  ]);
  assert.ok(first.ok && second.ok);
  if (!first.ok || !second.ok) return;
  assert.equal(first.session.id, second.session.id);
  const third = await sessions.startVideoSession(location, "visitor-6");
  assert.ok(third.ok && third.session.id === first.session.id && third.reused);
  assert.equal(mockVideoRecord().created.length, 1, "the provider made one room");

  // The panel's own lock.
  let runs = 0;
  const start = machine.once(async () => {
    runs++;
    await new Promise((r) => setTimeout(r, 20));
  });
  await Promise.all([start(), start(), start()]);
  assert.equal(runs, 1);
  // A second press while starting changes nothing.
  const starting = machine.reduce(machine.INITIAL, { type: "start" });
  assert.equal(machine.reduce(starting, { type: "start" }), starting);

  // And a venue has a ceiling on concurrent rooms.
  const other = await sessions.startVideoSession(location, "visitor-6b");
  assert.ok(other.ok);
  const third3 = await sessions.startVideoSession(location, "visitor-6c");
  assert.equal(third3.ok, false);
  assert.equal(!third3.ok && third3.reason, "busy");
});

await test("7. end cleans up on both sides, once: provider told, PAL deleted, call closed and metered, later ends are no-ops", async () => {
  const fake = fakeTavus(tavusHappyPath);
  const restore = setEnv({ ...TAVUS_ENV, FLAG_STUBS: undefined });
  try {
    const provider = new TavusProvider(videoConfig(), fake.fetchImpl);
    setVideoProviderForTests(provider);
    const result = await sessions.startVideoSession(getLocation(A.id)!, "visitor-7", { provider });
    assert.ok(result.ok);
    if (!result.ok) return;
    const { session, client } = result;
    // Through the route, as the panel's End button and the unload beacon do.
    const endReq = new Request(`http://localhost/api/video/${A.embed!.key}/session/end`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ sessionId: client.sessionId, clientToken: client.clientToken, reason: "unload" }),
    });
    const res = await endRoute.POST(endReq, params(A.embed!.key));
    assert.deepEqual(await res.json(), { ok: true, ended: true });
    assert.ok(fake.calls.some((c) => c.method === "POST" && c.url.endsWith("/v2/conversations/c_123/end")));
    assert.ok(fake.calls.some((c) => c.method === "DELETE" && c.url.endsWith("/v2/pals/p_session_1")));
    assert.equal(session.timers.length, 0, "no timer left to fire");
    const call = getCall(session.callId)!;
    assert.equal(call.status, "completed");
    assert.equal(call.video?.endReason, "client_unload");
    assert.equal(await sessions.endVideoSession(session.id, "again", { by: "visitor" }), false);
    const ends = fake.calls.filter((c) => c.url.endsWith("/end")).length;
    assert.equal(ends, 1, "the provider is told once");
  } finally {
    restore();
  }

  // The panel side: leaving stops the call adapter for good.
  const ended = machine.reduce({ ...machine.INITIAL, phase: "live", joinedAt: 1 }, { type: "ended", reason: "visitor" });
  assert.equal(ended.phase, "ended");
  assert.equal(machine.reduce(ended, { type: "call", event: { type: "speaking", who: "agent", on: true }, now: 2 }).agentSpeaking, false);
  const panel = read("src/app/embed/[key]/video/VideoPanel.tsx");
  assert.match(panel, /micRef\.current\?\.stop\(\)/, "the microphone track is stopped");
  assert.match(panel, /navigator\.sendBeacon/, "unload ends the session by beacon");
  assert.match(panel, /addEventListener\("pagehide"/);
  const calls = read("src/lib/video/client/calls.ts");
  assert.match(calls, /call\.leave\(\)/);
  assert.match(calls, /call\.destroy\(\)/);
});

await test("7b. the provider's shutdown callback ends the session; its token only counts for its own conversation", async () => {
  const location = getLocation(A.id)!;
  const result = await sessions.startVideoSession(location, "visitor-7b");
  assert.ok(result.ok);
  if (!result.ok) return;
  const { session } = result;
  const other = await sessions.startVideoSession(getLocation(B.id)!, "visitor-7b-b");
  assert.ok(other.ok);
  if (!other.ok) return;

  const t = signVideoToken("webhook", session.id, location.id, 600);
  const hook = (token: string, body: unknown) =>
    webhookRoute.POST(post(`http://localhost/api/video/webhook/mock?t=${encodeURIComponent(token)}`, body), {
      params: Promise.resolve({ provider: "mock" }),
    });

  assert.equal((await hook("nonsense", { conversation_id: session.conversationId, event_type: "system.shutdown" })).status, 401);
  const llmToken = signVideoToken("llm", session.id, location.id, 600);
  assert.equal((await hook(llmToken, { conversation_id: session.conversationId, event_type: "system.shutdown" })).status, 401, "an llm token is not a webhook token");
  const mismatch = await hook(t, { conversation_id: other.session.conversationId, event_type: "system.shutdown", properties: { shutdown_reason: "x" } });
  assert.equal(mismatch.status, 403, "another venue's conversation");
  assert.equal(other.session.status, "live");

  const joined = await hook(t, { conversation_id: session.conversationId, event_type: "system.replica_joined", message_type: "system" });
  assert.equal(((await joined.json()) as { event: string }).event, "joined");
  assert.ok(session.joinedAt);
  const shut = await hook(t, {
    conversation_id: session.conversationId,
    event_type: "system.shutdown",
    message_type: "system",
    properties: { shutdown_reason: "max_call_duration reached" },
  });
  assert.equal(shut.status, 200);
  assert.equal(session.status, "ended");
  assert.equal(getCall(session.callId)?.video?.endReason, "max_call_duration reached");
});

// ---------------------------------------------------------------------------
console.log("\n  What the visitor meets");

await test("8. a refused microphone is explained, with the chat offered, and no session is created", () => {
  for (const name of ["NotAllowedError", "SecurityError"]) {
    assert.equal(machine.micErrorCode({ name }), "mic_denied");
  }
  assert.equal(machine.micErrorCode({ name: "NotFoundError" }), "mic_missing");
  const state = machine.reduce(machine.reduce(machine.INITIAL, { type: "start" }), { type: "fail", code: "mic_denied", retryable: false });
  assert.equal(state.phase, "error");
  assert.equal(machine.statusText(state, "Belle"), "Couldn't connect");
  const copy = machine.errorCopy("mic_denied", "Belle");
  assert.match(copy, /microphone is blocked/);
  assert.match(copy, /allow the microphone for this site/);
  assert.match(copy, /chat instead/i);
  const panel = read("src/app/embed/[key]/video/VideoPanel.tsx");
  // The session request comes after the microphone, never before.
  assert.ok(panel.indexOf("getUserMedia") < panel.indexOf("/session`, {"), "the microphone is asked for before any session exists");
  assert.equal(/facingMode|video:\s*true/.test(panel), false, "the camera is never requested");
  assert.match(panel, /video: false/);
});

await test("9. the duration: a warning shortly before the end, then a clean end on both sides", async () => {
  const d = (s: number) => machine.durationView(1_000, 1_000 + s * 1000, 300, 30);
  assert.equal(d(10).phase, "normal");
  assert.equal(d(270).phase, "warning");
  assert.equal(d(300).phase, "over");
  assert.equal(machine.clock(d(285).remaining), "0:15");
  const live = { ...machine.INITIAL, phase: "live" as const, joinedAt: 1 };
  assert.equal(machine.reduce(live, { type: "warn" }).warned, true);
  assert.equal(videoConfig({ VIDEO_MAX_CALL_SECONDS: "5", VIDEO_WARN_BEFORE_SECONDS: "99" }).maxCallSeconds, 30, "a floor on the maximum");
  assert.equal(videoConfig({ VIDEO_MAX_CALL_SECONDS: "60", VIDEO_WARN_BEFORE_SECONDS: "99" }).warnBeforeSeconds, 30, "the warning is never most of the call");

  // The server's own backstop ends the session a few seconds after the maximum,
  // and ends a room nobody ever joined.
  // No artificial latency, so the session starts inside the mocked clock.
  const instant = new MockVideoProvider();
  instant.createSession = async (input) => ({ conversationId: `c_${input.sessionId}`, roomUrl: "mock://belline-video/x" });
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const location = getLocation(A.id)!;
    const result = await sessions.startVideoSession(location, "visitor-9", { provider: instant });
    assert.ok(result.ok);
    if (!result.ok) return;
    sessions.markVideoJoined(result.session);
    mock.timers.tick(299_000);
    assert.equal(result.session.status, "live");
    mock.timers.tick(10_000);
    await new Promise((r) => setImmediate(r));
    assert.equal(result.session.status, "ended");
    assert.equal(getCall(result.session.callId)?.video?.endReason, "max_duration");

    const idle = await sessions.startVideoSession(location, "visitor-9b", { provider: instant });
    assert.ok(idle.ok);
    if (!idle.ok) return;
    mock.timers.tick(61_000);
    await new Promise((r) => setImmediate(r));
    assert.equal(idle.session.status, "ended");
    assert.equal(getCall(idle.session.callId)?.video?.endReason, "never_joined");
  } finally {
    mock.timers.reset();
  }
});

// ---------------------------------------------------------------------------
console.log("\n  Tenancy and secrets");

await test("10. tenant isolation: tokens open one conversation at one venue, on every door", async () => {
  const a = await startViaRoute(A);
  const b = await startViaRoute(B);
  assert.equal(a.res.status, 200);
  assert.equal(b.res.status, 200);
  const sa = sessions.getVideoSession(a.json.session.sessionId)!;
  const sb = sessions.getVideoSession(b.json.session.sessionId)!;

  // A visitor token for A cannot start a session on B's widget.
  const cross = await sessionRoute.POST(post(`http://localhost/api/video/${B.embed!.key}/session`, { token: a.token }), params(B.embed!.key));
  assert.equal(cross.status, 403);

  // A's client token does not end, hand over or report on B.
  const endB = await endRoute.POST(
    post(`http://localhost/api/video/${B.embed!.key}/session/end`, { sessionId: sb.id, clientToken: sa.clientToken }),
    params(B.embed!.key),
  );
  assert.equal(endB.status, 401);
  const endAonB = await endRoute.POST(
    post(`http://localhost/api/video/${B.embed!.key}/session/end`, { sessionId: sa.id, clientToken: sa.clientToken }),
    params(B.embed!.key),
  );
  assert.equal(endAonB.status, 401, "A's own session through B's key");
  assert.equal(sa.status, "live");
  assert.equal(sb.status, "live");

  // The model route: A's token answers as A.
  const ok = await llmRoute.POST(llmRequest(sa.llmToken, "Hello there"));
  assert.equal(ok.status, 200);
  assert.match((await sse(ok)).text, new RegExp(A.name));

  // A's token edited to name B's venue, or B's session, is refused.
  const parts = sa.llmToken.split(".");
  const forgedVenue = [...parts.slice(0, 3), B.id, ...parts.slice(4)].join(".");
  assert.equal((await llmRoute.POST(llmRequest(forgedVenue, "Hello"))).status, 401);
  const forgedSession = [parts[0], parts[1], sb.id, ...parts.slice(3)].join(".");
  assert.equal((await llmRoute.POST(llmRequest(forgedSession, "Hello"))).status, 401);
  // A token signed with another secret.
  const foreign = signVideoToken("llm", sb.id, B.id, 600, { VIDEO_LLM_SECRET: "someone-else" });
  assert.equal((await llmRoute.POST(llmRequest(foreign, "Hello"))).status, 401);
  // A client or webhook token is not a model token.
  assert.equal((await llmRoute.POST(llmRequest(sa.clientToken, "Hello"))).status, 401);
  // A validly signed token whose session belongs to another venue.
  const mixed = signVideoToken("llm", sb.id, A.id, 600);
  assert.equal((await llmRoute.POST(llmRequest(mixed, "Hello"))).status, 403);
  // No credential, or an ended conversation.
  assert.equal((await llmRoute.POST(llmRequest("", "Hello"))).status, 401);
  await sessions.endVideoSession(sb.id, "done", { by: "visitor" });
  assert.equal((await llmRoute.POST(llmRequest(sb.llmToken, "Hello"))).status, 410);

  // B's transcript holds none of A's words.
  assert.equal(getCall(sb.callId)!.transcript.some((t) => t.text.includes("Hello there")), false);
  assert.ok(getCall(sa.callId)!.transcript.some((t) => t.text === "Hello there"));
});

await test("11. the provider key never reaches a response or a client bundle", async () => {
  const restore = setEnv({ TAVUS_API_KEY: SENTINEL_KEY, TAVUS_FACE_ID: "rf90eb925bd8", VIDEO_LLM_SECRET: "check-video-secret" });
  const bodies: string[] = [];
  try {
    const started = await startViaRoute(A);
    bodies.push(JSON.stringify(started.json));
    const s = started.json.session;
    bodies.push(await (await configRoute.GET(new Request("http://localhost/"), params(A.embed!.key))).text());
    bodies.push(
      await (await eventRoute.POST(post("http://x/", { name: "ready", ms: 1200, sessionId: s.sessionId, clientToken: s.clientToken }), params(A.embed!.key))).text(),
    );
    bodies.push(
      await (await handoverRoute.POST(post("http://x/", { sessionId: s.sessionId, clientToken: s.clientToken }), params(A.embed!.key))).text(),
    );
    const relay = await mockRoute.POST(post("http://localhost/", { sessionId: s.sessionId, clientToken: s.clientToken, text: "What are your hours?" }), params(A.embed!.key));
    bodies.push((await sse(relay)).raw);
    bodies.push(await (await endRoute.POST(post("http://x/", { sessionId: s.sessionId, clientToken: s.clientToken }), params(A.embed!.key))).text());
    const session = sessions.getVideoSession(s.sessionId)!;
    for (const body of bodies) {
      assert.equal(body.includes(SENTINEL_KEY), false, `key in: ${body.slice(0, 120)}`);
      assert.equal(body.includes(session.llmToken), false, "the model token in a response");
      assert.equal(body.includes("check-video-secret"), false);
    }
  } finally {
    restore();
  }

  // Client source never reads the environment or names the provider's API.
  for (const file of ["src/app/embed/[key]/video/VideoPanel.tsx", "src/lib/video/client/machine.ts", "src/lib/video/client/calls.ts", "public/embed.js", "public/site.js"]) {
    const source = read(file);
    assert.equal(/process\.env|TAVUS_API_KEY|x-api-key|tavusapi\.com|VIDEO_LLM_SECRET/.test(source), false, file);
  }
  // Built bundles, when a build exists.
  const staticDir = path.join(ROOT, ".next", "static");
  if (fs.existsSync(staticDir)) {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(js|mjs|json|map)$/.test(entry.name)) {
          const text = fs.readFileSync(full, "utf8");
          if (/TAVUS_API_KEY|tavusapi\.com|VIDEO_LLM_SECRET|x-api-key/.test(text)) offenders.push(path.relative(ROOT, full));
          if (process.env.TAVUS_API_KEY_REAL_FOR_SCAN && text.includes(process.env.TAVUS_API_KEY_REAL_FOR_SCAN)) offenders.push(path.relative(ROOT, full));
        }
      }
    };
    walk(staticDir);
    assert.deepEqual(offenders, [], "provider secrets or endpoints in the client bundle");
    console.log("      (scanned .next/static)");
  } else {
    console.log("      (no .next/static to scan — run next build first for the bundle half)");
  }
});

// ---------------------------------------------------------------------------
console.log("\n  The receptionist behind the face");

await test("the model route streams OpenAI chat-completion chunks, and answers non-streamed requests too", async () => {
  const started = await sessions.startVideoSession(getLocation(A.id)!, "visitor-sse");
  assert.ok(started.ok);
  if (!started.ok) return;
  const res = await llmRoute.POST(llmRequest(started.session.llmToken, "Hi"));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^text\/event-stream/);
  const { frames, done, text } = await sse(res);
  assert.ok(done, "ends with [DONE]");
  assert.equal(frames[0].object, "chat.completion.chunk");
  assert.equal(frames[0].choices[0].delta.role, "assistant");
  assert.equal(frames.at(-1).choices[0].finish_reason, "stop");
  assert.ok(frames.every((f) => f.id === frames[0].id), "one id per completion");
  assert.ok(text.trim().length > 0);

  const plain = await llmRoute.POST(llmRequest(started.session.llmToken, "Hi again", { stream: false }));
  const body = (await plain.json()) as { object: string; choices: { message: { role: string; content: string } }[] };
  assert.equal(body.object, "chat.completion");
  assert.equal(body.choices[0].message.role, "assistant");
  assert.ok(recentVideoMetrics().some((m) => m.name === "llm_first_token" && typeof m.ms === "number"), "time to first token is measured");
});

await test("a lead taken on a video call lands in the store, through the model route (mock relay)", async () => {
  const belline = getLocation("loc_belline")!;
  setVenueVideo(belline.id, true, "check");
  try {
    const started = await startViaRoute(belline);
    assert.equal(started.res.status, 200, JSON.stringify(started.json));
    const s = started.json.session;
    const before = listLeads().length;
    const relay = await mockRoute.POST(
      post("http://localhost/", { sessionId: s.sessionId, clientToken: s.clientToken, text: "My name is Dana Reed, I run a salon called Glow Studio, email dana@glow.example" }),
      params(belline.embed!.key),
    );
    const { text } = await sse(relay);
    assert.match(text, /Glow Studio/);
    const leads = listLeads();
    assert.equal(leads.length, before + 1);
    assert.equal(leads.find((l) => l.email === "dana@glow.example")?.name, "Dana Reed");
    const session = sessions.getVideoSession(s.sessionId)!;
    assert.ok(getCall(session.callId)!.toolCalls.some((t) => t.name === "record_lead"));
    assert.ok(recentVideoMetrics().some((m) => m.name === "booking_or_lead" && m.detail === "record_lead"));
  } finally {
    setVenueVideo(belline.id, false, "check");
  }
});

await test("a message for the team, and the Talk-to-a-person button, reach the Action Inbox the existing way", async () => {
  const started = await startViaRoute(A);
  const s = started.json.session;
  const hand = await handoverRoute.POST(post("http://x/", { sessionId: s.sessionId, clientToken: s.clientToken }), params(A.embed!.key));
  const said = (await hand.json()) as { say: string };
  assert.match(said.say, /person/);
  const session = sessions.getVideoSession(s.sessionId)!;
  assert.match(getCall(session.callId)!.escalation ?? "", /person/);
  const relay = await mockRoute.POST(post("http://localhost/", { sessionId: s.sessionId, clientToken: s.clientToken, text: said.say + " My name is Sam Lee, 050 123 4567" }), params(A.embed!.key));
  await sse(relay);
  assert.ok(getCall(session.callId)!.toolCalls.some((t) => t.name === "take_message"));
});

await test("the honesty guard repairs an invented time before it is spoken; authority rules answer before the model", async () => {
  const location = getLocation(A.id)!;
  const call = { toolCalls: [] };
  const repaired = guardVideoClause(location, "I have a table at 9:15 PM tonight.", call, "Do you have anything tonight?");
  assert.equal(/9:15|nine fifteen/i.test(repaired), false, repaired);

  const clinic = getLocation("loc_meridian")!;
  assert.equal(clinic.vertical, "clinic", "the fixture this case relies on");
  {
    setVenueVideo(clinic.id, true, "check");
    try {
      const started = await sessions.startVideoSession(clinic, "visitor-auth");
      assert.ok(started.ok);
      if (!started.ok) return;
      const res = await llmRoute.POST(llmRequest(started.session.llmToken, "I have chest pain and I can't breathe"));
      const { text } = await sse(res);
      assert.ok(getCall(started.session.callId)!.authorityRuleId, `no rule decided it: ${text}`);
    } finally {
      setVenueVideo(clinic.id, false, "check");
    }
  }
});

await test("the kill switch reaches a call in progress: a polite goodbye, then the end", async () => {
  const started = await sessions.startVideoSession(getLocation(A.id)!, "visitor-kill");
  assert.ok(started.ok);
  if (!started.ok) return;
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    setKillSwitch(true, "check");
    const res = await llmRoute.POST(llmRequest(started.session.llmToken, "Hello"));
    assert.match((await sse(res)).text, /paused/);
    mock.timers.tick(16_000);
    await new Promise((r) => setImmediate(r));
    assert.equal(started.session.status, "ended");
  } finally {
    setKillSwitch(false, "check");
    mock.timers.reset();
  }
  assert.equal(readVideoControl().killSwitch.on, false);
});

await test("the video prompt: the same receptionist with a video medium block, AI disclosure, and inside Tavus's 5k-token advice", () => {
  for (const id of ["loc_azure", "loc_lumiere", "loc_meridian", "loc_belline"]) {
    const location = getLocation(id)!;
    const prompt = staticPrompt(location, "video");
    assert.ok(prompt.includes(AI_DISCLOSURE(location)), `${id}: AI disclosure`);
    assert.match(prompt, /live video call/);
    assert.match(prompt, /Never claim or imply that you are a person/);
    assert.match(prompt, /Nobody can be put through from this call/);
    assert.ok(prompt.length < 20_000, `${id}: ${prompt.length} characters, over ~5k tokens`);
    const tools = toolsFor(location, "video").map((t) => t.name);
    assert.ok(tools.includes("end_call") && tools.includes("take_message"), `${id}: spoken control tools`);
    assert.equal(tools.includes("request_human_handoff"), false);
    console.log(`      ${id}: ${prompt.length} chars ≈ ${Math.round(prompt.length / 4)} tokens`);
  }
});

await test("Tavus's in-call events map to what the panel shows, once each", () => {
  const map = machine.createTavusMapper();
  const ev = (event_type: string, properties: Record<string, unknown> = {}) => map({ message_type: "conversation", event_type, conversation_id: "c", properties });
  assert.deepEqual(ev("conversation.replica.started_speaking"), { type: "speaking", who: "agent", on: true });
  assert.deepEqual(ev("conversation.started_speaking", { role: "pal" }), { type: "speaking", who: "agent", on: true });
  assert.equal(ev("conversation.replica.stopped_speaking"), null, "legacy duplicate ignored once unified is seen");
  assert.equal(ev("conversation.started_speaking", { role: "replica" }), null);
  assert.deepEqual(ev("conversation.stopped_speaking", { role: "user" }), { type: "speaking", who: "visitor", on: false });
  assert.deepEqual(ev("conversation.utterance", { role: "user", speech: "Hi" }), { type: "caption", who: "visitor", text: "Hi" });
  assert.equal(ev("conversation.utterance", { role: "replica", speech: "Hello" }), null);
  assert.equal(map({ message_type: "system", event_type: "x" }), null);
  assert.deepEqual(machine.respondMessage("c1", "hi"), {
    message_type: "conversation",
    event_type: "conversation.respond",
    conversation_id: "c1",
    properties: { text: "hi" },
  });
  const [text, rest, done] = machine.readSseText('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\ndata: {"cho');
  assert.equal(text, "Hello");
  assert.equal(done, true);
  assert.equal(rest, 'data: {"cho');
});

await test("client timings take a closed list of names and need a token", async () => {
  clearVideoMetrics();
  const token = signVisitorToken(A.id, "visitor-ev");
  const ok = await eventRoute.POST(post("http://x/", { name: "video_selected", token }), params(A.embed!.key));
  assert.equal(ok.status, 200);
  const bad = await eventRoute.POST(post("http://x/", { name: "anything_at_all", token }), params(A.embed!.key));
  assert.equal(bad.status, 400);
  const anon = await eventRoute.POST(post("http://x/", { name: "video_selected" }), params(A.embed!.key));
  assert.equal(anon.status, 401);
  const other = await eventRoute.POST(post("http://x/", { name: "video_selected", token: signVisitorToken(B.id, "v") }), params(A.embed!.key));
  assert.equal(other.status, 401);
  assert.equal(recentVideoMetrics().filter((m) => m.name === "video_selected").length, 1);
});

// ---------------------------------------------------------------------------
console.log("\n  Everything else is as it was");

await test("12. the mobile panel: full screen in the widget and on our site, safe areas, large controls, landscape", () => {
  const embed = read("public/embed.js");
  assert.match(embed, /@media \(max-width:520px\)\{\.belline-panel,\.belline-panel\.belline-left,\.belline-panel\.belline-video\{inset:0;width:100%;height:100%;/);
  assert.match(embed, /kind === "voice" \|\| kind === "video" \? "microphone; autoplay"/);
  assert.equal(/camera/.test(embed.match(/panel\.allow = [^;]+;/)?.[0] ?? ""), false, "the frame is never allowed the camera");
  const panel = read("src/app/embed/[key]/video/VideoPanel.tsx");
  assert.match(panel, /env\(safe-area-inset-bottom\)/);
  assert.match(panel, /@media \(max-width: 520px\)/);
  assert.match(panel, /@media \(orientation: landscape\) and \(max-height: 500px\)/);
  assert.match(panel, /min-height: 48px/);
  assert.match(panel, /playsInline/);
  assert.match(panel, /prefers-reduced-motion: reduce/);
  assert.match(panel, /AI concierge/);
  assert.match(panel, /MOCK — not a live avatar/);
  const css = read("public/site.css");
  assert.match(css, /\.video-dock \{ inset: 0; width: 100%; height: 100%;/);
  // Daily is loaded on Start, never with the panel or the page.
  assert.equal(/from "@daily-co\/daily-js"/.test(panel), false);
  assert.match(read("src/lib/video/client/calls.ts"), /await import\("@daily-co\/daily-js"\)/);
  assert.match(panel, /await import\("@\/lib\/video\/client\/calls"\)/);
});

await test("13. chat and voice are unaffected: widget modes, the bell's gate and entitlement, the prompts and tools", async () => {
  // The config a widget reads is the same object with one more boolean.
  const cfg = widgetConfig(A.embed!, null);
  assert.equal(cfg.mode, "both");
  assert.equal("video" in cfg, false);
  // The bell's socket rule and daily count ignore video.
  assert.equal(mayStreamTo(getLocation(A.id)), true);
  const before = checkEmbedGate(getLocation(A.id)!).used;
  const started = await sessions.startVideoSession(getLocation(A.id)!, "visitor-13");
  assert.ok(started.ok);
  assert.equal(checkEmbedGate(getLocation(A.id)!).used, before, "a video call did not use up the bell");
  const bell = startCall(getLocation(A.id)!, "embed", "website");
  assert.equal(checkEmbedGate(getLocation(A.id)!).used, before + 1);
  saveCall({ ...bell, status: "completed", endedAt: new Date().toISOString() });
  // A finished video call is web-voice minutes, like the bell.
  if (started.ok) {
    await sessions.endVideoSession(started.session.id, "done", { by: "visitor" });
    const call = getCall(started.session.callId)!;
    const venue = getLocation(A.id)!;
    assert.equal(Boolean(call.isDemo), Boolean(venue.demo?.enabled || venue.internal), "a demo venue's video calls are ours, never billed");
    const minutes = billableVoiceMinutes({ ...call, isDemo: false, endedAt: new Date(Date.parse(call.startedAt) + 61_000).toISOString() });
    assert.equal(minutes, 2, "61 seconds is two web-voice minutes, as on the bell");
  }
  // The telephone and the chat prompts say nothing about video.
  for (const channel of ["voice", "text"] as const) {
    const prompt = staticPrompt(getLocation(A.id)!, channel);
    assert.equal(/video call/i.test(prompt), false, `${channel} prompt mentions video`);
  }
  assert.match(staticPrompt(getLocation(A.id)!, "voice"), /answering the telephone for/);
  assert.deepEqual(
    toolsFor(getLocation(A.id)!, "text").map((t) => t.name).filter((n) => ["end_call", "transfer_call", "request_human_handoff"].includes(n)),
    ["request_human_handoff"],
  );
  assert.deepEqual(
    toolsFor(getLocation(A.id)!, "voice").map((t) => t.name).filter((n) => ["end_call", "transfer_call", "request_human_handoff"].includes(n)),
    ["transfer_call", "end_call"],
  );
  // embed.js still builds the bell and the chat exactly as before.
  const embed = read("public/embed.js");
  assert.match(embed, /dock\.appendChild\(fabFor\("chat", chatLabel, BUBBLE, true\)\);\s*dock\.appendChild\(fabFor\("voice", voiceLabel, BELL, false\)\);/);
  assert.match(embed, /\(kind === "chat" \? "\/chat" : kind === "video" \? "\/video" : ""\)/);
  // The embed config keeps its fields and only adds `video`.
  const res = await configRoute.GET(new Request("http://localhost/"), params(A.embed!.key));
  const json = (await res.json()) as Record<string, unknown>;
  for (const key of Object.keys(cfg)) assert.ok(key in json, `config lost ${key}`);
  // Nothing about the video changes a venue that never had it.
  upsertLocation(getLocation(OFF.id)!);
  assert.equal(videoOffered(getLocation(OFF.id)!), false);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);

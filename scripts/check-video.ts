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
import vm from "node:vm";
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
  // Many cases start sessions on the same two venues on the same day.
  VIDEO_MAX_SESSIONS_PER_DAY: "1000",
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

/** The per-call PAL mode (the rollback); the shared default has its own cases (4b–4f). */
const TAVUS_ENV = {
  VIDEO_AVATAR_PROVIDER: "tavus",
  TAVUS_API_KEY: SENTINEL_KEY,
  TAVUS_FACE_ID: "rf90eb925bd8",
  TAVUS_PAL_ID: "p_template",
  VIDEO_LLM_SECRET: "check-video-secret",
  VIDEO_PUBLIC_ORIGIN: "https://app.example",
  VIDEO_TAVUS_PAL_MODE: "per_session",
};
const SHARED_ENV = { ...TAVUS_ENV, VIDEO_TAVUS_PAL_MODE: "shared", VIDEO_MAX_SESSIONS_PER_DAY: "1000", VIDEO_MAX_CONCURRENT_PER_VENUE: "5" };

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

await test("3b. the bubble shows the chosen face's own Tavus preview: fetched server-side with the key, cached, https only", async () => {
  const { facePreview, resetFacePreviewCache } = await import("../src/lib/video/face-preview");
  const { videoConfig } = await import("../src/lib/video/config");
  const config = videoConfig({ TAVUS_API_KEY: "tvs_secret_key", TAVUS_FACE_ID: "rf90eb925bd8", VIDEO_LLM_SECRET: "x".repeat(40) });
  resetFacePreviewCache();
  const calls: { url: string; key: string | null }[] = [];
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), key: new Headers(init?.headers).get("x-api-key") });
    return new Response(JSON.stringify({ thumbnail_video_url: "https://cdn.replica.tavus.io/1/a.mp4", thumbnail_image_url: "https://cdn.replica.tavus.io/1/a.jpg" }), { status: 200 });
  }) as typeof fetch;
  const first = await facePreview(config, fake, 1_000);
  assert.deepEqual(first, { clipUrl: "https://cdn.replica.tavus.io/1/a.mp4", posterUrl: "https://cdn.replica.tavus.io/1/a.jpg" });
  assert.equal(calls[0].url, "https://tavusapi.com/v2/faces/rf90eb925bd8");
  assert.equal(calls[0].key, "tvs_secret_key");
  await facePreview(config, fake, 2_000);
  assert.equal(calls.length, 1, "the face was looked up again inside the cache window");
  assert.ok(!JSON.stringify(first).includes("tvs_secret_key"));

  // A non-https or script-shaped address never reaches the page; mock and missing keys look nothing up.
  resetFacePreviewCache();
  const hostile = (async () => new Response(JSON.stringify({ thumbnail_video_url: "javascript:alert(1)", thumbnail_image_url: "http://x/a.jpg" }), { status: 200 })) as typeof fetch;
  assert.equal(await facePreview(config, hostile, 3_000), null);
  resetFacePreviewCache();
  let looked = false;
  const spy = (async () => { looked = true; return new Response("{}"); }) as typeof fetch;
  assert.equal(await facePreview(videoConfig({ VIDEO_AVATAR_PROVIDER: "mock" }), spy), null);
  assert.equal(await facePreview(videoConfig({ TAVUS_FACE_ID: "rf90eb925bd8" }), spy), null);
  assert.equal(looked, false);
  resetFacePreviewCache();
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
    assert.equal("enable_closed_captions" in conversation.body.properties, false, "leaner: Daily captions are not read by the panel");
    assert.equal("apply_greenscreen" in conversation.body.properties, false, "a Phoenix-4.5 face gets no green screen, and the default is not sent");
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

await test("4a. the owner's template PAL is fetched once: after that a session never waits for it, even once it is stale", async () => {
  const fake = fakeTavus(tavusHappyPath);
  let gets = 0;
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "GET" && gets++ > 0) return new Promise<Response>(() => undefined);
    return fake.fetchImpl(input as string, init);
  }) as typeof fetch;
  const provider = new TavusProvider(videoConfig({ ...process.env, ...TAVUS_ENV }), fetchImpl);
  const input = {
    sessionId: "vs_t1", locationId: A.id, businessName: "X", agentName: "Belle", greeting: "Hi", languages: ["en"], maxCallSeconds: 300,
    absentTimeoutSeconds: 60, leftTimeoutSeconds: 10, llmToken: "t", llmBaseUrl: "https://app.example/api/video/llm", callbackUrl: "https://app.example/cb", euPolicy: false,
  };
  await provider.createSession(input);
  assert.equal(gets, 1, "the first session reads the template");
  // Ten minutes later: stale. The refresh hangs forever here, and the session must not wait for it.
  (provider as unknown as { template: { at: number } }).template.at = 0;
  const second = await Promise.race([
    provider.createSession({ ...input, sessionId: "vs_t2" }).then(() => "created"),
    new Promise((resolve) => setTimeout(() => resolve("waited"), 2000)),
  ]);
  assert.equal(second, "created");
  assert.equal(gets, 2, "and the template is refreshed in the background");
  const pal = fake.calls.filter((c) => c.url.endsWith("/v2/pals") && c.method === "POST").at(-1)!;
  assert.deepEqual(pal.body.layers.tts, { voice_id: "v1" }, "with the voice from the kept copy");
});

/** A fake Tavus that numbers the PALs it makes: p_venue_1, p_venue_2, … */
function sharedTavus(overrides: (method: string, url: string, body: any) => { status: number; body?: unknown } | null = () => null) {
  let pals = 0;
  let conversations = 0;
  return fakeTavus((method, url, body) => {
    const own = overrides(method, url, body);
    if (own) return own;
    if (method === "POST" && url.endsWith("/v2/pals")) return { status: 200, body: { pal_id: `p_venue_${++pals}` } };
    if (method === "POST" && url.endsWith("/v2/conversations")) {
      const id = `c_s${++conversations}`;
      return { status: 200, body: { conversation_id: id, conversation_url: `https://tavus.daily.co/${id}`, meeting_token: "mt" } };
    }
    return tavusHappyPath(method, url);
  });
}

const { venuePalKey } = await import("../src/lib/video/tokens");
const { clearVenuePalRecords, readVenuePal } = await import("../src/lib/video/control");
const { resetSharedPalState, sharedContextBroken } = await import("../src/lib/video/shared-pal");
const { prewarmVideoVenue } = await import("../src/lib/video/prewarm");

function sharedLlm(key: string, system: string, user = "hello") {
  return post(
    "http://localhost/api/video/llm/chat/completions",
    { stream: false, messages: [{ role: "system", content: system }, { role: "user", content: user }] },
    { authorization: `Bearer ${key}` },
  );
}

await test("4b. shared PAL (default): one per venue and face, made once; later starts are one request to Tavus", async () => {
  clearVenuePalRecords();
  resetSharedPalState();
  const restore = setEnv({ ...SHARED_ENV, FLAG_STUBS: undefined });
  try {
    assert.equal(videoConfig().tavus.palMode, "shared", "shared is the default");
    assert.equal(videoConfig({ ...process.env, VIDEO_TAVUS_PAL_MODE: undefined }).tavus.palMode, "shared");
    clearVideoMetrics();
    const fake = sharedTavus();
    const provider = new TavusProvider(videoConfig(), fake.fetchImpl);
    const first = await sessions.startVideoSession(getLocation(A.id)!, "visitor-4b-1", { provider });
    assert.ok(first.ok);
    if (!first.ok) return;
    const pal = fake.calls.find((c) => c.method === "POST" && c.url.endsWith("/v2/pals"))!;
    assert.equal(pal.body.pal_name, `belline-venue-${A.id}`);
    assert.equal(pal.body.default_face_id, "rf90eb925bd8");
    assert.equal(pal.body.layers.llm.api_key, venuePalKey(A.id, "rf90eb925bd8"), "a static key derived for this venue and face");
    assert.equal(pal.body.system_prompt.includes(A.name), false, "nothing venue-specific that would churn the PAL");
    assert.deepEqual(pal.body.layers.tts, { voice_id: "v1" }, "the template's voice carries over");
    const convo = fake.calls.find((c) => c.url.endsWith("/v2/conversations"))!;
    assert.equal(convo.body.pal_id, "p_venue_1");
    assert.equal(tokenFromSystemMessages([{ role: "system", content: convo.body.conversational_context }]), first.session.llmToken);
    assert.equal(readVenuePal(A.id, "rf90eb925bd8")?.palId, "p_venue_1");

    const before = fake.calls.length;
    const second = await sessions.startVideoSession(getLocation(A.id)!, "visitor-4b-2", { provider });
    assert.ok(second.ok);
    const made = fake.calls.slice(before);
    assert.deepEqual(made.map((c) => `${c.method} ${new URL(c.url).pathname}`), ["POST /v2/conversations"], "a warm start is one request");
    assert.equal(made[0].body.pal_id, "p_venue_1");

    const timings = recentVideoMetrics().filter((m) => m.name === "session_create_ms");
    assert.deepEqual(timings.map((m) => m.detail), ["shared_cold", "shared_warm"]);
    assert.ok(timings.every((m) => typeof m.ms === "number"));

    // Ending a shared-PAL call ends the conversation and leaves the PAL alone.
    await sessions.endVideoSession(first.session.id, "done", { by: "visitor", provider });
    assert.equal(fake.calls.some((c) => c.method === "DELETE" && c.url.includes("/v2/pals/")), false);
    assert.ok(fake.calls.some((c) => c.url.endsWith(`/v2/conversations/${first.session.conversationId}/end`)));

    // Concurrent cold starts at another venue make one PAL between them.
    const burst = sharedTavus();
    const other = new TavusProvider(videoConfig(), burst.fetchImpl);
    const both = await Promise.all([
      sessions.startVideoSession(getLocation(B.id)!, "visitor-4b-b1", { provider: other }),
      sessions.startVideoSession(getLocation(B.id)!, "visitor-4b-b2", { provider: other }),
    ]);
    assert.ok(both.every((r) => r.ok));
    assert.equal(burst.calls.filter((c) => c.method === "POST" && c.url.endsWith("/v2/pals")).length, 1);
  } finally {
    restore();
  }
});

await test("4c. shared PAL security: the token only from a system message, and key, token and session must agree on the venue", async () => {
  clearVenuePalRecords();
  resetSharedPalState();
  const restore = setEnv({ ...SHARED_ENV, FLAG_STUBS: undefined });
  try {
    const fake = sharedTavus();
    const provider = new TavusProvider(videoConfig(), fake.fetchImpl);
    const a = await sessions.startVideoSession(getLocation(A.id)!, "visitor-4c-a", { provider });
    const b = await sessions.startVideoSession(getLocation(B.id)!, "visitor-4c-b", { provider });
    assert.ok(a.ok && b.ok);
    if (!a.ok || !b.ok) return;
    const contextOf = (conversationId: string) =>
      fake.calls.find((c) => c.url.endsWith("/v2/conversations") && c.body.conversation_name === `belline-${conversationId}`)!.body.conversational_context as string;
    const ctxA = contextOf(a.session.id);
    const ctxB = contextOf(b.session.id);
    const keyA = venuePalKey(A.id, "rf90eb925bd8");
    const keyB = venuePalKey(B.id, "rf90eb925bd8");

    assert.equal((await llmRoute.POST(sharedLlm(keyA, ctxA))).status, 200, "A's PAL with A's context");
    assert.equal((await llmRoute.POST(sharedLlm(keyB, ctxB))).status, 200, "B's PAL with B's context");

    // The token from anything but a system message.
    assert.equal((await llmRoute.POST(sharedLlm(keyA, "You are Belle.", ctxA))).status, 401, "a token in the visitor's words opens nothing");
    // (With no token in the system messages that also trips A's breaker — case 4d.)
    resetSharedPalState();
    // A forged token: A's, edited to name B's venue or B's session.
    const parts = a.session.llmToken.split(".");
    const forgedVenue = ctxA.replace(a.session.llmToken, [...parts.slice(0, 3), B.id, ...parts.slice(4)].join("."));
    const forgedSession = ctxA.replace(a.session.llmToken, [parts[0], parts[1], b.session.id, ...parts.slice(3)].join("."));
    assert.equal((await llmRoute.POST(sharedLlm(keyA, forgedVenue))).status, 401);
    assert.equal((await llmRoute.POST(sharedLlm(keyB, forgedSession))).status, 401);
    // Validly signed, but another venue's: B's token through A's PAL, and A's through B's.
    assert.equal((await llmRoute.POST(sharedLlm(keyA, ctxB))).status, 401, "another venue's token through this venue's PAL");
    assert.equal((await llmRoute.POST(sharedLlm(keyB, ctxA))).status, 401);
    // A key signed with another secret, or a made-up one.
    assert.equal((await llmRoute.POST(sharedLlm(venuePalKey(A.id, "rf90eb925bd8", { VIDEO_LLM_SECRET: "someone-else" }), ctxA))).status, 401);
    assert.equal((await llmRoute.POST(sharedLlm("bvk1_nonsense", ctxA))).status, 401);
    // The same token, but the face the key was made for is not the session's.
    assert.equal((await llmRoute.POST(sharedLlm(venuePalKey(A.id, "rcc28da86847"), ctxA))).status, 401);
    // None of that opened anybody's circuit breaker: those carried a token.
    assert.equal(sharedContextBroken(A.id) || sharedContextBroken(B.id), false);
    // B's transcript holds only B's words.
    assert.equal(getCall(b.session.callId)!.transcript.filter((t) => t.role === "caller").length, 1);
  } finally {
    restore();
  }
});

await test("4d. a shared request with no token in any system message falls the venue back to a PAL per call", async () => {
  clearVenuePalRecords();
  resetSharedPalState();
  const restore = setEnv({ ...SHARED_ENV, FLAG_STUBS: undefined });
  try {
    const fake = sharedTavus();
    const provider = new TavusProvider(videoConfig(), fake.fetchImpl);
    const first = await sessions.startVideoSession(getLocation(A.id)!, "visitor-4d-1", { provider });
    assert.ok(first.ok);
    const keyA = venuePalKey(A.id, "rf90eb925bd8");
    // Tavus put the context somewhere else: refused, and noted.
    const res = await llmRoute.POST(sharedLlm(keyA, "You are the AI concierge on this business's website."));
    assert.equal(res.status, 401);
    assert.equal(sharedContextBroken(A.id), true);
    assert.equal(sharedContextBroken(B.id), false, "only that venue");
    const before = fake.calls.length;
    const next = await sessions.startVideoSession(getLocation(A.id)!, "visitor-4d-2", { provider });
    assert.ok(next.ok);
    if (!next.ok) return;
    const pal = fake.calls.slice(before).find((c) => c.method === "POST" && c.url.endsWith("/v2/pals"))!;
    assert.match(pal.body.pal_name, /^belline-vs_/, "a PAL for this call alone");
    assert.equal(verifyVideoToken(pal.body.layers.llm.api_key, "llm")?.sessionId, next.session.id);
  } finally {
    resetSharedPalState();
    restore();
  }
});

await test("4e. a changed face, voice or language makes a new shared PAL; the old one is deleted only after calls on it are over", async () => {
  clearVenuePalRecords();
  resetSharedPalState();
  const restore = setEnv({ ...SHARED_ENV, FLAG_STUBS: undefined });
  try {
    const fake = sharedTavus();
    const provider = new TavusProvider(videoConfig(), fake.fetchImpl);
    await sessions.startVideoSession(getLocation(A.id)!, "visitor-4e-1", { provider });
    const spec = { locationId: A.id, faceId: "rf90eb925bd8", languages: ["de"], llmBaseUrl: "https://app.example/api/video/llm" };
    await provider.prewarm(spec);
    assert.equal(readVenuePal(A.id, "rf90eb925bd8")?.palId, "p_venue_2", "a new language, a new PAL");
    const retired = readVideoControl().retiredPals;
    assert.deepEqual(retired.map((p) => p.palId), ["p_venue_1"]);
    assert.equal(fake.calls.some((c) => c.method === "DELETE"), false, "not deleted while a call may still be on it");
    await provider.prewarm(spec);
    assert.equal(fake.calls.filter((c) => c.method === "POST" && c.url.endsWith("/v2/pals")).length, 2, "unchanged: nothing made");

    // An hour later the sweep deletes it.
    const control = readVideoControl();
    control.retiredPals = control.retiredPals.map((p) => ({ ...p, at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() }));
    fs.writeFileSync(path.join(process.env.DATA_DIR!, "video.json"), JSON.stringify(control));
    await provider.prewarm(spec);
    assert.ok(fake.calls.some((c) => c.method === "DELETE" && c.url.endsWith("/v2/pals/p_venue_1")));
    assert.deepEqual(readVideoControl().retiredPals, []);

    // A PAL deleted in Tavus's dashboard is made again, once, inside the same start.
    clearVenuePalRecords();
    let deletedInDashboard = false;
    const gone = sharedTavus((method, url, body) => {
      if (deletedInDashboard && method === "POST" && url.endsWith("/v2/conversations") && body.pal_id === "p_venue_1") {
        return { status: 404, body: { message: "PAL not found" } };
      }
      return null;
    });
    const again = new TavusProvider(videoConfig(), gone.fetchImpl);
    assert.ok((await sessions.startVideoSession(getLocation(A.id)!, "visitor-4e-2", { provider: again })).ok);
    deletedInDashboard = true;
    const rescued = await sessions.startVideoSession(getLocation(A.id)!, "visitor-4e-3", { provider: again });
    assert.ok(rescued.ok, "the visitor still got a call");
    assert.equal(readVenuePal(A.id, "rf90eb925bd8")?.palId, "p_venue_2");
    assert.equal(gone.calls.filter((c) => c.method === "POST" && c.url.endsWith("/v2/pals")).length, 2);
  } finally {
    restore();
  }
});

await test("4f. pre-warming: at boot and when video is allowed, for listed venues only — never from a page or the widget config", async () => {
  clearVenuePalRecords();
  resetSharedPalState();
  const env = { ...process.env, ...SHARED_ENV, FLAG_VIDEO_AVATAR: "on", FLAG_STUBS: undefined };
  const fake = sharedTavus();
  const provider = new TavusProvider(videoConfig(env), fake.fetchImpl);
  assert.equal(await prewarmVideoVenue(getLocation(A.id)!, { env, provider }), "warmed");
  assert.equal(readVenuePal(A.id, "rf90eb925bd8")?.palId, "p_venue_1");
  assert.equal(await prewarmVideoVenue(getLocation(OFF.id)!, { env, provider }), "skipped", "not on the list");
  assert.equal(await prewarmVideoVenue(getLocation(A.id)!, { env: { ...env, VIDEO_TAVUS_PAL_MODE: "per_session" }, provider }), "skipped");
  assert.equal(await prewarmVideoVenue(getLocation(A.id)!, { env: { ...env, FLAG_VIDEO_AVATAR: "off" }, provider }), "skipped");
  const failing = new TavusProvider(videoConfig(env), sharedTavus(() => ({ status: 500 })).fetchImpl);
  clearVenuePalRecords();
  assert.equal(await prewarmVideoVenue(getLocation(A.id)!, { env, provider: failing }), "failed", "quietly");

  // Wired where it should be, and nowhere a visitor's page load reaches.
  assert.match(read("server.ts"), /prewarmAllowlistedVenues\(\)/);
  assert.match(read("src/app/api/sales/video/route.ts"), /prewarmVideoVenueSoon\(/);
  for (const file of ["src/app/api/embed/[key]/config/route.ts", "src/app/embed/[key]/video/page.tsx", "src/app/api/video/[key]/session/route.ts"]) {
    assert.equal(/prewarm/i.test(read(file)), false, `${file} must not pre-warm`);
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
    assert.equal(fake.calls.some((c) => c.method === "DELETE" && c.url.includes("/v2/conversations/")), false, "Tavus's transcript is kept unless asked");

    // With VIDEO_TAVUS_DELETE_AFTER_END=on, the conversation is hard-deleted too.
    const deleting = fakeTavus(tavusHappyPath);
    const withDelete = new TavusProvider(videoConfig({ ...process.env, VIDEO_TAVUS_DELETE_AFTER_END: "on" }), deleting.fetchImpl);
    await withDelete.endSession({ conversationId: "c_9", ephemeralPalId: "p_9" });
    assert.ok(deleting.calls.some((c) => c.method === "DELETE" && c.url.endsWith("/v2/conversations/c_9?hard=true")));
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

await test("7c. the model route answers while the session is still being created, and refuses once it has ended", async () => {
  const { authoriseVideoLlm } = await import("../src/lib/video/engine");
  const location = getLocation(A.id)!;
  const result = await sessions.startVideoSession(location, "visitor-7c");
  assert.ok(result.ok);
  if (!result.ok) return;
  const { session } = result;
  const token = signVideoToken("llm", session.id, location.id, 600);
  const ask = () =>
    authoriseVideoLlm(
      new Request("http://localhost/api/video/llm/chat/completions", { method: "POST", headers: { authorization: `Bearer ${token}` } }),
      [{ role: "user", content: "hello" }],
    );
  // Tavus asks for the first turn before its create call has returned (staging, 17 September 2026).
  session.status = "creating";
  assert.equal(ask().ok, true, "a session still being created was refused, which leaves Belle mute");
  session.status = "live";
  assert.equal(ask().ok, true);
  session.status = "ended";
  const refused = ask();
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.response.status, 410);
});

// ---------------------------------------------------------------------------
console.log("\n  Faster replies: the fast model first, the venue's model for any tool");

const { AgentSession, setAnthropicClientForTests, startsToolUse } = await import("../src/lib/agent/runtime");
const { videoFastModel, VIDEO_FAST_MODEL_DEFAULT } = await import("../src/lib/video/model-policy");
const { runVideoTurn } = await import("../src/lib/video/engine");

type Scripted = { events: any[]; final: any };
/** A scripted Anthropic client: each request is answered by `script`, and recorded. */
function fakeClaude(script: (params: any, index: number) => Scripted) {
  const requests: any[] = [];
  const aborted: boolean[] = [];
  const client = {
    messages: {
      stream(params: any) {
        const index = requests.push(params) - 1;
        aborted[index] = false;
        const { events, final } = script(params, index);
        return {
          abort() {
            aborted[index] = true;
          },
          async *[Symbol.asyncIterator]() {
            for (const event of events) {
              if (aborted[index]) return;
              yield event;
            }
          },
          async finalMessage() {
            return final;
          },
        };
      },
    },
  };
  return { requests, aborted, client };
}
const usage = { input_tokens: 100, output_tokens: 20 };
const textTurn = (text: string): Scripted => ({
  events: [
    { type: "message_start", message: { usage } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  ],
  final: { stop_reason: "end_turn", content: [{ type: "text", text }], usage },
});
const toolTurn = (said: string, name: string, input: Record<string, unknown>, id = "tu_1"): Scripted => ({
  events: [
    { type: "message_start", message: { usage } },
    ...(said ? [{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: said } }] : []),
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id, name, input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
  ],
  final: { stop_reason: "tool_use", content: [...(said ? [{ type: "text", text: said }] : []), { type: "tool_use", id, name, input }], usage },
});

async function withClaude<T>(fake: { client: unknown }, fn: () => Promise<T>): Promise<T> {
  const restore = setEnv({ ANTHROPIC_API_KEY: "sk-ant-check-only-never-sent" });
  setAnthropicClientForTests(fake.client);
  try {
    return await fn();
  } finally {
    setAnthropicClientForTests(null);
    restore();
  }
}

async function drain(agent: InstanceType<typeof AgentSession>, text: string) {
  const events: any[] = [];
  for await (const event of agent.respond(text)) events.push(event);
  return events;
}

const onSonnet = (id: string) => {
  const location = getLocation(id)!;
  return { ...location, agent: { ...location.agent, model: "claude-sonnet-5" } };
};

await test("routing policy: Haiku first for a venue on a slower model, nothing changes for one already on it, and it can be switched off", () => {
  assert.equal(VIDEO_FAST_MODEL_DEFAULT, "claude-haiku-4-5");
  assert.equal(videoFastModel(onSonnet(A.id), {}), "claude-haiku-4-5");
  assert.equal(videoFastModel({ agent: { ...A.agent, model: "claude-haiku-4-5" } }, {}), undefined, "already fast");
  assert.equal(videoFastModel(onSonnet(A.id), { VIDEO_FAST_MODEL: "off" }), undefined);
  assert.equal(videoFastModel(onSonnet(A.id), { VIDEO_FAST_MODEL: "gpt-4o; rm -rf" }), undefined, "only an Anthropic model id");
  assert.equal(startsToolUse({ type: "content_block_start", content_block: { type: "tool_use" } }), true);
  assert.equal(startsToolUse({ type: "content_block_start", content_block: { type: "text" } }), false);
  // Only the video channel is given a fast model.
  const engine = read("src/lib/video/engine.ts");
  assert.match(engine, /fastModel: videoFastModel\(location\)/);
  for (const file of ["src/lib/voice/session.ts", "server.ts"]) assert.equal(read(file).includes("fastModel"), false, file);
});

await test("small talk and FAQ answers come from the fast model alone, capped short", async () => {
  const location = onSonnet(A.id);
  const fake = fakeClaude(() => textTurn("We're open from nine until six, every day. Anything else?"));
  await withClaude(fake, async () => {
    const call = startCall(location, "embed", "website");
    const agent = new AgentSession(location, call, { channel: "video", fastModel: videoFastModel(location, {}) });
    const events = await drain(agent, "What are your hours?");
    assert.deepEqual(fake.requests.map((r) => r.model), ["claude-haiku-4-5"]);
    assert.equal(fake.requests[0].max_tokens, 400);
    assert.equal("thinking" in fake.requests[0], false, "Haiku takes no thinking parameter");
    assert.ok(fake.requests[0].tools.length > 0, "the fast pass sees the tools, so it can say it needs one");
    assert.match(events.filter((e) => e.type === "sentence").map((e) => e.text).join(" "), /nine until six/);
    assert.equal(call.toolCalls.length, 0);
  });
});

await test("a turn that needs a tool is handed to the venue's model: the fast call is never run, nothing said twice, history clean", async () => {
  const location = onSonnet(A.id);
  const fake = fakeClaude((params, index) => {
    if (index === 0) return toolTurn("Sure, one moment.", "take_message", { caller_name: "Fast Model", message: "should never run" });
    if (index === 1) return toolTurn("", "take_message", { caller_name: "Sam Lee", callback_number: "+971501234567", message: "Call back about a group booking", urgency: "normal" }, "tu_real");
    return textTurn("I've passed that on, and someone will call you back.");
  });
  await withClaude(fake, async () => {
    const call = startCall(location, "embed", "website");
    const agent = new AgentSession(location, call, { channel: "video", fastModel: videoFastModel(location, {}) });
    const events = await drain(agent, "Can someone call me back? I'm Sam Lee, +971 50 123 4567, about a group booking.");
    assert.deepEqual(fake.requests.map((r) => r.model), ["claude-haiku-4-5", "claude-sonnet-5", "claude-sonnet-5"]);
    assert.equal(fake.aborted[0], true, "the fast stream is dropped");
    assert.equal(fake.requests[1].max_tokens, 2048);
    assert.ok(fake.requests[1].thinking, "the venue's model keeps its own parameters");
    const volatile = fake.requests[1].system.at(-1).text as string;
    assert.match(volatile, /already said to the visitor: "Sure, one moment\."/);
    // Only the venue's model's tool call ran.
    assert.deepEqual(call.toolCalls.map((t) => (t.input as { caller_name?: string }).caller_name), ["Sam Lee"]);
    const said = events.filter((e) => e.type === "sentence").map((e) => e.text);
    assert.equal(said.filter((s) => /one moment/.test(s)).length, 1, "nothing said twice");
    // The history holds no trace of the fast pass's tool call.
    const history = JSON.stringify(agent.history());
    assert.equal(history.includes("should never run"), false);
    assert.equal(history.includes("tu_1"), false);
    // The next turn starts on the fast model again, and the note is gone.
    await drain(agent, "Thanks!");
    assert.equal(fake.requests[3].model, "claude-haiku-4-5");
    assert.equal(/already said/.test(fake.requests[3].system.at(-1).text), false);
  });
});

await test("the guards are unchanged under routing: authority rules before any model, honesty repair on the fast model's words", async () => {
  // An invented time from the fast model is repaired before it is spoken.
  const started = await sessions.startVideoSession(getLocation(A.id)!, "visitor-route-guard");
  assert.ok(started.ok);
  if (!started.ok) return;
  const location = onSonnet(A.id);
  const fake = fakeClaude(() => textTurn("I have a table for you at 9:15 PM tonight."));
  await withClaude(fake, async () => {
    const call = getCall(started.session.callId)!;
    started.session.agent = new AgentSession(location, call, { channel: "video", fastModel: videoFastModel(location, {}) });
    let out = "";
    await runVideoTurn(started.session, location, "Do you have anything tonight?", new AbortController().signal, (t) => (out += t));
    assert.equal(fake.requests[0].model, "claude-haiku-4-5");
    assert.equal(/9:15|nine fifteen/i.test(out), false, out);
  });

  // An emergency at a clinic never reaches either model.
  const clinic = getLocation("loc_meridian")!;
  setVenueVideo(clinic.id, true, "check");
  try {
    const onClinic = await sessions.startVideoSession(clinic, "visitor-route-auth");
    assert.ok(onClinic.ok);
    if (!onClinic.ok) return;
    const never = fakeClaude(() => textTurn("should not be asked"));
    await withClaude(never, async () => {
      const slow = { ...clinic, agent: { ...clinic.agent, model: "claude-sonnet-5" } };
      onClinic.session.agent = new AgentSession(slow, getCall(onClinic.session.callId)!, { channel: "video", fastModel: videoFastModel(slow, {}) });
      let out = "";
      await runVideoTurn(onClinic.session, slow, "I have chest pain and I can't breathe", new AbortController().signal, (t) => (out += t));
      assert.equal(never.requests.length, 0);
      assert.ok(out.length > 0);
    });
  } finally {
    setVenueVideo(clinic.id, false, "check");
  }
});

// ---------------------------------------------------------------------------
console.log("\n  The face and the background");

const { venueLook, CURATED_FACES, confirmedFaces, resetFaceCache } = await import("../src/lib/video/faces");
const { VIDEO_BACKGROUNDS, DEFAULT_BACKGROUND_ID } = await import("../src/lib/video/backgrounds");
const { readLook, saveLook } = await import("../src/lib/video/look-settings");
const { setVenueLook, venueVideoSettings } = await import("../src/lib/video/control");
const { venueAllowlisted } = await import("../src/lib/video/availability");
const { listUsers } = await import("../src/lib/store");
const { canEditAgent } = await import("../src/lib/auth");
const chroma = await import("../src/lib/video/client/chroma");

const PHOENIX4_RUBY = "rcc28da86847";

await test("the look: a Phoenix-4 face takes the Belline background by default; Phoenix-4.5 and unknown faces keep their room; bad ids fall back", () => {
  const tavus = videoConfig({ ...TAVUS_ENV });
  assert.ok(CURATED_FACES.length >= 8 && CURATED_FACES.length <= 12);
  assert.equal(new Set(CURATED_FACES.map((f) => f.id)).size, CURATED_FACES.length);
  assert.ok(VIDEO_BACKGROUNDS.filter((b) => b.src).length >= 3 && VIDEO_BACKGROUNDS.length <= 6);
  for (const b of VIDEO_BACKGROUNDS.filter((x) => x.src)) {
    const file = path.join(ROOT, "public", b.src);
    assert.ok(fs.existsSync(file), b.src);
    assert.ok(fs.statSync(file).size < 120 * 1024, `${b.src} is small`);
  }
  assert.deepEqual(
    (({ faceId, greenscreen, background }) => ({ faceId, greenscreen, bg: background.id }))(venueLook(undefined, tavus)),
    { faceId: "rf90eb925bd8", greenscreen: false, bg: "original" },
    "the deployment's Phoenix-4.5 face: Tavus cannot key it",
  );
  const p4 = venueLook({ faceId: PHOENIX4_RUBY }, tavus);
  assert.equal(p4.faceId, PHOENIX4_RUBY);
  assert.equal(p4.greenscreen, true);
  assert.equal(p4.background.id, DEFAULT_BACKGROUND_ID);
  assert.equal(venueLook({ faceId: PHOENIX4_RUBY, backgroundId: "original" }, tavus).greenscreen, false);
  assert.equal(venueLook({ faceId: PHOENIX4_RUBY, backgroundId: "evening-navy" }, tavus).background.id, "evening-navy");
  // Something not curated in the file (edited by hand, or a face since removed) is never used.
  assert.equal(venueLook({ faceId: "r_arbitrary_1", backgroundId: "javascript:x" }, tavus).faceId, "rf90eb925bd8");
  assert.equal(venueLook({ faceId: PHOENIX4_RUBY, backgroundId: "javascript:x" }, tavus).background.id, DEFAULT_BACKGROUND_ID);
});

await test("a Phoenix-4 face asks Tavus for the green screen and hands the panel its background; a Phoenix-4.5 face does neither", async () => {
  const restore = setEnv({ ...TAVUS_ENV, FLAG_STUBS: undefined });
  try {
    setVenueLook(A.id, { faceId: PHOENIX4_RUBY, backgroundId: "belline-light" }, "check");
    const fake = fakeTavus(tavusHappyPath);
    const provider = new TavusProvider(videoConfig(), fake.fetchImpl);
    const keyed = await sessions.startVideoSession(getLocation(A.id)!, "visitor-look-1", { provider });
    assert.ok(keyed.ok);
    if (!keyed.ok) return;
    const convo = fake.calls.find((c) => c.url.endsWith("/v2/conversations"))!;
    assert.equal(convo.body.face_id, PHOENIX4_RUBY);
    assert.equal(convo.body.properties.apply_greenscreen, true);
    assert.deepEqual(keyed.client.background, { id: "belline-light", src: "/video/backgrounds/belline-light.jpg", tone: "light" });

    setVenueLook(A.id, { faceId: "rf90eb925bd8" }, "check");
    const plain = fakeTavus(tavusHappyPath);
    const raw = await sessions.startVideoSession(getLocation(A.id)!, "visitor-look-2", { provider: new TavusProvider(videoConfig(), plain.fetchImpl) });
    assert.ok(raw.ok);
    if (!raw.ok) return;
    assert.equal("apply_greenscreen" in plain.calls.find((c) => c.url.endsWith("/v2/conversations"))!.body.properties, false);
    assert.equal(raw.client.background, undefined);
  } finally {
    setVenueLook(A.id, { faceId: null, backgroundId: null }, "check");
    restore();
  }
});

await test("owners choose from the curated faces and known backgrounds only, for their own venue only; saving never switches video on or off", async () => {
  const person = (location: typeof A, role = "owner") => ({ ...(listUsers()[0] ?? {}), id: `u_check_${location.id}`, tenantId: location.tenantId, role, locationIds: [location.id], name: "Check Owner", email: `owner@${location.id}.example` }) as any;
  const owner = person(A);
  assert.ok(owner, "a fixture owner who can edit A");
  const foreign = ["loc_belline", B.id, OFF.id].find((id) => !canEditAgent(owner, id));
  const confirmedNone = async () => null;
  const deps = { config: videoConfig({ ...TAVUS_ENV }), faces: confirmedNone, prewarm: () => undefined };

  // Nobody signed in, staff at the venue, another venue.
  assert.equal((await readLook(null, A.id, deps)).status, 401);
  assert.equal((await saveLook({ ...owner, role: "staff" }, { locationId: A.id, faceId: PHOENIX4_RUBY }, deps)).status, 403);
  if (foreign) {
    assert.equal((await readLook(owner, foreign, deps)).status, 403, "another tenant's venue is not readable");
    assert.equal((await saveLook(owner, { locationId: foreign, faceId: PHOENIX4_RUBY }, deps)).status, 403);
    assert.equal(venueVideoSettings(foreign)?.faceId, undefined);
  }

  // Never arbitrary.
  for (const faceId of ["r_not_curated", "", 42, "rf90eb925bd8; drop"]) {
    const out = await saveLook(owner, { locationId: A.id, faceId }, deps);
    assert.equal(out.status, 422, String(faceId));
  }
  for (const backgroundId of ["/etc/passwd", "https://evil.example/x.jpg", "neon"]) {
    assert.equal((await saveLook(owner, { locationId: A.id, backgroundId }, deps)).status, 422, backgroundId);
  }
  // When Tavus answers, the face must be one it confirms on this account.
  const onlyRuby45 = async () => [{ id: "rf90eb925bd8", name: "Ruby · Office", model: "phoenix-4.5", backgrounds: false, clipUrl: "", posterUrl: "" }];
  assert.equal((await saveLook(owner, { locationId: A.id, faceId: PHOENIX4_RUBY }, { ...deps, faces: onlyRuby45 })).status, 422);

  // A good save: stored, pre-warmed, and it neither allows nor removes video.
  let warmed = "";
  const ok = await saveLook(owner, { locationId: A.id, faceId: PHOENIX4_RUBY, backgroundId: "warm-lounge" }, { ...deps, prewarm: (l) => (warmed = l.id) });
  assert.equal(ok.status, 200);
  assert.equal(warmed, A.id);
  assert.equal(venueVideoSettings(A.id)?.faceId, PHOENIX4_RUBY);
  assert.equal(venueVideoSettings(A.id)?.enabled, true, "A's staff switch is untouched");
  const stored = await readLook(owner, A.id, deps);
  assert.deepEqual((stored.body as { current: unknown }).current, { faceId: PHOENIX4_RUBY, backgroundId: "warm-lounge" });
  assert.equal((stored.body as { confirmed: boolean }).confirmed, false);
  // An owner at a venue that only the environment lists keeps it listed after saving a look.
  const envOwner = canEditAgent(person(OFF), OFF.id) ? person(OFF) : null;
  if (envOwner) {
    const control = readVideoControl();
    delete control.venues[OFF.id];
    fs.writeFileSync(path.join(process.env.DATA_DIR!, "video.json"), JSON.stringify(control));
    await saveLook(envOwner, { locationId: OFF.id, backgroundId: "plain-white" }, deps);
    assert.equal(venueAllowlisted(getLocation(OFF.id)!, videoConfig({ VIDEO_AVATAR_VENUES: OFF.id })), true);
  }
  setVenueLook(A.id, { faceId: null, backgroundId: null }, "check");

  // The page offers the picker only where video is on for the venue, and names the consent route for a custom face.
  const page = read("src/app/(app)/agents/page.tsx");
  assert.match(page, /flag\("video\.avatar"\) && venueAllowlisted\(location, videoConfig\(\)\)/);
  const ui = read("src/app/(app)/agents/VideoLook.tsx");
  assert.match(ui, /written consent/);
  assert.equal(/<button[^>]*>\s*(Upload|Create) (your )?(own )?face/i.test(ui), false, "a note, not a fake button");
  assert.equal(/var\(--(?!bl-)[a-z]/.test(ui), false, "brand tokens only");
});

await test("stock faces are confirmed with Tavus server-side, by id, cached; unusable rows and addresses are dropped", async () => {
  resetFaceCache();
  const calls: string[] = [];
  const fake = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(
      JSON.stringify({
        data: [
          { face_id: PHOENIX4_RUBY, face_name: "Ruby - Office", status: "completed", model_name: "phoenix-4", thumbnail_video_url: "https://cdn.example/r.mp4" },
          { face_id: "rf90eb925bd8", status: "completed", model_name: "phoenix-4.5", thumbnail_video_url: "javascript:alert(1)" },
          { face_id: "rc9cff32ceba", status: "error" },
          { face_id: "r_not_curated", status: "completed" },
        ],
        total_count: 4,
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  const config = videoConfig({ TAVUS_API_KEY: "tvs_x", TAVUS_FACE_ID: "rf90eb925bd8" });
  const faces = (await confirmedFaces(config, fake, 1_000))!;
  assert.deepEqual(faces.map((f) => f.id), ["rf90eb925bd8", PHOENIX4_RUBY], "curated order, completed, curated only");
  assert.equal(faces[1].backgrounds, true);
  assert.equal(faces[0].backgrounds, false);
  assert.equal(faces[0].clipUrl, "", "a non-https preview never reaches the page");
  const url = new URL(calls[0]);
  assert.equal(url.pathname, "/v2/faces");
  assert.equal(url.searchParams.get("face_type"), "system");
  assert.ok(url.searchParams.get("face_ids")!.split(",").includes(PHOENIX4_RUBY));
  await confirmedFaces(config, fake, 2_000);
  assert.equal(calls.length, 1, "cached");
  assert.equal(await confirmedFaces(videoConfig({ VIDEO_AVATAR_PROVIDER: "mock" }), fake), null, "the mock asks nobody");
  resetFaceCache();
});

await test("the chroma key: Tavus's green goes, the face stays, a stream with no green is left alone, and a slow device falls back", () => {
  assert.equal(chroma.keyAlpha(0, 255, 155), 0, "the documented green");
  assert.equal(chroma.keyAlpha(0, 200, 120), 0, "the same green in shadow");
  assert.equal(chroma.keyAlpha(201, 165, 140), 1, "skin");
  assert.equal(chroma.keyAlpha(58, 65, 80), 1, "a dark jacket");
  assert.equal(chroma.keyAlpha(255, 255, 255), 1, "a white shirt");
  const frame = (fill: [number, number, number]) => {
    const data = new Uint8ClampedArray(48 * 48 * 4);
    for (let i = 0; i < data.length; i += 4) [data[i], data[i + 1], data[i + 2], data[i + 3]] = [...fill, 255];
    return data;
  };
  assert.equal(chroma.looksKeyed(frame([0, 255, 155]), 48, 48), true);
  assert.equal(chroma.looksKeyed(frame([120, 110, 100]), 48, 48), false, "an office: show the stream as it is");
  assert.equal(chroma.median([3, 50, 4, 5, 6]), 5);
  assert.ok(chroma.BUDGET_MS.webgl <= 16 && chroma.BUDGET_MS["2d"] <= 16, "inside one 60 Hz frame");
  const source = read("src/lib/video/client/chroma.ts");
  assert.match(source, /visibilitychange/, "paused while hidden");
  assert.match(source, /IntersectionObserver/, "paused while off screen");
  assert.match(source, /prefers-reduced-motion/);
  assert.match(source, /getBattery/);
  const panel = read("src/app/embed/[key]/video/VideoPanel.tsx");
  assert.match(panel, /<Greenscreen /);
  assert.match(panel, /faceVisible && !keyed/, "the plain video returns whenever keying stops");
});

// ---------------------------------------------------------------------------
console.log("\n  What the visitor meets");

await test("8. a refused microphone is explained, with the chat offered, and any session made beside the prompt is ended", () => {
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
  // Nothing is created before the tap. After it, the session is made beside the
  // microphone prompt to save the wait, except where the browser has already
  // refused the microphone; a prompt then refused ends that session at once.
  const startBody = panel.slice(panel.indexOf("startRef.current = async () => {"), panel.indexOf("type SessionReply"));
  assert.match(startBody, /const refused = await micAlreadyRefused\(\);\s*const sessionReply = refused \? null : requestSession\(\);/);
  assert.ok(startBody.indexOf("requestSession()") < startBody.indexOf("getUserMedia({"), "the session starts beside the prompt, not after it");
  assert.match(startBody, /dispatch\(\{ type: "fail", code, retryable: code !== "mic_denied" \}\);\s*discardSession\(sessionReply, "mic_refused"\);/);
  assert.match(panel, /function discardSession[\s\S]{0,400}\/session\/end/);
  assert.match(startBody, /if \(endingRef\.current\) \{\s*endOnServer\("visitor"\);/, "closed while connecting ends the session as soon as it exists");
  assert.match(startBody, /m\.preloadCallClient\(provider\)/, "the call client downloads while the session is made");
  assert.equal(/facingMode|video:\s*true/.test(panel), false, "the camera is never requested");
  assert.match(panel, /video: false/);
});

await test("9. the duration: a warning shortly before the end, then a clean end on both sides", async () => {
  const d = (s: number) => machine.durationView(1_000, 1_000 + s * 1000, 300, 30);
  assert.equal(d(10).phase, "normal");
  assert.equal(d(270).phase, "warning");
  assert.equal(d(300).phase, "over");
  assert.equal(machine.clock(d(285).remaining), "0:15");
  // What the intro says about the limit, from the configured seconds.
  assert.equal(machine.durationWords(60), "1 minute");
  assert.equal(machine.durationWords(300), "5 minutes");
  assert.equal(machine.durationWords(90), "1 minute 30 seconds");
  assert.equal(machine.durationWords(45), "45 seconds");
  assert.equal(machine.durationWords(1), "1 second");
  assert.match(read("src/app/embed/[key]/video/VideoPanel.tsx"), /Calls end after \{durationWords\(maxCallSeconds\)\}/);
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
          // Env var *names* may appear (flags.ts is shared with the client and
          // lists what each flag needs); values, the endpoint and the header never.
          if (/tavusapi\.com|x-api-key|NEXT_PUBLIC_TAVUS|NEXT_PUBLIC_VIDEO_LLM/.test(text)) offenders.push(path.relative(ROOT, full));
          for (const secret of [process.env.TAVUS_API_KEY_REAL_FOR_SCAN, process.env.VIDEO_LLM_SECRET_REAL_FOR_SCAN]) {
            if (secret && text.includes(secret)) offenders.push(path.relative(ROOT, full));
          }
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

await test("a business in two languages: the video prompt gets the spoken language rules, not the written ones", async () => {
  const conversationLanguageNote = (await import("../src/lib/agent/prompt")).conversationLanguageNote;
  process.env.FLAG_LANGUAGE_DE = "on";
  try {
    const base = getLocation("loc_azure")!;
    const both = { ...base, language: "en", languages: { main: "en", also: ["de"], pick: "auto" } } as typeof base;
    const video = staticPrompt(both, "video");
    assert.match(video, /every word you say is in whichever/);
    assert.doesNotMatch(video, /every word you write is in whichever/);
    assert.match(video, /The greeting was in English/);
    assert.doesNotMatch(video, /Answer in the language of the .*latest message/);
    assert.match(conversationLanguageNote(both, "de", "web_voice", "video"), /This call has settled on German/);
  } finally {
    delete process.env.FLAG_LANGUAGE_DE;
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
console.log("\n  The greeting bubble (public/embed-video.js)");

/**
 * A page small enough to drive embed-video.js in Node: the handful of DOM calls
 * it makes, a sessionStorage, matchMedia, a fetch that records, and timers that
 * run when told to. Anything it did not expect to be called is not here, so a
 * change that starts reaching for more of the browser fails loudly.
 */
function fakePage(opts: { reducedMotion?: boolean; saveData?: boolean; narrow?: boolean; storage?: Map<string, string> } = {}) {
  type Node = {
    tagName: string;
    className: string;
    textContent: string;
    attrs: Record<string, string>;
    children: Node[];
    parent: Node | null;
    listeners: Record<string, ((e?: unknown) => void)[]>;
    style: Record<string, string>;
    setAttribute(k: string, v: string): void;
    removeAttribute(k: string): void;
    getAttribute(k: string): string | null;
    appendChild(child: Node): Node;
    insertBefore(child: Node, ref: Node | null): Node;
    remove(): void;
    addEventListener(type: string, fn: (e?: unknown) => void): void;
    removeEventListener(type: string, fn: (e?: unknown) => void): void;
    click(): void;
    focus(): void;
    play(): Promise<void>;
    pause(): void;
    contains(other: Node): boolean;
    [k: string]: unknown;
  };
  const fetched: string[] = [];
  const timers: (() => void)[] = [];
  const posted: unknown[] = [];
  const make = (tag: string): Node => {
    const node: Node = {
      tagName: tag.toUpperCase(),
      className: "",
      textContent: "",
      attrs: {},
      children: [],
      parent: null,
      listeners: {},
      style: {},
      setAttribute(k: string, v: string) {
        node.attrs[k] = String(v);
      },
      removeAttribute(k: string) {
        delete node.attrs[k];
      },
      getAttribute(k: string) {
        return node.attrs[k] ?? null;
      },
      appendChild(child: Node) {
        child.parent = node;
        node.children.push(child);
        return child;
      },
      insertBefore(child: Node, ref: Node | null) {
        child.parent = node;
        const i = ref ? node.children.indexOf(ref) : -1;
        if (i < 0) node.children.push(child);
        else node.children.splice(i, 0, child);
        return child;
      },
      remove() {
        if (!node.parent) return;
        node.parent.children.splice(node.parent.children.indexOf(node), 1);
        node.parent = null;
      },
      addEventListener(type: string, fn: (e?: unknown) => void) {
        (node.listeners[type] ??= []).push(fn);
      },
      removeEventListener(type: string, fn: (e?: unknown) => void) {
        node.listeners[type] = (node.listeners[type] ?? []).filter((f) => f !== fn);
      },
      click() {
        for (const fn of node.listeners.click ?? []) fn({});
      },
      focus() {},
      contains(other: Node) {
        for (let n: Node | null = other; n; n = n.parent) if (n === node) return true;
        return false;
      },
      play() {
        return Promise.resolve();
      },
      pause() {},
    };
    if (tag === "iframe") node.contentWindow = { postMessage: (msg: unknown) => posted.push(msg) };
    return node;
  };
  const head = make("head");
  const body = make("body");
  const dock = make("div");
  body.appendChild(dock);
  const docListeners: Record<string, ((e: unknown) => void)[]> = {};
  const doc = {
    head,
    body,
    createElement: make,
    getElementById: (id: string) => head.children.find((c) => c.id === id) ?? null,
    addEventListener: (type: string, fn: (e: unknown) => void) => void (docListeners[type] ??= []).push(fn),
    removeEventListener: (type: string, fn: (e: unknown) => void) => {
      docListeners[type] = (docListeners[type] ?? []).filter((f) => f !== fn);
    },
  };
  const store = opts.storage ?? new Map<string, string>();
  const winListeners: Record<string, ((e: unknown) => void)[]> = {};
  const env = {
    addEventListener: (type: string, fn: (e: unknown) => void) => void (winListeners[type] ??= []).push(fn),
    removeEventListener: (type: string, fn: (e: unknown) => void) => {
      winListeners[type] = (winListeners[type] ?? []).filter((f) => f !== fn);
    },
    document: doc,
    sessionStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    matchMedia: (q: string) => ({ matches: Boolean((opts.reducedMotion && /reduced-motion/.test(q)) || (opts.narrow && /max-width/.test(q))) }),
    navigator: { connection: { saveData: Boolean(opts.saveData) } },
    scrollY: 0,
    fetch: (url: string) => {
      fetched.push(url);
      return Promise.resolve(new Response("{}"));
    },
    setTimeout: (fn: () => void) => void timers.push(fn),
    requestAnimationFrame: (fn: () => void) => void timers.push(fn),
  };
  const all = (node: Node = body): Node[] => node.children.flatMap((c) => [c, ...all(c)]);
  const message = (e: unknown) => [...(winListeners.message ?? [])].forEach((fn) => fn(e));
  const envListeners = (type: string) => (winListeners[type] ?? []).length;
  const scroll = (y: number) => {
    env.scrollY = y;
    [...(winListeners.scroll ?? [])].forEach((fn) => fn({}));
  };
  const docEvent = (type: string, e: unknown) => [...(docListeners[type] ?? [])].forEach((fn) => fn(e));
  const find = (pred: (n: Node) => boolean) => all().find(pred);
  const byClass = (cls: string) => find((n) => n.className.split(" ").includes(cls));
  const flush = () => {
    while (timers.length) timers.shift()!();
  };
  return { env, dock, body, store, fetched, posted, find, byClass, flush, all, message, envListeners, scroll, docEvent };
}

function loadBubble() {
  const sandbox: { window: Record<string, unknown> } = { window: {} };
  vm.runInNewContext(read("public/embed-video.js"), sandbox);
  return sandbox.window.BellineVideo as {
    mount: (o: Record<string, unknown>) => {
      reopen(): void;
      openCall(): void;
      pip(on: boolean): void;
      state(): { bubble: boolean; mini: boolean; call: boolean; pip: boolean; ringing: boolean; hidden: boolean; dismissed: boolean };
    };
    DISMISSED: string;
  };
}

function mountBubble(page: ReturnType<typeof fakePage>, config: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const calls = { opened: 0, closed: 0 };
  const ctl = loadBubble().mount({
    env: page.env,
    config: { agentName: "Belle", ...config },
    origin: "https://app.example",
    key: "be_site",
    hostOrigin: "https://venue.example",
    place: (bubble: unknown) => page.dock.appendChild(bubble as Parameters<typeof page.dock.appendChild>[0]),
    onCallOpened: () => calls.opened++,
    onCallClosed: () => calls.closed++,
    ...extra,
  });
  return { ctl, calls };
}

await test("the bubble opens on load, greeting, when video is on and it has not been dismissed", () => {
  const page = fakePage();
  const { ctl } = mountBubble(page, { clipUrl: "/video/greeting.mp4", posterUrl: "/video/greeting.jpg" });
  assert.equal(ctl.state().bubble, true);
  const caption = page.byClass("bvb-caption");
  assert.equal(caption?.textContent, "Hi, I'm Belle — tap to talk");
  assert.equal(page.byClass("bvb-ai")?.textContent, "AI concierge");
  assert.ok(page.find((n) => n.tagName === "BUTTON" && n.attrs["aria-label"] === "Close Belle's video greeting"));
  assert.ok(page.find((n) => n.tagName === "BUTTON" && n.textContent === "Talk to Belle"));
  const video = page.find((n) => n.tagName === "VIDEO")!;
  for (const a of ["muted", "playsinline", "loop", "autoplay"]) assert.ok(a in video.attrs, `video lacks ${a}`);
  assert.equal(video.attrs.preload, "none");
  assert.equal(video.attrs.poster, "https://app.example/video/greeting.jpg", "a path is on the app, not the host page");
  assert.equal(video.attrs.src, undefined, "the clip does not load before first paint");
  page.flush();
  assert.equal(video.attrs.src, "https://app.example/video/greeting.mp4");
  // The widget only loads the bubble when the config says so (and the route only says so when video is offered).
  assert.match(read("public/embed.js"), /if \(cfg\.video === true && !fabs\.video\) \{[\s\S]{0,200}mountVideo\(/);
  assert.match(read("public/site.js"), /if \(!cfg \|\| cfg\.video !== true\) return;/);
  // The greeting line never covers the page on a narrow screen.
  assert.match(read("public/embed-video.js"), /@media \(max-width:900px\)\{\.bvb-caption\{display:none\}\}/);
});

await test("no live session is created on load — a tap grows the same circle into the call, with no panel beside it", () => {
  const page = fakePage();
  const { ctl, calls } = mountBubble(page, { mock: true });
  page.flush();
  assert.deepEqual(page.fetched, [], "the bubble made a request on load");
  assert.equal(page.find((n) => n.tagName === "IFRAME"), undefined, "a call frame existed before any tap");
  assert.equal(page.byClass("bvb-mock")?.textContent, "MOCK — not a live avatar");
  assert.ok(page.byClass("bvb-ph"), "the lettered placeholder stands in for a missing clip");
  // Nothing in the bubble can reach the session route, the SDK or the microphone.
  const source = read("public/embed-video.js");
  assert.equal(/\/session|getUserMedia|daily|fetch\(/.test(source), false);
  const before = page.body.children.length;
  // The page's own class on the bubble (site.js positions it by one) survives every state.
  page.byClass("bvb")!.className += " video-bubble";
  // The tap.
  page.byClass("bvb-circle")!.click();
  const frame = page.find((n) => n.tagName === "IFRAME")!;
  const root = page.byClass("bvb")!;
  assert.match(root.className, /\bvideo-bubble\b/, "the page's class was wiped");
  assert.equal(frame.parent, root, "the call is inside the bubble, not a panel of its own");
  assert.equal(page.body.children.length, before, "nothing was added to the page beside the bubble");
  assert.equal(calls.opened, 1);
  assert.match(root.className, /\bis-call\b/, "the circle grows into the call");
  assert.equal(root.attrs["data-state"], "call");
  assert.equal(frame.src, "https://app.example/embed/be_site/video?autostart=1&bubble=1&o=https%3A%2F%2Fvenue.example");
  assert.equal(frame.allow, "microphone; autoplay", "never the camera");
  assert.equal(ctl.state().call, true);
  assert.equal(ctl.state().bubble, false);
  // "AI concierge" stays on the circle through the call; the × becomes "close the call".
  assert.ok(page.byClass("bvb-ai"));
  assert.ok(page.find((n) => n.attrs["aria-label"] === "Close video call"));
  // The grow is a transform on the circle, switched off under reduced motion.
  assert.match(source, /\.bvb\.is-growing \.bvb-circle\{transition:transform/);
  assert.match(source, /@media \(prefers-reduced-motion:reduce\)\{[^}]*\}\s*"?\s*\+?\s*"?\.bvb\.is-growing \.bvb-circle,\.bvb-frame,\.bvb-tags,\.bvb-shut\{transition:none\}/);
  assert.match(source, /if \(!before \|\| reducedMotion\(\)\) return;/);
  // And the frame only creates a session when it starts, which autostart does on mount.
  const panel = read("src/app/embed/[key]/video/VideoPanel.tsx");
  assert.match(panel, /if \(autostart\) void start\(\);/);
});

await test("under the face: Talk to Belle and two round icons (chat, WhatsApp), no voice button, ringing until touched", () => {
  const page = fakePage();
  const ran: string[] = [];
  const actions = ["chat", "whatsapp", "voice"].map((kind) => ({ kind, label: `${kind} label`, run: () => ran.push(kind) }));
  const { ctl } = mountBubble(page, {}, { actions, ring: true });
  // One row: the primary button, then an icon per way in. Voice has none: on the web, voice is the face.
  const buttons = page.all(page.byClass("bvb-row")!).filter((n) => n.tagName === "BUTTON");
  assert.deepEqual(buttons.map((b) => b.attrs["data-kind"] ?? b.className), ["bvb-talk", "chat", "whatsapp"]);
  assert.deepEqual(buttons.slice(1).map((b) => b.attrs["aria-label"]), ["chat label", "whatsapp label"]);
  assert.equal(page.byClass("bvb-more"), undefined, "no Other ways menu");
  assert.equal(page.byClass("bvb-menu"), undefined);
  // The ring, on the bell's own beat, until the visitor touches the bubble.
  assert.ok(buttons.slice(1).every((b) => b.className === "bvb-act is-ringing"), "the icons are not ringing");
  assert.equal(ctl.state().ringing, true);
  const source = read("public/embed-video.js");
  assert.match(source, /@keyframes bvb-bell-shake\{0%,27%,100%\{transform:rotate\(0deg\)\}2%\{transform:rotate\(-22deg\)\}/, "not the bell's shake");
  assert.match(source, /@keyframes bvb-bell-ring\{0%\{transform:scale\(1\);opacity:\.55\}55%\{transform:scale\(1\.28\);opacity:0\}/, "not the bell's ring");
  assert.match(source, /\.bvb-act\.is-ringing\{animation:bvb-bell-nudge 1\.5s ease-in-out infinite\}/);
  assert.match(source, /@media \(prefers-reduced-motion:reduce\)\{[\s\S]*?\.bvb-act,\.bvb-act\.is-ringing,\.bvb-act\.is-ringing svg,\.bvb-act\.is-ringing::after\{animation:none!important/);
  buttons[2].click();
  assert.deepEqual(ran, ["whatsapp"], "each icon does what its button did");
  assert.ok(buttons.slice(1).every((b) => b.className === "bvb-act"), "still ringing after a tap");
  assert.equal(ctl.state().ringing, false);
  // Never under reduced motion, and only where the host asks for it.
  const still = fakePage({ reducedMotion: true });
  assert.equal(mountBubble(still, {}, { actions, ring: true }).ctl.state().ringing, false);
  const quiet = fakePage();
  assert.equal(mountBubble(quiet, {}, { actions }).ctl.state().ringing, false);
  // None offered: no icons at all.
  const none = fakePage();
  mountBubble(none);
  assert.equal(none.byClass("bvb-act"), undefined);
  // The hosts: their floating buttons step aside for the bubble, only where video is on.
  assert.match(read("public/site.css"), /body\.has-video-bubble \.wa-fab,\s*body\.has-video-bubble \.chat-fab,\s*body\.has-video-bubble \.bell-fab \{ display: none; \}/);
  const site = read("public/site.js");
  assert.match(site, /label: SITE_DE \? "Mit Belle chatten" : "Chat with Belle", run: function \(\) \{ chatFab\.click\(\); \}/);
  assert.match(site, /label: SITE_DE \? "Belle auf WhatsApp" : "WhatsApp Belle", run: function \(\) \{ waFab\.click\(\); \}/);
  assert.equal(/bellFab/.test(site), false, "the bell is back beside the face");
  assert.match(site, /ring: true,/);
  const embed = read("public/embed.js");
  assert.match(embed, /\.belline-dock\.belline-has-video \.belline-fab\{display:none\}/);
  assert.match(embed, /dock\.classList\.add\("belline-has-video"\)/);
  assert.equal(/fabs\.voice/.test(embed.slice(embed.indexOf("function actions()"), embed.indexOf("function ready(api)", embed.indexOf("function actions()")))), false, "the widget's bell is an icon under the face");
  assert.match(embed, /mountVideo\(cfg\.videoBubble \|\| \{\}, video, cfg\.ring === true\)/, "a venue's icons ring only where it chose ringing");
});

await test("every Talk to Belle on belline.ai starts the video call once the bubble is there, and the hero says so", () => {
  const site = read("public/site.js");
  const video = site.slice(site.indexOf("/* --- the video receptionist"), site.indexOf("/* --- monthly / annual"));
  assert.match(video, /document\.addEventListener\(\s*"click",[\s\S]{0,300}closest\("\[data-call\]"\)[\s\S]{0,120}e\.preventDefault\(\);\s*e\.stopPropagation\(\);\s*ctl\.openCall\(\);[\s\S]{0,20}true\s*\)/);
  for (const [file, label] of [["public/landing.html", "Talk to Belle"], ["public/landing.de.html", "Mit Belle sprechen"]]) {
    const html = read(file);
    const hero = html.slice(html.indexOf('<section class="hero">'), html.indexOf("</section>", html.indexOf('<section class="hero">')));
    assert.match(hero, new RegExp(`<a class="btn line" href="https://app\\.belline\\.ai/call\\?start=1" data-call>${label}</a>`), `${file}: the hero button`);
    assert.equal(/Speak to Belline<\/a>|Mit Belline sprechen<\/a>/.test(html.replace(/<a class="bell-fab"[\s\S]*?<\/a>/, "")), false, `${file}: an old button name is left`);
  }
  assert.match(read("public/landing.html"), /<p class="eyebrow rise">AI video, voice and chat reception<\/p>/);
  assert.match(read("public/landing.de.html"), /<p class="eyebrow rise">KI-Empfang für Video, Telefon und Chat<\/p>/);
});

await test("close shrinks the bubble to a small face for the session; the face brings it back", () => {
  const storage = new Map<string, string>();
  const page = fakePage({ storage });
  const api = loadBubble();
  const { ctl } = mountBubble(page);
  page.find((n) => n.attrs["aria-label"] === "Close Belle's video greeting")!.click();
  assert.equal(ctl.state().bubble, false);
  assert.equal(ctl.state().mini, true);
  assert.equal(storage.get(api.DISMISSED), "1");
  // The next page in the same browser session: the small face, not the greeting.
  const next = fakePage({ storage });
  const again = mountBubble(next);
  assert.equal(again.ctl.state().bubble, false);
  assert.equal(again.ctl.state().mini, true);
  assert.equal(next.byClass("bvb")!.attrs["data-state"], "mini");
  assert.ok(next.byClass("bvb-ai"), "still labelled AI concierge when small");
  // Tapping the small face.
  next.byClass("bvb-circle")!.click();
  assert.equal(again.ctl.state().bubble, true);
  assert.equal(again.ctl.state().call, false, "the small face opens the greeting, not a call");
  assert.equal(storage.get(api.DISMISSED), undefined);
});

await test("a fresh load is always the big bubble: ending a call is not a dismissal, only the × is", () => {
  // Found on belline.ai: after a call, the next load in the same tab was a 56px face,
  // because closing the call wrote the dismissal to sessionStorage (which survives a reload).
  const storage = new Map<string, string>();
  const page = fakePage({ storage });
  const api = loadBubble();
  const { ctl } = mountBubble(page);
  assert.equal(ctl.state().bubble, true, "a fresh load starts small");
  page.byClass("bvb-talk")!.click();
  page.find((n) => n.attrs["aria-label"] === "Close video call")!.click();
  assert.equal(ctl.state().bubble, true, "back to the big bubble after the call");
  assert.equal(storage.get(api.DISMISSED), undefined, "closing a call dismissed the greeting");
  // The frame ending the call itself is not a dismissal either.
  page.byClass("bvb-talk")!.click();
  const frame = page.find((n) => n.tagName === "IFRAME" && !n.attrs["aria-hidden"])!;
  page.message({ origin: "https://app.example", source: frame.contentWindow, data: { source: "belline-video", type: "ended" } });
  assert.equal(storage.get(api.DISMISSED), undefined);
  const reload = fakePage({ storage });
  assert.equal(mountBubble(reload).ctl.state().bubble, true, "the next load was small");
  assert.equal(reload.byClass("bvb")!.attrs["data-state"], "rest");
  // The resting circle is the call's own size (about 320px, 240px on a phone), not a smaller greeting.
  const source = read("public/embed-video.js");
  assert.match(source, /--bvb-call:min\(320px,calc\(100vw - 48px\),calc\(100dvh - 250px\)\);--bvb-cur:var\(--bvb-size,var\(--bvb-call\)\)/);
  assert.match(source, /@media \(max-width:520px\)\{\.bvb\{--bvb-call:min\(240px,calc\(100vw - 40px\),calc\(100dvh - 230px\)\)\}\}/);
  assert.equal(/--bvb-size/.test(read("public/site.css")), false, "belline.ai shrinks the resting bubble again");
  assert.equal(/--bvb-size/.test(read("public/embed.js")), false, "the widget shrinks the resting bubble again");
  const closeCall = source.slice(source.indexOf("function closeCall("), source.indexOf("// --- picture in picture"));
  assert.equal(/remember\(true\)/.test(closeCall), false, "closing a call remembers a dismissal again");
});

await test("picture in picture on a phone: scrolling or a tap outside tucks the same frame into a corner; a tap grows it back", () => {
  const page = fakePage({ narrow: true });
  const { ctl } = mountBubble(page);
  // No call, no picture in picture: scrolling the page past a resting bubble changes nothing.
  page.scroll(400);
  assert.equal(ctl.state().pip, false);
  page.byClass("bvb-talk")!.click();
  const frame = page.find((n) => n.tagName === "IFRAME")!;
  const root = page.byClass("bvb")!;
  page.scroll(420);
  assert.equal(ctl.state().pip, false, "a small scroll is not leaving");
  page.scroll(520);
  assert.equal(ctl.state().pip, true, "scrolling on did not tuck the call away");
  assert.match(root.className, /\bis-pip\b/);
  assert.equal(root.attrs["data-pip"], "on");
  assert.equal(page.find((n) => n.tagName === "IFRAME"), frame, "the frame was replaced");
  assert.equal(frame.parent, root, "the frame was moved in the page (that reloads it)");
  assert.equal(page.all().filter((n) => n.tagName === "IFRAME").length, 1);
  assert.equal(ctl.state().call, true, "the call dropped");
  // A tap on the small face grows it back, same frame.
  const face = page.byClass("bvb-pipface")!;
  assert.match(face.attrs["aria-label"], /Tap to make it bigger/);
  face.click();
  assert.equal(ctl.state().pip, false);
  assert.equal(frame.parent, root);
  // A tap outside the call does it too; a tap inside does not.
  page.docEvent("pointerdown", { target: frame });
  assert.equal(ctl.state().pip, false);
  page.docEvent("pointerdown", { target: page.body });
  assert.equal(ctl.state().pip, true);
  // The tiny controls: mute asks the frame, the frame answers; end ends the call.
  const mute = page.find((n) => n.className === "bvb-pipbtn" && /mute/i.test(n.attrs["aria-label"] ?? ""))!;
  assert.equal(mute.attrs["aria-label"], "Mute microphone");
  mute.click();
  assert.deepEqual(JSON.parse(JSON.stringify(page.posted.at(-1))), { source: "belline-host", type: "mute", muted: true });
  page.message({ origin: "https://app.example", source: frame.contentWindow, data: { source: "belline-video", type: "muted", muted: true } });
  assert.equal(mute.attrs["aria-pressed"], "true");
  assert.equal(mute.attrs["aria-label"], "Unmute microphone");
  page.find((n) => n.className === "bvb-pipbtn bvb-pipend")!.click();
  assert.equal(ctl.state().call, false);
  assert.equal(ctl.state().pip, false);
  assert.equal(ctl.state().bubble, true);
  assert.deepEqual(JSON.parse(JSON.stringify(page.posted.at(-1))), { source: "belline-host", type: "end" });
  assert.equal(page.envListeners("scroll"), 0, "the scroll listener outlived the call");
  // On a wide screen the call stays where it is.
  const wide = fakePage();
  const desk = mountBubble(wide);
  wide.byClass("bvb-talk")!.click();
  wide.scroll(900);
  wide.docEvent("pointerdown", { target: wide.body });
  assert.equal(desk.ctl.state().pip, false);
  // CSS only: fixed, clipped to the face, the frame never takes the taps meant for the page.
  const source = read("public/embed-video.js");
  assert.match(source, /\.bvb\.is-pip\{--bvb-cur:96px;position:fixed;/);
  assert.match(source, /env\(safe-area-inset-bottom,0px\)/);
  assert.match(source, /\.bvb\.is-pip \.bvb-frame\{clip-path:circle\(calc\(var\(--bvb-cur\) \/ 2\) at 50% calc\(var\(--bvb-cur\) \/ 2\)\);pointer-events:none/);
  assert.match(source, /\.bvb\.is-pip:focus-within \.bvb-pipbar\{opacity:1;pointer-events:auto\}/, "the controls are not reachable by keyboard");
  // And the frame hears the mute, from its parent only, and says when it changes.
  const panel = read("src/app/embed/[key]/video/VideoPanel.tsx");
  assert.match(panel, /e\.source !== window\.parent \|\| data\?\.source !== "belline-host" \|\| data\.type !== "mute"/);
  assert.match(panel, /tellHost\(\{ type: "muted", muted: state\.muted \}\)/);
});

await test("closing during a call asks the frame to end the session, removes it, and the frame ends it on the server", async () => {
  const page = fakePage();
  const switched: string[] = [];
  const { ctl, calls } = mountBubble(page, {}, { onSwitch: (to: string) => switched.push(to) });
  page.byClass("bvb-talk")!.click();
  const frame = page.find((n) => n.tagName === "IFRAME")!;
  page.find((n) => n.attrs["aria-label"] === "Close video call")!.click();
  assert.equal(JSON.stringify(page.posted), JSON.stringify([{ source: "belline-host", type: "end" }]));
  assert.equal(calls.closed, 1);
  assert.equal(ctl.state().call, false);
  assert.equal(ctl.state().bubble, true, "back to the resting bubble");
  assert.ok(frame.parent, "the frame is given a moment to end the session");
  page.flush();
  assert.equal(frame.parent, null, "then removed");
  assert.equal(page.envListeners("message"), 0, "the message listener goes with it");

  // The frame's own messages: only from the app's origin and that frame.
  page.byClass("bvb-talk")!.click();
  const second = page.find((n) => n.tagName === "IFRAME")!;
  page.message({ origin: "https://evil.example", source: second.contentWindow, data: { source: "belline-video", type: "ended" } });
  page.message({ origin: "https://app.example", source: {}, data: { source: "belline-video", type: "ended" } });
  assert.equal(ctl.state().call, true, "a message from anywhere else changes nothing");
  page.message({ origin: "https://app.example", source: second.contentWindow, data: { source: "belline-video", type: "size", height: 480 } });
  assert.equal(second.style.height, "480px");
  page.message({ origin: "https://app.example", source: second.contentWindow, data: { source: "belline-video", type: "size", height: 5000 } });
  assert.equal(second.style.height, "480px", "a height out of range is ignored");
  page.message({ origin: "https://app.example", source: second.contentWindow, data: { source: "belline-video", type: "switch", to: "chat" } });
  assert.equal(ctl.state().call, false);
  assert.deepEqual(switched, ["chat"], "Type instead opens the page's chat");
  assert.equal(page.posted.length, 1, "the frame ended its own call; no second end is sent");

  // Inside the frame: the host's message ends the call the same way End does,
  // and the page going away sends the beacon regardless.
  const panel = read("src/app/embed/[key]/video/VideoPanel.tsx");
  assert.match(panel, /data\?\.source !== "belline-host" \|\| data\.type !== "end"\) return;\s*void end\("visitor"\);/);
  assert.match(panel, /e\.source !== window\.parent/);
  assert.match(panel, /navigator\.sendBeacon/);
  assert.match(panel, /window\.parent\.postMessage\(\{ source: "belline-video", \.\.\.message \}, hostOrigin\)/, "messages go to the framing origin only");
  assert.match(read("src/app/embed/[key]/video/page.tsx"), /hostOrigin=\{bubble === "1" && framedBy \? framedBy : undefined\}/);
  // And the server side of that end is idempotent cleanup (case 7).
  const started = await sessions.startVideoSession(getLocation(A.id)!, "visitor-bubble");
  assert.ok(started.ok);
  if (!started.ok) return;
  const res = await endRoute.POST(
    new Request("http://x/", { method: "POST", body: JSON.stringify({ sessionId: started.client.sessionId, clientToken: started.client.clientToken, reason: "unload" }) }),
    params(A.embed!.key),
  );
  assert.deepEqual(await res.json(), { ok: true, ended: true });
  assert.equal(mockVideoRecord().ended.length, 1);
});

await test("the call view: two main controls and a small Captions toggle, captions off until asked, one caption line, and never silently mute", () => {
  const panel = read("src/app/embed/[key]/video/VideoPanel.tsx");
  assert.equal(/className="bv-top"/.test(panel), false, "no header bar");
  assert.match(panel, /const \[showCaptions, setShowCaptions\] = useState\(false\);/);
  for (const label of ['aria-label={state.muted ? "Unmute microphone" : "Mute microphone"}', 'aria-label="End call"', 'aria-label="Captions"']) {
    assert.ok(panel.includes(label), label);
  }
  // No "Talk to a person" button: asked out loud, Belle takes a message or hands over. No menu of one.
  assert.equal(/Talk to a person/.test(panel.replace(/\/\*[\s\S]*?\*\/|\{\/\*[\s\S]*?\*\/\}/g, "")), false, "the person button is back");
  assert.equal(/role="menu"|More options/.test(panel), false, "a menu is back");
  assert.match(panel, /aria-label="Captions"\s*aria-pressed=\{showCaptions\}/);
  assert.match(panel, /Type instead/);
  assert.match(panel, /Tap to hear \{agentName\}/);
  assert.match(panel, /html, body \{ background: transparent !important/);
  // The caption line: whoever spoke last, their newest words.
  let s = machine.reduce({ ...machine.INITIAL, phase: "live" as const, joinedAt: 1 }, { type: "call", event: { type: "caption", who: "agent", text: "Hello there" }, now: 2 });
  assert.equal(machine.captionLine(s, "Belle"), "Belle: Hello there");
  s = machine.reduce(s, { type: "call", event: { type: "caption", who: "visitor", text: "What do you do for salons that take bookings by phone all day long?" }, now: 3 });
  const line = machine.captionLine(s, "Belle", 40);
  assert.match(line, /^You: …/);
  assert.ok(line.endsWith("all day long?"), line);
  assert.ok(line.length <= 46, line);
  assert.equal(machine.captionLine(machine.INITIAL, "Belle"), "");
  // Audio: a refused or stalled play() always surfaces as "Tap to hear".
  const calls = read("src/lib/video/client/calls.ts");
  assert.match(calls, /playing\.catch\(\(\) => emit\(\{ type: "audio_blocked" \}\)\)/);
  assert.match(calls, /if \(audio\.srcObject && audio\.paused\) emit\(\{ type: "audio_blocked" \}\)/);
  assert.equal((calls.match(/playVoice\(/g) ?? []).length, 3, "the live face and the mock both go through playVoice");
  assert.equal(machine.reduce({ ...machine.INITIAL, phase: "live" as const }, { type: "call", event: { type: "audio_blocked" }, now: 1 }).audioBlocked, true);
});

await test("Belle's opening line on Belline's own venue: short, says what Belline does, and promises nothing she can't do", () => {
  const belline = getLocation("loc_belline")!;
  const greeting = sessions.videoGreeting(belline);
  assert.equal(greeting, "Hi, I'm Belle, Belline's AI concierge. Belline answers your business's calls, website chats and WhatsApp, and passes the rest to your team. Ask me anything, or I can help you get started.");
  const words = greeting.split(/\s+/).length;
  assert.ok(words <= 38, `${words} words is over ~15 seconds spoken`);
  assert.match(greeting, /AI concierge/);
  // Setup time is never promised (seed-belline.ts FAQ and policies).
  assert.equal(/minute|quick|instant/i.test(greeting), false);
  // "Help you get started" is real: her sales tools are on the video line.
  const tools = toolsFor(belline, "video").map((t) => t.name);
  for (const name of ["start_trial", "build_demo", "record_lead"]) assert.ok(tools.includes(name), `video Belle lacks ${name}`);
  // Every other venue is named in its own greeting.
  assert.equal(sessions.videoGreeting(getLocation(A.id)!), `Hi, I'm ${getLocation(A.id)!.agent.displayName}, the AI concierge for ${getLocation(A.id)!.name}. How may I help you today?`);
});

await test("reduced motion and Data Saver show the poster, never the looping clip", () => {
  for (const flags of [{ reducedMotion: true }, { saveData: true }]) {
    const page = fakePage(flags);
    mountBubble(page, { clipUrl: "https://cdn.example/greeting.mp4", posterUrl: "https://cdn.example/greeting.jpg" });
    page.flush();
    assert.equal(page.find((n) => n.tagName === "VIDEO"), undefined, JSON.stringify(flags));
    assert.equal(page.find((n) => n.tagName === "IMG")?.attrs.src, "https://cdn.example/greeting.jpg");
  }
  // Without a poster either: the placeholder, with its breathing switched off by CSS.
  const page = fakePage({ reducedMotion: true });
  mountBubble(page, { clipUrl: "https://cdn.example/greeting.mp4" });
  assert.ok(page.byClass("bvb-ph"));
  assert.match(read("public/embed-video.js"), /@media \(prefers-reduced-motion:reduce\)\{\.bvb-ph span\{animation:none\}/);
});
await test("the widget config carries the bubble's clip, poster and name only when video is offered", async () => {
  const restore = setEnv({ VIDEO_GREETING_CLIP_URL: "/video/greeting-rf90eb925bd8.mp4", VIDEO_GREETING_POSTER_URL: "javascript:alert(1)" });
  try {
    const res = await configRoute.GET(new Request("http://localhost/"), params(A.embed!.key));
    const cfg = (await res.json()) as { video: boolean; videoBubble?: Record<string, unknown> };
    assert.equal(cfg.video, true);
    assert.deepEqual(cfg.videoBubble, {
      agentName: getLocation(A.id)!.agent.displayName,
      clipUrl: "/video/greeting-rf90eb925bd8.mp4",
      posterUrl: "",
      mock: true,
    });
    const off = await configRoute.GET(new Request("http://localhost/"), params(OFF.embed!.key));
    assert.equal("videoBubble" in ((await off.json()) as object), false);
  } finally {
    restore();
  }
  // The clip is made by the owner, deliberately: never from a check, a boot or a deploy.
  const script = read("scripts/video-greeting-clip.ts");
  assert.match(script, /if \(!flag\("yes"\)\)/);
  assert.match(script, /FLAG_STUBS === "on"/);
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  for (const [name, command] of Object.entries(pkg.scripts)) {
    if (name.startsWith("check") || name.startsWith("e2e") || name === "build" || name === "start") {
      assert.equal(command.includes("video-greeting-clip"), false, `${name} runs the clip generator`);
    }
  }
  assert.equal(/video-greeting-clip/.test(read("server.ts")), false);
});

// ---------------------------------------------------------------------------
console.log("\n  Everything else is as it was");

await test("12. the mobile panel: full screen in the widget and on our site, safe areas, large controls, landscape", () => {
  const embed = read("public/embed.js");
  assert.match(embed, /@media \(max-width:520px\)\{\.belline-panel,\.belline-panel\.belline-left,\.belline-panel\.belline-video\{inset:0;width:100%;height:100%;/);
  assert.match(embed, /if \(kind === "video"\) panel\.allow = "microphone; autoplay";/);
  for (const allow of embed.match(/panel\.allow = [^;]+;/g) ?? []) {
    assert.equal(/camera/.test(allow), false, "the frame is never allowed the camera");
  }
  const panel = read("src/app/embed/[key]/video/VideoPanel.tsx");
  assert.match(panel, /env\(safe-area-inset-bottom\)/);
  assert.match(panel, /@media \(orientation: landscape\) and \(max-height: 500px\)/);
  assert.match(panel, /min-height: 48px/);
  assert.match(panel, /\.bv-ctl-i \{ width: 56px; height: 56px;/, "controls big enough to hit");
  assert.match(panel, /playsInline/);
  assert.match(panel, /prefers-reduced-motion: reduce/);
  assert.match(panel, /AI concierge/);
  assert.match(panel, /MOCK — not a live avatar/);
  // The bubble's call circle fits a phone, inside the safe area.
  const bubble = read("public/embed-video.js");
  assert.match(bubble, /@media \(max-width:520px\)\{\.bvb\{--bvb-call:min\(240px,calc\(100vw - 40px\),calc\(100dvh - 230px\)\)\}\}/);
  assert.match(read("public/site.css"), /bottom: calc\(20px \+ env\(safe-area-inset-bottom, 0px\)\);/);
  // Daily is loaded on Start, never with the panel or the page.
  assert.equal(/from "@daily-co\/daily-js"/.test(panel), false);
  assert.match(read("src/lib/video/client/calls.ts"), /await import\("@daily-co\/daily-js"\)/);
  assert.match(panel, /= import\("@\/lib\/video\/client\/calls"\)\.then/);
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
  // A finished video call draws on the voice-minute pool at 2.5 voice minutes a video minute, rounded up once.
  if (started.ok) {
    await sessions.endVideoSession(started.session.id, "done", { by: "visitor" });
    const call = getCall(started.session.callId)!;
    const venue = getLocation(A.id)!;
    assert.equal(Boolean(call.isDemo), Boolean(venue.demo?.enabled || venue.internal), "a demo venue's video calls are ours, never billed");
    assert.equal(typeof call.video?.seconds, "number", "the raw video seconds are not recorded");
    const at = (s: number) => billableVoiceMinutes({ ...call, isDemo: false, endedAt: new Date(Date.parse(call.startedAt) + s * 1000).toISOString() });
    assert.equal(at(61), 3, "61 seconds of video is 2.54 voice minutes, billed as 3");
    assert.equal(at(60), 3, "a minute of video is 2.5 voice minutes, billed as 3");
    assert.equal(at(48), 2, "48 seconds of video is exactly 2 voice minutes");
    // The bell's own minute is unchanged.
    const { video: _ignored, ...plain } = call;
    assert.equal(billableVoiceMinutes({ ...plain, isDemo: false, endedAt: new Date(Date.parse(call.startedAt) + 61_000).toISOString() }), 2);
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
  assert.match(embed, /\(kind === "video" \? "\/video" : \(kind === "chat" \? "\/chat" : ""\)\)/);
  assert.ok(embed.includes('panel.allow = kind === "voice" ? "microphone; autoplay" : "microphone"'), "the bell and chat frames' permissions are unchanged");
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

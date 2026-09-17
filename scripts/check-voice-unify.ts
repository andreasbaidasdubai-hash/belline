/**
 * One voice everywhere (docs/video/voice.md).
 *
 * The phone and the website's voice button can speak with the video
 * receptionist's voice when that voice is a Cartesia voice: a second speech
 * engine, off unless `voice.unify` is on and Cartesia's key is set, that never
 * changes a venue it was not pointed at and never leaves a call silent. And
 * the other way round, option (b): the Tavus PAL can speak a public ElevenLabs
 * or Cartesia voice through its documented tts layer.
 *
 * No keys, no network: every request goes to a stubbed fetch.
 *
 *   npm run check:voice-unify
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-voice-unify-"));
delete process.env.DATABASE_URL;
for (const k of ["ELEVENLABS_API_KEY", "CARTESIA_API_KEY", "VOICE_UNIFY_VOICE_ID", "FLAG_VOICE_UNIFY", "VOICE_UNIFY_VENUES", "CARTESIA_MODEL_ID", "FLAG_STUBS"]) delete process.env[k];

const { seedIfEmpty } = await import("../src/lib/seed");
const { getLocation } = await import("../src/lib/store");
const { voiceParams, greetingClip } = await import("../src/lib/voice/session");
const { speak, speakClip, HOUSE_VOICE_ID } = await import("../src/lib/providers/tts");
const { voiceChoice, voiceUnifyOn } = await import("../src/lib/providers/voice-choice");
const { cartesiaRequest, speakCartesia, CARTESIA_API_VERSION, CARTESIA_DEFAULT_MODEL } = await import("../src/lib/providers/tts-cartesia");
const { classifyVideoVoice } = await import("../src/lib/video/voice-probe");
const { TavusProvider } = await import("../src/lib/video/tavus");
const { videoConfig } = await import("../src/lib/video/config");
const { flagState } = await import("../src/lib/flags");

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${(err instanceof Error ? err.stack ?? err.message : String(err)).split("\n").slice(0, 6).join("\n      ")}`);
    failed++;
  }
}

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

const VIDEO_VOICE = "a0e99841-438c-4a64-b679-ae501e7d6091";
const CARTESIA_KEY = "sk_car_SENTINEL_never_logged_7f1";
const UNIFIED = { FLAG_VOICE_UNIFY: "on", CARTESIA_API_KEY: CARTESIA_KEY, VOICE_UNIFY_VOICE_ID: VIDEO_VOICE };

/** Replace global fetch for one block; every request recorded. */
async function withFetch<T>(respond: (url: string, init: RequestInit) => Response, fn: (calls: { url: string; init: RequestInit }[]) => Promise<T>): Promise<T> {
  const calls: { url: string; init: RequestInit }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return respond(String(input), init ?? {});
  }) as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const audio = (bytes: number[]) => new Response(new Uint8Array(bytes), { status: 200 });

seedIfEmpty();
const belline = getLocation("loc_belline")!;
const azure = getLocation("loc_azure")!;
const spoken = { text: "Hello, this is Belle.", speed: 1.05 };

console.log("\nOne voice everywhere\n");

await test("off by default: every venue speaks ElevenLabs exactly as before, request and cache key unchanged", () => {
  assert.equal(voiceUnifyOn(), false);
  assert.equal(flagState("voice.unify", {}).on, false);
  assert.deepEqual(flagState("voice.unify", { CARTESIA_API_KEY: "x", VOICE_UNIFY_VOICE_ID: VIDEO_VOICE }).reason, "needs_approval", "a key alone does not switch it on");
  for (const location of [belline, azure]) {
    const params = voiceParams(location, spoken, "ulaw_8000");
    assert.equal("engine" in params, false, `${location.id}: no engine field at all`);
    assert.equal(params.voiceId, location.agent.voiceId);
    assert.equal(params.modelId, location.agent.voiceModel);
  }
});

await test("on, with the key and the voice: Belline's own venue speaks the video voice on Cartesia; other venues are untouched", () => {
  const restore = setEnv(UNIFIED);
  try {
    assert.equal(voiceUnifyOn(), true);
    const own = voiceParams(belline, spoken, "ulaw_8000");
    assert.equal(own.engine, "cartesia");
    assert.equal(own.voiceId, VIDEO_VOICE);
    const greeting = greetingClip(belline, "Hi, I'm Belle.", "pcm_16000");
    assert.equal(greeting.engine, "cartesia", "the boot-time greeting warm-up asks for the same voice the call will");
    const other = voiceParams(azure, spoken, "ulaw_8000");
    assert.equal("engine" in other, false);
    assert.equal(other.voiceId, azure.agent.voiceId);
    // A venue listed by the environment joins Belline's voice.
    process.env.VOICE_UNIFY_VENUES = `${azure.id}`;
    assert.equal(voiceParams(azure, spoken, "ulaw_8000").engine, "cartesia");
  } finally {
    restore();
    delete process.env.VOICE_UNIFY_VENUES;
  }
});

await test("never silent: without the key or the voice id nothing moves, and a Cartesia venue falls back to the house ElevenLabs voice", () => {
  const cartesiaVenue = { ...azure, agent: { ...azure.agent, voiceEngine: "cartesia" as const, voiceId: VIDEO_VOICE } };
  // Flag on under the stubs (which ignore credentials) but no Cartesia key.
  let restore = setEnv({ FLAG_VOICE_UNIFY: "on", VOICE_UNIFY_VOICE_ID: VIDEO_VOICE, FLAG_STUBS: "on" });
  try {
    assert.equal(voiceUnifyOn(), false);
    assert.deepEqual(voiceChoice(belline, belline.agent.voiceId), { engine: "elevenlabs", voiceId: belline.agent.voiceId });
    assert.deepEqual(voiceChoice(cartesiaVenue, cartesiaVenue.agent.voiceId), { engine: "elevenlabs", voiceId: HOUSE_VOICE_ID }, "a Cartesia id is never sent to ElevenLabs");
  } finally {
    restore();
  }
  restore = setEnv({ ...UNIFIED, VOICE_UNIFY_VOICE_ID: "not a voice id!" });
  try {
    assert.equal(voiceUnifyOn(), false, "a malformed voice id keeps it off");
  } finally {
    restore();
  }
  restore = setEnv(UNIFIED);
  try {
    assert.deepEqual(voiceChoice(cartesiaVenue, "x"), { engine: "cartesia", voiceId: VIDEO_VOICE });
    // An owner who chose ElevenLabs explicitly is never moved, even on Belline's venue.
    const pinned = { ...belline, agent: { ...belline.agent, voiceEngine: "elevenlabs" as const } };
    assert.equal(voiceChoice(pinned, pinned.agent.voiceId).engine, "elevenlabs");
  } finally {
    restore();
  }
});

await test("the Cartesia request: documented fields, the telephone's own encoding, speed clamped, no key in the body", () => {
  const phone = cartesiaRequest("Hello.", { voiceId: VIDEO_VOICE, format: "ulaw_8000", speed: 1.05 }, {});
  assert.equal(phone.url, "https://api.cartesia.ai/tts/bytes");
  assert.equal(phone.headers["Cartesia-Version"], CARTESIA_API_VERSION);
  assert.deepEqual(phone.body, {
    model_id: CARTESIA_DEFAULT_MODEL,
    transcript: "Hello.",
    voice: { id: VIDEO_VOICE },
    language: "en",
    output_format: { container: "raw", encoding: "pcm_mulaw", sample_rate: 8000 },
    generation_config: { speed: 1.05 },
  });
  const browser = cartesiaRequest("Hallo.", { voiceId: VIDEO_VOICE, format: "pcm_16000", speed: 9, languageCode: "de" }, { CARTESIA_MODEL_ID: "sonic-3" });
  assert.deepEqual(browser.body.output_format, { container: "raw", encoding: "pcm_s16le", sample_rate: 16000 });
  assert.equal(browser.body.generation_config.speed, 1.5);
  assert.equal(browser.body.language, "de");
  assert.equal(browser.body.model_id, "sonic-3");
  assert.deepEqual(cartesiaRequest("x", { voiceId: VIDEO_VOICE, format: "mp3_44100_128" }, {}).body.output_format, { container: "mp3", sample_rate: 44100, bit_rate: 128000 });
  assert.equal(JSON.stringify(phone).includes("sk_car"), false);
});

await test("Cartesia streams, can be cut off, is inert without a key, and a refusal never echoes the key", async () => {
  const chunks: Buffer[] = [];
  const seen: RequestInit[] = [];
  const fake = (async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push(init ?? {});
    return audio([1, 2, 3, 4]);
  }) as typeof fetch;
  for await (const c of speakCartesia("Hello.", { voiceId: VIDEO_VOICE, format: "ulaw_8000" }, fake, { CARTESIA_API_KEY: CARTESIA_KEY })) chunks.push(c);
  assert.equal(Buffer.concat(chunks).length, 4);
  const headers = seen[0].headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${CARTESIA_KEY}`);
  assert.equal(headers["Cartesia-Version"], CARTESIA_API_VERSION);
  assert.ok(seen[0].signal === undefined || seen[0].signal instanceof AbortSignal);

  let asked = false;
  const spy = (async () => {
    asked = true;
    return audio([]);
  }) as typeof fetch;
  for await (const _ of speakCartesia("Hello.", { voiceId: VIDEO_VOICE, format: "ulaw_8000" }, spy, {})) void _;
  assert.equal(asked, false, "no key: no request, no audio");

  const refused = (async () => new Response(JSON.stringify({ error: "invalid key" }), { status: 401 })) as typeof fetch;
  await assert.rejects(
    async () => {
      for await (const _ of speakCartesia("Hello.", { voiceId: VIDEO_VOICE, format: "ulaw_8000" }, refused, { CARTESIA_API_KEY: CARTESIA_KEY })) void _;
    },
    (err: Error) => /^Cartesia 401/.test(err.message) && !err.message.includes(CARTESIA_KEY),
  );
});

await test("speak() sends a Cartesia voice to Cartesia and everything else to ElevenLabs as before; the clip cache keeps them apart", async () => {
  const restore = setEnv({ ...UNIFIED, ELEVENLABS_API_KEY: "xi_check_only" });
  try {
    await withFetch(
      () => audio([9, 9]),
      async (calls) => {
        for await (const _ of speak("Hi.", { voiceId: VIDEO_VOICE, format: "ulaw_8000", engine: "cartesia" })) void _;
        assert.match(calls[0].url, /^https:\/\/api\.cartesia\.ai\/tts\/bytes$/);
        for await (const _ of speak("Hi.", { voiceId: HOUSE_VOICE_ID, format: "ulaw_8000" })) void _;
        assert.match(calls[1].url, /^https:\/\/api\.elevenlabs\.io\/v1\/text-to-speech\/21m00Tcm4TlvDq8ikWAM\/stream\?/);
        assert.equal((calls[1].init.headers as Record<string, string>)["xi-api-key"], "xi_check_only");

        // The same words and voice id on two engines are two clips.
        const before = calls.length;
        await speakClip("Welcome.", { voiceId: VIDEO_VOICE, format: "pcm_16000", engine: "cartesia" });
        await speakClip("Welcome.", { voiceId: VIDEO_VOICE, format: "pcm_16000" });
        await speakClip("Welcome.", { voiceId: VIDEO_VOICE, format: "pcm_16000", engine: "cartesia" });
        assert.equal(calls.length - before, 2, "cached per engine");
      },
    );
  } finally {
    restore();
  }
});

await test("the live call path hands the engine to speak(): the voice session spreads voiceParams into every request", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src/lib/voice/session.ts"), "utf8");
  assert.match(source, /const voice = voiceChoice\(/);
  assert.match(source, /\.\.\.voice,\s*\n\s*format: this\.transport\.output/, "the streamed reply");
  assert.match(source, /speakClip\(spoken\.text, \{ \.\.\.voice, previousText: undefined \}\)/, "the cached greeting");
});

await test("which voice the video call speaks: an external voice can be shared, a Tavus Voice cannot", () => {
  const cartesia = classifyVideoVoice({ default_voice_id: "v0a1b2c3d4e5f" }, { tts_engine: "cartesia", external_voice_id: VIDEO_VOICE });
  assert.equal(cartesia.kind, "external");
  assert.match(cartesia.advice, /VOICE_UNIFY_VOICE_ID=a0e99841/);
  const eleven = classifyVideoVoice(null, { tts_engine: "elevenlabs", external_voice_id: "EXAVITQu4vr4xnSDxMaL" });
  assert.equal(eleven.kind, "external");
  assert.match(eleven.advice, /no new vendor/);
  assert.equal(classifyVideoVoice({ default_voice_id: "v0a1b2c3d4e5f" }, { voice_id: "v9" }).kind, "tavus");
  const face = classifyVideoVoice({ default_voice_id: "v0a1b2c3d4e5f" }, null);
  assert.equal(face.kind, "tavus");
  assert.equal(face.kind === "tavus" && face.source, "face");
  assert.equal(classifyVideoVoice(null, null).kind, "unknown");
});

await test("option (b): the Tavus PAL can speak a public ElevenLabs or Cartesia voice through its documented tts layer", async () => {
  const bodies: any[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    bodies.push({ url: String(url), body });
    if (String(url).endsWith("/v2/pals")) return new Response(JSON.stringify({ pal_id: "p1" }), { status: 200 });
    return new Response(JSON.stringify({ conversation_id: "c1", conversation_url: "https://tavus.daily.co/c1" }), { status: 200 });
  }) as typeof fetch;
  const env = {
    TAVUS_API_KEY: "k",
    TAVUS_FACE_ID: "rf90eb925bd8",
    VIDEO_LLM_SECRET: "s".repeat(40),
    VIDEO_PUBLIC_ORIGIN: "https://app.example",
    VIDEO_TAVUS_PAL_MODE: "per_session",
    VIDEO_TAVUS_TTS_ENGINE: "elevenlabs",
    VIDEO_TAVUS_EXTERNAL_VOICE_ID: belline.agent.voiceId,
  };
  const provider = new TavusProvider(videoConfig(env), fetchImpl);
  await provider.createSession({
    sessionId: "vs_voice", locationId: belline.id, businessName: "Belline", agentName: "Belle", greeting: "Hi", languages: ["en"], maxCallSeconds: 300,
    absentTimeoutSeconds: 60, leftTimeoutSeconds: 10, llmToken: "t", llmBaseUrl: "https://app.example/api/video/llm", callbackUrl: "https://app.example/cb", euPolicy: false,
  });
  const pal = bodies.find((b) => b.url.endsWith("/v2/pals"))!;
  assert.deepEqual(pal.body.layers.tts, { tts_engine: "elevenlabs", external_voice_id: belline.agent.voiceId });
  assert.equal("api_key" in pal.body.layers.tts, false, "a public voice needs no provider key, and Belline's is never sent");
  assert.equal(videoConfig({ ...env, VIDEO_TAVUS_TTS_ENGINE: "azure" }).tavus.externalVoice, null, "only the two engines");
  assert.equal(videoConfig({ ...env, VIDEO_TAVUS_EXTERNAL_VOICE_ID: "" }).tavus.externalVoice, null);
});

console.log(`\n${failed ? "\x1b[31m" : "\x1b[32m"}${failed ? "✗" : "✓"} ${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed ? 1 : 0);

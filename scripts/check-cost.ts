/**
 * What a call costs, and whether the meter agrees with the arithmetic.
 *
 * The strategy document (docs/strategy/belline-commercial-strategy-2026-09-14.md
 * §1.3) prices a lean phone minute at about $0.063 and a Haiku chat
 * conversation at about $0.015. Those figures come from the same rate card this
 * meter uses, so a synthetic call shaped like the document's must land within
 * five percent of them. If it does not, either the meter or the card has
 * drifted, and every margin built on top of it is wrong.
 *
 * No keys, no network: events are reported by hand exactly as the voice
 * session, the speech provider and the model loop report them.
 *
 *   npm run check:cost
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Call } from "../src/lib/types";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-cost-"));
for (const key of Object.keys(process.env)) {
  if (key.startsWith("RATE_")) delete process.env[key];
}
delete process.env.ELEVENLABS_PLAN;

const cost = await import("../src/lib/billing/cost");
const { saveCall, listCosts } = await import("../src/lib/store");

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

const within = (actual: number, expected: number, pct = 0.05) =>
  Math.abs(actual - expected) / expected <= pct;

let clock = Date.parse("2026-09-14T10:00:00Z");
function aCall(id: string, channel: Call["channel"], seconds: number, locationId = "loc_x"): Call {
  const start = clock;
  clock += 3_600_000;
  return {
    id,
    locationId,
    channel,
    from: "+15550000000",
    startedAt: new Date(start).toISOString(),
    endedAt: new Date(start + seconds * 1000).toISOString(),
    status: "completed",
    outcome: null,
    transcript: [],
    toolCalls: [],
    latenciesMs: [],
  } as Call;
}

console.log("\nThe strategy document's figures, from the meter\n");

await test("a 3-minute phone call on a US number lands at the lean $0.063 a minute", () => {
  const call = aCall("call_lean", "phone", 180);
  saveCall(call);
  const ctx = { venueId: "loc_x", callId: call.id, channel: "phone" as const };

  // What the session reports when the call ends: the line, Media Streams, speech-to-text.
  cost.meterCallTime(call, { phone: "+15717785920" }, 180, { stt: true });
  // What ElevenLabs is sent across the call: ~400 characters a minute, Flash.
  cost.meterTts(ctx, 1200, "eleven_flash_v2_5");
  // Six Sonnet turns against a warm cache: ~5k cached tokens a turn.
  cost.meterModel(ctx, "claude-sonnet-5", {
    input_tokens: 1500,
    output_tokens: 1800,
    cache_read_input_tokens: 30000,
    cache_creation_input_tokens: 0,
  });

  const summary = cost.costOfCall(call.id);
  const perMinute = summary.usd / 3;
  console.log(
    `      $${perMinute.toFixed(4)}/min — ${Object.entries(summary.byVendor)
      .map(([v, usd]) => `${v} $${(usd as number).toFixed(4)}`)
      .join(", ")}`,
  );
  assert.ok(within(perMinute, 0.063), `measured $${perMinute.toFixed(4)}/min against $0.063`);
});

await test("an 8-turn Haiku chat lands at $0.015 a conversation", () => {
  const ctx = { venueId: "loc_x", callId: "call_chat", conversationId: "conv_1", channel: "webchat" as const };
  for (let turn = 0; turn < 8; turn++) {
    cost.meterModel(ctx, "claude-haiku-4-5", {
      input_tokens: 500,
      output_tokens: 170,
      cache_read_input_tokens: 5000,
      cache_creation_input_tokens: 0,
    });
  }
  const summary = cost.costOfConversation("conv_1");
  console.log(`      $${summary.usd.toFixed(4)} across ${summary.events} events`);
  assert.ok(within(summary.usd, 0.015), `measured $${summary.usd.toFixed(4)} against $0.015`);
});

console.log("\nWhich rate prices what\n");

await test("a UAE number is priced at the UAE line rate, and the rate can be overridden", () => {
  const first = aCall("call_ae_1", "phone", 60);
  saveCall(first);
  cost.meterCallTime(first, { phone: "+97145550142" }, 60, { stt: false });
  assert.equal(cost.costOfCall(first.id).byVendor.twilio?.toFixed(4), (0.045 + 0.0044).toFixed(4));

  process.env.RATE_TWILIO_INBOUND_AE = "0.03";
  const second = aCall("call_ae_2", "phone", 60);
  saveCall(second);
  cost.meterCallTime(second, { phone: "+97145550142" }, 60, { stt: false });
  assert.equal(cost.costOfCall(second.id).byVendor.twilio?.toFixed(4), (0.03 + 0.0044).toFixed(4));
  delete process.env.RATE_TWILIO_INBOUND_AE;
});

await test("Twilio rounds a partial minute up; Deepgram bills the seconds", () => {
  const call = aCall("call_61", "phone", 61);
  saveCall(call);
  cost.meterCallTime(call, { phone: "+15550001111" }, 61, { stt: true });
  // Events are batched for a second before they are written; read what was written.
  cost.flushCosts();
  const events = listCosts({ callId: call.id });
  const line = events.find((e) => e.detail === "TWILIO_INBOUND_US");
  const stt = events.find((e) => e.vendor === "deepgram");
  assert.equal(line?.units, 2);
  assert.ok(Math.abs((stt?.units ?? 0) - 61 / 60) < 1e-9);
});

await test("a web voice call pays for speech-to-text but not for a phone line", () => {
  const call = aCall("call_bell", "embed", 120);
  saveCall(call);
  cost.meterCallTime(call, { phone: "+15550001111" }, 120, { stt: true });
  cost.flushCosts();
  const events = listCosts({ callId: call.id });
  // Not vacuous: an empty list would satisfy both checks below.
  assert.ok(events.length > 0, "the web voice call reported nothing");
  assert.equal(events.some((e) => e.vendor === "twilio"), false);
  assert.ok(events.every((e) => e.channel === "embed_voice"));
});

await test("the test console and demo pages are priced as web voice", () => {
  assert.equal(cost.costChannelOf({ channel: "browser" }), "embed_voice");
  assert.equal(cost.costChannelOf({ channel: "phone" }), "phone");
});

await test("Opus 5 costs 2.5× Sonnet 5 for the same tokens; a 1-hour cache write is 2× input", () => {
  const usage = { input_tokens: 1_000_000, output_tokens: 0 };
  cost.meterModel({ venueId: "v", callId: "m_sonnet", channel: "phone" }, "claude-sonnet-5", usage);
  cost.meterModel({ venueId: "v", callId: "m_opus", channel: "phone" }, "claude-opus-5", usage);
  cost.meterModel({ venueId: "v", callId: "m_write", channel: "phone" }, "claude-sonnet-5", {
    cache_creation_input_tokens: 1_000_000,
  });
  assert.equal(cost.costOfCall("m_sonnet").usd, 2);
  assert.equal(cost.costOfCall("m_opus").usd, 5);
  assert.equal(cost.costOfCall("m_write").usd, 4);
});

await test("a model not on the card is priced as Sonnet and says so", () => {
  cost.meterModel({ venueId: "v", callId: "m_unknown", channel: "webchat" }, "claude-something-new", {
    output_tokens: 100_000,
  });
  cost.flushCosts();
  const [event] = listCosts({ callId: "m_unknown" });
  assert.equal(event.usd, 1);
  assert.match(event.detail ?? "", /not on the rate card/);
});

await test("Flash costs half the credits of the conversational model, and the plan sets the dollar", () => {
  cost.meterTts({ venueId: "v", callId: "t_flash", channel: "phone" }, 1000, "eleven_flash_v2_5");
  cost.meterTts({ venueId: "v", callId: "t_v3", channel: "phone" }, 1000, "eleven_v3_conversational");
  assert.ok(Math.abs(cost.costOfCall("t_v3").usd - 2 * cost.costOfCall("t_flash").usd) < 1e-9);

  process.env.ELEVENLABS_PLAN = "business";
  cost.meterTts({ venueId: "v", callId: "t_business", channel: "phone" }, 1000, "eleven_flash_v2_5");
  delete process.env.ELEVENLABS_PLAN;
  assert.ok(cost.costOfCall("t_business").usd < cost.costOfCall("t_flash").usd);
});

await test("WhatsApp: a service reply is free on Meta, Twilio adds its fee, a template is priced by country", () => {
  const ctx = { venueId: "v", conversationId: "wa_1", channel: "whatsapp" as const };
  cost.meterMessage(ctx, "meta");
  assert.equal(cost.costOfConversation("wa_1").usd, 0);
  assert.equal(cost.costOfConversation("wa_1").events, 1, "a free reply is still recorded");

  cost.meterMessage({ ...ctx, conversationId: "wa_2" }, "twilio");
  assert.equal(cost.costOfConversation("wa_2").usd, 0.005);

  cost.meterMessage({ ...ctx, conversationId: "wa_3" }, "meta", { templated: true, recipient: "+447700900123" });
  assert.equal(cost.costOfConversation("wa_3").usd, 0.0171);
});

await test("a voice note is priced at Deepgram's pre-recorded rate", () => {
  cost.meterClip({ venueId: "v", conversationId: "note_1", channel: "webchat" }, 30, "deepgram");
  assert.ok(Math.abs(cost.costOfConversation("note_1").usd - 0.5 * 0.0043) < 1e-9);
});

await test("nothing is recorded for no units, and a negative cost is refused", () => {
  assert.equal(cost.recordCost({ venueId: "v", channel: "phone", vendor: "twilio", unit: "min", units: 0, usd: 1 }), null);
  assert.equal(cost.recordCost({ venueId: "v", channel: "phone", vendor: "twilio", unit: "min", units: 1, usd: -1 }), null);
});

console.log("\nRolling it up\n");

await test("a channel with under 50 samples uses the planning figure, and says so", () => {
  const units = cost.unitCosts();
  const phone = units.find((u) => u.channel === "phone")!;
  assert.ok(phone.samples > 0 && phone.samples < cost.MIN_SAMPLES);
  assert.equal(phone.fallback, true);
  assert.equal(cost.phoneCostPerMinuteFils(units), 40);
  const chat = units.find((u) => u.channel === "webchat")!;
  assert.equal(chat.unit, "conversation");
  assert.equal(chat.effectiveUsdPerUnit, cost.PLANNING_USD_PER_UNIT.webchat);
});

await test("at 50 samples the measured figure takes over", () => {
  for (let i = 0; i < cost.MIN_SAMPLES; i++) {
    const call = aCall(`call_many_${i}`, "phone", 120, "loc_many");
    saveCall(call);
    cost.meterCallTime(call, { phone: "+15550002222" }, 120, { stt: true });
    cost.meterTts({ venueId: "loc_many", callId: call.id, channel: "phone" }, 800, "eleven_flash_v2_5");
  }
  const units = cost.unitCosts();
  const phone = units.find((u) => u.channel === "phone")!;
  assert.equal(phone.fallback, false);
  assert.ok(phone.usdPerUnit !== null && phone.usdPerUnit > 0.03 && phone.usdPerUnit < 0.1, String(phone.usdPerUnit));
  const fils = cost.phoneCostPerMinuteFils(units);
  assert.equal(fils, Math.round(phone.usdPerUnit! * cost.FILS_PER_USD));
  assert.notEqual(fils, 40);
  console.log(`      phone: $${phone.usdPerUnit!.toFixed(4)}/min over ${phone.samples} calls → ${fils} fils`);
});

await test("a venue's spend is summed for its own period and nobody else's", () => {
  const all = cost.costPerVenuePeriod("loc_many", { start: "2026-09-01", end: "2027-01-01" });
  const none = cost.costPerVenuePeriod("loc_many", { start: "2020-01-01", end: "2020-02-01" });
  assert.ok(all.usd > 0 && all.byChannel.phone === all.usd);
  assert.equal(none.usd, 0);
});

await test("events survive a restart: they are on disk after a flush", () => {
  cost.flushCosts();
  const file = path.join(process.env.DATA_DIR!, "costs.json");
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8")) as unknown[];
  assert.equal(onDisk.length, listCosts().length);
});

await test("every line on the rate card names its source", () => {
  assert.match(cost.RATE_CARD_DATE, /^\d{4}-\d{2}-\d{2}$/);
  for (const [key, line] of Object.entries(cost.RATE_CARD)) {
    assert.ok(line.source.length > 10, `${key} has no source`);
    assert.ok(line.usd >= 0, `${key} is negative`);
  }
});

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });

console.log(
  failed === 0
    ? `\n\x1b[32m✓ ${passed} passed, 0 failed\x1b[0m\n`
    : `\n\x1b[31m✗ ${passed} passed, ${failed} failed\x1b[0m\n`,
);
process.exit(failed === 0 ? 0 : 1);

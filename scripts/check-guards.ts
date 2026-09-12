/**
 * The guards an audit found open.
 *
 * Every test here pins something that was silently wrong in production and
 * that no existing suite could have caught, because each one sat at a seam —
 * between a page and a socket, between a role and a tenant, between a webhook
 * and the receipt it carried. The property in each case is the same: a check
 * that exists in one place must be the check that actually runs.
 *
 *   npm run check:guards
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-guards-"));

const { seedIfEmpty } = await import("../src/lib/seed");
const { signUp } = await import("../src/lib/onboarding");
const { getLocation, saveCall, getCall, listCalls } = await import("../src/lib/store");
const { startCall, reconcileStaleCalls, isSpoken } = await import("../src/lib/calls");
const { enableEmbed, checkEmbedGate } = await import("../src/lib/embed");
const {
  checkDemoGate,
  checkConsoleGate,
  maxCallSeconds,
  callsToday,
  CONSOLE_CALLS_PER_DAY,
} = await import("../src/lib/demo");
const { twilioSignatureValid } = await import("../src/lib/voice/twilio-signature");
const { closeEpisode, ADAPTERS } = await import("../src/lib/reception/respond");
const { metaAdapter } = await import("../src/lib/reception/channel/meta");
const { twilioAdapter } = await import("../src/lib/reception/channel/twilio");
const { BELLINE_LOCATION_ID } = await import("../src/lib/seed-belline");

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

function head(title: string) {
  console.log(`\n\x1b[1m${title}\x1b[0m\n`);
}

seedIfEmpty();

const signed = await signUp({
  businessName: "Guarded Salon",
  email: "owner@guarded.test",
  password: "Correct-Horse-Battery-9",
  timezone: "Asia/Dubai",
  vertical: "salon",
});
if (!signed.ok) throw new Error("could not create the test venue");

// ---------------------------------------------------------------------------
head("The widget's ceilings, where the call actually starts");

await test("the socket gate for a customer's widget is the widget's own cap", () => {
  const venue = enableEmbed(getLocation(signed.location.id)!, ["https://guarded.test"], {
    maxCallsPerDay: 2,
  });
  for (let i = 0; i < 2; i++) saveCall(startCall(venue, "embed", "website"));
  const fresh = getLocation(venue.id)!;
  // What the socket used to ask: a demo gate, which has nothing to say about a
  // venue that is not a demo — allowed, limit 0.
  assert.equal(checkDemoGate(fresh).allowed, true, "checkDemoGate is not the widget's gate");
  // What it asks now.
  assert.equal(checkEmbedGate(fresh).allowed, false, "two calls with a cap of two was not enough");
});

await test("the widget's per-call ceiling applies to the widget and not the telephone", () => {
  const venue = enableEmbed(getLocation(signed.location.id)!, ["https://guarded.test"], {
    maxCallSeconds: 60,
  });
  assert.equal(maxCallSeconds(venue, "embed"), 60, "the configured cap was not enforced");
  assert.equal(
    maxCallSeconds(venue, "phone"),
    venue.agent.maxCallSeconds,
    "a stranger's cap was applied to a real caller",
  );
  assert.equal(maxCallSeconds(venue, "browser"), venue.agent.maxCallSeconds);
});

await test("the test console does not spend the widget's cap", () => {
  const venue = enableEmbed(getLocation(signed.location.id)!, ["https://guarded.test"], {
    maxCallsPerDay: 1,
  });
  for (let i = 0; i < 5; i++) saveCall(startCall(venue, "browser", "browser-console"));
  assert.equal(
    checkEmbedGate(getLocation(venue.id)!).used,
    2,
    "staff testing their agent switched their own widget off",
  );
});

await test("the test console has a ceiling of its own", () => {
  const venue = getLocation(signed.location.id)!;
  const before = checkConsoleGate(venue).used;
  for (let i = before; i < CONSOLE_CALLS_PER_DAY; i++) {
    saveCall(startCall(venue, "browser", "browser-console"));
  }
  const gate = checkConsoleGate(getLocation(venue.id)!);
  assert.equal(gate.allowed, false, "a signup could run calls at our cost for ever");
  assert.ok(gate.message && !/limit|quota|cap/i.test(gate.message), gate.message);
});

// ---------------------------------------------------------------------------
head("Our own demo line");

await test("a demo call through the browser counts toward the demo cap", () => {
  // The bell on the front page. The socket flags these as demos now; before,
  // only the telephone path did, and seventy calls through the bell counted
  // as none.
  const belline = getLocation(BELLINE_LOCATION_ID)!;
  const before = callsToday(belline);
  const call = startCall(belline, "browser", "bell");
  call.isDemo = true;
  saveCall(call);
  assert.equal(callsToday(getLocation(BELLINE_LOCATION_ID)!), before + 1);
});

await test("the demo cap closes the line when reached", () => {
  const belline = getLocation(BELLINE_LOCATION_ID)!;
  for (let i = callsToday(belline); i < belline.demo!.maxCallsPerDay; i++) {
    const call = startCall(belline, "browser", "bell");
    call.isDemo = true;
    saveCall(call);
  }
  assert.equal(checkDemoGate(getLocation(BELLINE_LOCATION_ID)!).allowed, false);
});

// ---------------------------------------------------------------------------
head("Twilio's signature, without a token");

const url = "https://app.belline.ai/api/twilio/voice";
const params = { To: "+15717785920", From: "+971501234567", CallSid: "CA1" };

await test("a missing token refuses in production", () => {
  assert.equal(
    twilioSignatureValid(url, params, "anything", { token: undefined, production: true }),
    false,
    "a lost environment variable opened metered calls to every venue",
  );
});

await test("a missing token is tolerated in development, so the thing can be run locally", () => {
  assert.equal(twilioSignatureValid(url, params, null, { token: undefined, production: false }), true);
});

await test("with a token, a wrong signature is refused and a right one accepted", async () => {
  const crypto = await import("node:crypto");
  const token = "test-auth-token";
  const payload = url + Object.keys(params).sort().map((k) => k + params[k as keyof typeof params]).join("");
  const good = crypto.createHmac("sha1", token).update(payload, "utf8").digest("base64");
  assert.equal(twilioSignatureValid(url, params, good, { token, production: true }), true);
  assert.equal(twilioSignatureValid(url, params, "bad", { token, production: true }), false);
  assert.equal(twilioSignatureValid(url, params, null, { token, production: true }), false);
});

// ---------------------------------------------------------------------------
head("Episodes that are not calls");

await test("the boot sweep leaves message threads alone", () => {
  const venue = getLocation(signed.location.id)!;
  const thread = startCall(venue, "whatsapp", "+971509990009");
  const chat = startCall(venue, "webchat", "Website");
  const line = startCall(venue, "phone", "+971509990010");
  reconcileStaleCalls();
  assert.equal(getCall(thread.id)!.status, "active", "an open WhatsApp thread was marked interrupted");
  assert.equal(getCall(chat.id)!.status, "active", "an open website chat was marked interrupted");
  assert.equal(getCall(line.id)!.status, "failed", "a call the server died under was left active");
  assert.equal(isSpoken("embed"), true);
  assert.equal(isSpoken("webchat"), false);
});

await test("closing a conversation completes its episode", () => {
  const venue = getLocation(signed.location.id)!;
  const thread = startCall(venue, "webchat", "Website");
  closeEpisode(thread.id, "Closed by a test.");
  const done = getCall(thread.id)!;
  assert.equal(done.status, "completed");
  assert.ok(done.endedAt, "no end time");
  assert.equal(done.summary, "Closed by a test.");
  // Idempotent: closing twice does not overwrite what the first close wrote.
  closeEpisode(thread.id, "Closed again.");
  assert.equal(getCall(thread.id)!.summary, "Closed by a test.");
});

// ---------------------------------------------------------------------------
head("Every provider has an adapter, and receipts know their number");

await test("the registry covers every provider the type allows", () => {
  // Two registries drifted once; this is what stops the one that is left from
  // drifting from the type. A provider added to the union without an adapter
  // fails here rather than as a 500 in the inbox.
  const providers = ["meta", "twilio", "internal", "webchat"] as const;
  for (const p of providers) {
    assert.ok(ADAPTERS[p], `no adapter for ${p}`);
    assert.equal(ADAPTERS[p].provider, p);
  }
});

await test("a Meta receipt carries the number it is about", () => {
  const { statuses } = metaAdapter.parse(
    JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { display_phone_number: "15550001111", phone_number_id: "PNID1" },
                statuses: [{ id: "wamid.R1", status: "delivered", timestamp: "1700000000" }],
              },
            },
          ],
        },
      ],
    }),
  );
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].toE164, "+15550001111");
  assert.equal(statuses[0].externalNumberId, "PNID1");
});

await test("a Twilio receipt carries the number it went out on", () => {
  const body = new URLSearchParams({
    MessageSid: "SM1",
    MessageStatus: "read",
    From: "whatsapp:+15550002222",
    To: "whatsapp:+971509990009",
  }).toString();
  const { statuses } = twilioAdapter.parse(body);
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].toE164, "+15550002222");
});

// ---------------------------------------------------------------------------

void listCalls;
fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });

console.log(
  failed === 0
    ? `\n\x1b[32m✓ ${passed} passed, 0 failed\x1b[0m\n`
    : `\n\x1b[31m✗ ${passed} passed, ${failed} failed\x1b[0m\n`,
);
process.exit(failed === 0 ? 0 : 1);

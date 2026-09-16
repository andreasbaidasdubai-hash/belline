/**
 * Feature flags and the stub layer: which env turns what on, and the guards
 * that keep fake providers away from production.
 *
 *   npm run check:flags
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import Stripe from "stripe";

import { FLAG_NAMES, allFlags, assertStubsSafe, flag, flagEnvKey, flagState } from "../src/lib/flags";
import {
  BlockedFetchError,
  blockedFetches,
  fakeGoogleCalendar,
  fakeGraph,
  fakeModel,
  fakeNumberPool,
  fakeStripe,
  installFetchGuard,
  installStubs,
  removeFetchGuard,
  signWebhook,
  stubMailer,
  stubPoolFromEnv,
  toolReply,
} from "../src/lib/testing/stubs";

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

const PROD_URL = "postgres://belline:secret@prod-db.invalid:5432/belline";
const LOCAL_URL = "postgres://nobody:nothing@disabled.invalid:5432/none";

console.log("\n\x1b[1mFlags\x1b[0m\n");

await test("with no env, every flag is off", () => {
  const states = allFlags({});
  assert.equal(states.length, FLAG_NAMES.length);
  assert.deepEqual(states.filter((s) => s.on).map((s) => s.name), []);
  assert.equal(flag("booking.partner.fresha", {}), false);
});

await test("the env key follows the flag name", () => {
  assert.equal(flagEnvKey("channel.whatsapp.selfserve"), "FLAG_CHANNEL_WHATSAPP_SELFSERVE");
  assert.equal(flagEnvKey("booking.partner.seven-rooms"), "FLAG_BOOKING_PARTNER_SEVEN_ROOMS");
});

await test("a flag with its credentials is on, and FLAG_<NAME>=off turns it off", () => {
  const env = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x" };
  assert.equal(flag("billing.stripe", env), true);
  assert.deepEqual(flagState("billing.stripe", { ...env, FLAG_BILLING_STRIPE: "off" }).reason, "disabled");
});

await test("half the credentials is off, and names what is missing without values", () => {
  const state = flagState("billing.stripe", { STRIPE_SECRET_KEY: "sk_test_x", FLAG_BILLING_STRIPE: "on" });
  assert.equal(state.on, false);
  assert.equal(state.reason, "missing_credentials");
  assert.deepEqual(state.missing, ["STRIPE_WEBHOOK_SECRET"]);
});

await test("an approval flag stays off with credentials until FLAG_<NAME>=on", () => {
  const env = { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s", CREDENTIALS_KEY: "k" };
  assert.equal(flagState("booking.google", env).reason, "needs_approval");
  assert.equal(flag("booking.google", { ...env, FLAG_BOOKING_GOOGLE: "on" }), true);
  assert.equal(flag("lifecycle.send", { RESEND_API_KEY: "re_x" }), false);
  assert.equal(flag("email.transactional", { RESEND_API_KEY: "re_x" }), true);
});

await test("clinic self-serve opens only by explicit choice", () => {
  assert.equal(flag("vertical.clinic.selfserve", {}), false);
  assert.equal(flag("vertical.clinic.selfserve", { FLAG_VERTICAL_CLINIC_SELFSERVE: "on" }), true);
});

await test("WhatsApp self-serve needs Meta credentials and the explicit switch", () => {
  assert.equal(flag("channel.whatsapp.selfserve", { FLAG_CHANNEL_WHATSAPP_SELFSERVE: "on" }), false);
  const env = { WHATSAPP_ACCESS_TOKEN: "t", WHATSAPP_BUSINESS_ACCOUNT_ID: "w", CREDENTIALS_KEY: "k" };
  assert.equal(flag("channel.whatsapp.selfserve", env), false);
  assert.equal(flag("channel.whatsapp.selfserve", { ...env, FLAG_CHANNEL_WHATSAPP_SELFSERVE: "on" }), true);
});

await test("a partner flag needs that partner's own key and the switch", () => {
  assert.deepEqual(flagState("booking.partner.fresha", { FLAG_BOOKING_PARTNER_FRESHA: "on" }).missing, ["PARTNER_FRESHA_API_KEY"]);
  assert.equal(flag("booking.partner.fresha", { FLAG_BOOKING_PARTNER_FRESHA: "on", PARTNER_FRESHA_API_KEY: "k" }), true);
});

console.log("\n\x1b[1mStub guard\x1b[0m\n");

await test("stubs turn on locally with no database or the disabled one", () => {
  assert.equal(flag("stubs", { FLAG_STUBS: "on" }), true);
  assert.equal(flag("stubs", { FLAG_STUBS: "on", DATABASE_URL: LOCAL_URL }), true);
  assert.equal(flag("stubs", { FLAG_STUBS: "on", DATABASE_URL: "postgres://u:p@localhost:5432/t" }), true);
});

await test("FLAG_STUBS=on with NODE_ENV=production throws at boot and stays off", () => {
  const env = { FLAG_STUBS: "on", NODE_ENV: "production" };
  assert.throws(() => assertStubsSafe(env), /NODE_ENV is production/);
  assert.throws(() => installStubs(env), /NODE_ENV is production/);
  assert.equal(flagState("stubs", env).reason, "unsafe");
  assert.equal(blockedFetches().length, 0);
});

await test("FLAG_STUBS=on next to a real database throws, even one whose name contains localhost", () => {
  assert.throws(() => assertStubsSafe({ FLAG_STUBS: "on", DATABASE_URL: PROD_URL }), /DATABASE_URL/);
  assert.throws(() => assertStubsSafe({ FLAG_STUBS: "on", DATABASE_URL: "postgres://u:p@localhost.evil.example/db" }), /DATABASE_URL/);
  assert.throws(() => assertStubsSafe({ FLAG_STUBS: "on", DATABASE_URL: "not a url" }), /DATABASE_URL/);
});

await test("under stubs a capability still has to be asked for, then needs no real credentials", () => {
  const env = { FLAG_STUBS: "on", DATABASE_URL: LOCAL_URL };
  assert.equal(flag("numbers.pool", env), false);
  assert.equal(flag("numbers.pool", { ...env, FLAG_NUMBERS_POOL: "on" }), true);
  assert.equal(flag("lifecycle.send", { ...env, FLAG_LIFECYCLE_SEND: "off" }), false);
  // Unsafe stubs lend nothing: the flag falls back to the real credential rule.
  assert.equal(flag("numbers.pool", { FLAG_STUBS: "on", DATABASE_URL: PROD_URL, FLAG_NUMBERS_POOL: "on" }), false);
});

await test("without FLAG_STUBS, installStubs does nothing", () => {
  assert.equal(installStubs({}), false);
});

await test("with stubs on, fetch to a provider throws and fetch to this machine works", async () => {
  const server = http.createServer((_req, res) => res.end("local ok"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    assert.equal(installStubs({ FLAG_STUBS: "on", DATABASE_URL: LOCAL_URL }), true);
    for (const url of ["https://api.stripe.com/v1/customers", "https://graph.facebook.com/v21.0/x", "https://api.anthropic.com/v1/messages"]) {
      await assert.rejects(fetch(url, { method: "POST" }), BlockedFetchError);
    }
    await assert.rejects(fetch(new URL("https://api.resend.com/emails")), /api\.resend\.com/);
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), "local ok");
    assert.equal(await (await fetch(`http://localhost:${port}/`)).text(), "local ok");
    assert.deepEqual(blockedFetches(), ["api.stripe.com", "graph.facebook.com", "api.anthropic.com", "api.resend.com"]);
  } finally {
    removeFetchGuard();
    server.close();
  }
});

await test("installing the guard twice keeps one wrapper", async () => {
  const before = globalThis.fetch;
  installFetchGuard();
  const once = globalThis.fetch;
  installFetchGuard();
  assert.equal(globalThis.fetch, once);
  removeFetchGuard();
  assert.equal(globalThis.fetch, before);
});

console.log("\n\x1b[1mFake providers\x1b[0m\n");

await test("the fake model replies in script order, records requests, and fails when it runs out", async () => {
  const model = fakeModel([toolReply("record_business", { name: "Salon" }), (p) => toolReply("echo", { max: p.max_tokens })]);
  const params = { model: "stub", max_tokens: 7, messages: [] } as never;
  assert.deepEqual((await model.call(params)).content[0].input, { name: "Salon" });
  assert.deepEqual((await model.call(params)).content[0].input, { max: 7 });
  await assert.rejects(model.call(params), /no scripted reply/);
  assert.equal(model.calls.length, 3);
});

await test("the fake Graph accepts code 123456 and refuses any other", async () => {
  const { graph, posts } = fakeGraph();
  assert.equal((await graph.post("WABA/phone_numbers", { cc: "971" })).body.id, "stub_phone_1");
  assert.equal((await graph.post("stub_phone_1/verify_code", { code: "123456" })).ok, true);
  const bad = await graph.post("stub_phone_1/verify_code", { code: "000000" });
  assert.equal(bad.ok, false);
  assert.ok(bad.body.error?.message);
  assert.equal(posts.length, 3);
});

await test("the number pool hands out distinct numbers and then none", () => {
  const pool = fakeNumberPool(stubPoolFromEnv({ STUB_POOL: "+97140000001, +97140000002" }));
  const a = pool.claim("loc_a", "http://localhost/api/twilio/voice");
  const b = pool.claim("loc_b", "http://localhost/api/twilio/voice");
  assert.notEqual(a, b);
  assert.equal(pool.claim("loc_a", "x"), a);
  assert.equal(pool.claim("loc_c", "x"), null);
  pool.release("loc_a");
  assert.equal(pool.claim("loc_c", "x"), a);
});

await test("fake Stripe checkout points back at this server, and its webhook signature passes the real verifier", async () => {
  const stripe = fakeStripe("http://localhost:3000/");
  const session = await stripe.checkout.sessions.create({ mode: "subscription" });
  assert.match(session.url, /^http:\/\/localhost:3000\/__stub\/stripe\/checkout\?session=cs_test_stub_/);
  const payload = JSON.stringify({ id: "evt_stub", object: "event", type: "checkout.session.completed", data: { object: { id: session.id } } });
  const real = new Stripe("sk_test_stub_never_used");
  const event = real.webhooks.constructEvent(payload, signWebhook(payload, "whsec_stub"), "whsec_stub");
  assert.equal(event.type, "checkout.session.completed");
  assert.throws(() => real.webhooks.constructEvent(payload, signWebhook(payload, "whsec_other"), "whsec_stub"));
});

await test("fake Google reports busy blocks and writing the same event twice keeps one", async () => {
  const google = fakeGoogleCalendar();
  google.addBusy("primary", "2027-01-05T10:00:00Z", "2027-01-05T11:00:00Z");
  await google.upsertEvent("primary", { id: "bellinebk1", start: "2027-01-05T14:00:00Z", end: "2027-01-05T15:00:00Z" });
  await google.upsertEvent("primary", { id: "bellinebk1", start: "2027-01-05T14:00:00Z", end: "2027-01-05T15:00:00Z", summary: "again" });
  assert.equal(google.events("primary").length, 1);
  assert.equal((await google.freeBusy("primary", "2027-01-05T00:00:00Z", "2027-01-06T00:00:00Z")).length, 2);
  assert.equal((await google.freeBusy("primary", "2027-01-05T12:00:00Z", "2027-01-05T13:00:00Z")).length, 0);
});

await test("the stub mailer writes to the outbox and nowhere else", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "belline-flags-"));
  try {
    const mailer = stubMailer(dir);
    assert.deepEqual(await mailer.send({ to: "owner@example.test", subject: "Reset", html: "<a>link</a>", text: "link" }), { sent: true });
    assert.equal(mailer.read()[0].subject, "Reset");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log(
  failed === 0 ? `\n\x1b[32m✓ ${passed} passed, 0 failed\x1b[0m\n` : `\n\x1b[31m✗ ${passed} passed, ${failed} failed\x1b[0m\n`,
);
if (failed > 0) process.exitCode = 1;

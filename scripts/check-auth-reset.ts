/**
 * Forgot password.
 *
 * The link works once, for 30 minutes, and only the latest one works. Setting
 * a new password signs every other session out. An unknown address gets the
 * same sentence in the same time band. With email off, nothing is sent and
 * the team gets a recovery ticket instead. The mailer is the outbox stub:
 * nothing reaches Resend.
 *
 *   npm run check:auth-reset
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-auth-reset-"));
for (const k of Object.keys(process.env)) if (k.startsWith("FLAG_") || k === "RESEND_API_KEY" || k === "DATABASE_URL") delete process.env[k];
// Stubs on, and email asked for by name: the reset email goes to the outbox.
process.env.FLAG_STUBS = "on";
process.env.FLAG_EMAIL_TRANSACTIONAL = "on";

const realFetch = globalThis.fetch;
let fetches = 0;
globalThis.fetch = (async () => {
  fetches++;
  throw new Error("network is off in check:auth-reset");
}) as typeof fetch;

const { seedIfEmpty } = await import("../src/lib/seed");
const { signUp } = await import("../src/lib/onboarding");
const { consumeResetToken, login, peekResetToken, signLoginToken, signResetToken, consumeLoginToken, userForSession, RESET_LINK_MINUTES } =
  await import("../src/lib/auth");
const { findUserByEmail, saveUser, getUser } = await import("../src/lib/store");
const { FORGOT_RESPONSE_MS, createForgotLimiter, padTo, requestPasswordReset, resetMode, resetRequestedMessage } = await import("../src/lib/auth-reset");
const { outboxFile, realEmailOn } = await import("../src/lib/mailer");
const { listExceptions } = await import("../src/lib/exceptions");

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

const ROOT = path.resolve(import.meta.dirname, "..");
const source = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const outbox = () =>
  fs.existsSync(outboxFile())
    ? fs.readFileSync(outboxFile(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { to: string; subject: string; text: string })
    : [];
const fresh = () => createForgotLimiter();
const quiet = <T>(fn: () => T): T => {
  const original = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = original;
  }
};

seedIfEmpty();
const EMAIL = "owner@reset-salon.test";
const OLD = "Correct-Horse-Battery-9";
const NEW = "Staple-Lantern-Orbit-42";
const made = await signUp({ businessName: "Reset Salon", email: EMAIL, password: OLD, vertical: "salon" });
assert.ok(made.ok);

async function linkFromOutbox(): Promise<string> {
  const out = requestPasswordReset({ email: EMAIL, peer: "1.2.3.4", limiter: fresh() });
  assert.equal(out.outcome, "sent");
  await out.work;
  const mail = outbox().at(-1)!;
  assert.equal(mail.to, EMAIL);
  const m = /\/login\/reset\?t=([^\s"<]+)/.exec(mail.text);
  assert.ok(m, mail.text);
  return decodeURIComponent(m![1]);
}

console.log("\n\x1b[1mThe link\x1b[0m\n");

await test("with email on under stubs, the reset email lands in the outbox and nothing reaches the network", async () => {
  assert.equal(resetMode(), "email");
  assert.equal(realEmailOn(), false);
  await linkFromOutbox();
  assert.match(outbox().at(-1)!.text, new RegExp(`${RESET_LINK_MINUTES} minutes`));
  assert.equal(fetches, 0);
});

await test("opening the page does not use the link up; a weak password leaves it working", async () => {
  const token = await linkFromOutbox();
  assert.ok(peekResetToken(token));
  assert.ok(peekResetToken(token), "peeking twice still valid");
  const weak = consumeResetToken(token, "short");
  assert.equal(weak.ok, false);
  assert.equal(weak.ok ? "" : weak.field, "password");
  assert.ok(peekResetToken(token));
});

await test("a reset signs out every old session, signs this browser in, and the link is single-use", async () => {
  const before = login(EMAIL, OLD);
  assert.ok(before.ok);
  const oldSession = before.ok ? before.session.id : "";
  assert.ok(userForSession(oldSession));
  const token = await linkFromOutbox();
  const out = consumeResetToken(token, NEW, "check");
  assert.ok(out.ok, out.ok ? "" : out.error);
  assert.equal(userForSession(oldSession), null, "old session still works");
  assert.ok(out.ok && userForSession(out.session.id));
  assert.equal(login(EMAIL, OLD).ok, false);
  assert.ok(login(EMAIL, NEW).ok);
  const again = consumeResetToken(token, "Another-Strong-Pass-77");
  assert.equal(again.ok, false);
  assert.equal(again.ok ? "" : again.field, "token");
});

await test("the link expires after 30 minutes", () => {
  const user = findUserByEmail(EMAIL)!;
  const t0 = Date.now();
  const token = signResetToken(user, t0);
  assert.ok(peekResetToken(token, t0 + 29 * 60_000));
  assert.equal(peekResetToken(token, t0 + 31 * 60_000), null);
  assert.equal(consumeResetToken(token, "Another-Strong-Pass-77", undefined, t0 + 31 * 60_000).ok, false);
});

await test("asking again makes the earlier link stop working", async () => {
  const first = await linkFromOutbox();
  const second = await linkFromOutbox();
  assert.equal(peekResetToken(first), null);
  assert.ok(peekResetToken(second));
});

await test("a sign-in link is not a reset link, and a reset link is not a sign-in link", () => {
  const user = findUserByEmail(EMAIL)!;
  const login = signLoginToken(user);
  assert.equal(peekResetToken(login), null);
  const reset = signResetToken(getUser(user.id)!);
  assert.equal(consumeLoginToken(reset), null);
  assert.equal(peekResetToken(reset.slice(0, -2) + "xx"), null, "a forged signature");
});

await test("a reset also cancels an outstanding sign-in link", async () => {
  const user = findUserByEmail(EMAIL)!;
  const signIn = signLoginToken(user);
  const token = await linkFromOutbox();
  assert.ok(consumeResetToken(token, "Brand-New-Secret-2026").ok);
  assert.equal(consumeLoginToken(signIn), null);
});

console.log("\n\x1b[1mNothing to learn from the form\x1b[0m\n");

await test("an unknown address sends nothing and gets the same sentence", async () => {
  const before = outbox().length;
  const out = requestPasswordReset({ email: "nobody@nowhere.test", peer: "1.2.3.4", limiter: fresh() });
  assert.equal(out.outcome, "unknown");
  await out.work;
  assert.equal(outbox().length, before);
  // The sentence is a function of the mode alone.
  assert.equal(resetRequestedMessage.length, 1);
  assert.ok(!/nobody|not found|no account/i.test(resetRequestedMessage("email")));
});

await test("known and unknown addresses answer in the same time band", async () => {
  const time = async (email: string) => {
    const started = Date.now();
    const out = requestPasswordReset({ email, peer: "5.6.7.8", limiter: fresh() });
    void out.work;
    await padTo(started);
    return Date.now() - started;
  };
  const known = await time(EMAIL);
  const unknown = await time("ghost@nowhere.test");
  assert.ok(known >= FORGOT_RESPONSE_MS - 5 && unknown >= FORGOT_RESPONSE_MS - 5, `${known} ${unknown}`);
  assert.ok(Math.abs(known - unknown) < 150, `${known} vs ${unknown}`);
});

await test("a disabled account is treated as unknown", () => {
  const user = findUserByEmail(EMAIL)!;
  saveUser({ ...user, disabled: true });
  assert.equal(requestPasswordReset({ email: EMAIL, peer: "1.2.3.4", limiter: fresh() }).outcome, "unknown");
  saveUser({ ...getUser(user.id)!, disabled: false });
});

await test("rate limited per address and per network address", () => {
  const limiter = createForgotLimiter({ perEmail: 3, perPeer: 4, windowMs: 60_000 });
  const now = Date.now();
  const outcomes = [1, 2, 3, 4].map(() => requestPasswordReset({ email: "ghost@nowhere.test", peer: "9.9.9.9", limiter, now }).outcome);
  assert.deepEqual(outcomes, ["unknown", "unknown", "unknown", "limited"]);
  assert.equal(requestPasswordReset({ email: "other@nowhere.test", peer: "9.9.9.9", limiter, now }).outcome, "limited", "peer bucket");
  assert.equal(requestPasswordReset({ email: "third@nowhere.test", peer: "8.8.8.8", limiter, now }).outcome, "unknown");
  assert.equal(requestPasswordReset({ email: "ghost@nowhere.test", peer: "7.7.7.7", limiter, now: now + 61_000 }).outcome, "unknown", "window passes");
});

console.log("\n\x1b[1mEmail switched off\x1b[0m\n");

await test("with email off, no link is made; the team gets one recovery ticket per person", async () => {
  const env = { FLAG_STUBS: "on" } as Record<string, string>;
  assert.equal(resetMode(env), "team");
  const user = findUserByEmail(EMAIL)!;
  const nonce = getUser(user.id)!.resetNonce;
  const before = outbox().filter((m) => m.to === EMAIL).length;
  const one = quiet(() => requestPasswordReset({ email: EMAIL, peer: "1.2.3.4", limiter: fresh(), env }));
  quiet(() => requestPasswordReset({ email: EMAIL, peer: "1.2.3.4", limiter: fresh(), env }));
  assert.equal(one.outcome, "team");
  await one.work;
  assert.equal(outbox().filter((m) => m.to === EMAIL).length, before, "a reset email was written");
  assert.equal(getUser(user.id)!.resetNonce, nonce, "a token was issued");
  const rows = listExceptions({ kind: "account_recovery" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 2);
  assert.equal(rows[0].context.userId, user.id);
  assert.match(resetRequestedMessage("team"), /team will write to it/);
});

console.log("\n\x1b[1mRoutes and screens\x1b[0m\n");

await test("the forgot route always answers 200 with the mode's sentence, after the minimum time", () => {
  const route = source("src/app/api/auth/forgot/route.ts");
  assert.match(route, /await padTo\(started\)/);
  assert.match(route, /resetRequestedMessage\(resetMode\(\)\)/);
  assert.ok(!/outcome/.test(route.replace(/\/\*[\s\S]*?\*\//g, "")), "the route must not branch on the outcome");
  assert.match(route, /clientKey\(request\.headers\)/);
});

await test("the reset route uses the link up; the page only reads it", () => {
  assert.match(source("src/app/api/auth/reset/route.ts"), /consumeResetToken\(/);
  const page = source("src/app/login/reset/page.tsx");
  assert.match(page, /peekResetToken\(/);
  assert.ok(!page.includes("consumeResetToken"));
});

await test("the sign-in form links to forgot password; the forgot page says what happens in each mode", () => {
  assert.match(source("src/app/login/LoginForm.tsx"), /\/login\/forgot/);
  const form = source("src/app/login/forgot/ForgotForm.tsx");
  assert.match(form, /Send me a link/);
  assert.match(form, /Ask for help/);
});

globalThis.fetch = realFetch;
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);

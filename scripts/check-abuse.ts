/**
 * Free trials farmed with fake accounts, and the owners who must never be
 * caught by what stops them.
 *
 *   the 6-digit code: expiry, tries, resend and change-email limits
 *   paid work (import, Belle, checks, a number, test calls, Go live) refused
 *     until the email is confirmed, and email off never strands anybody
 *   throwaway mailboxes refused, with a staff override
 *   the domain and phone normalisers
 *   one trial per business by domain, phone or card, and the staff override
 *   the card at Go live with `billing.stripe` on (the stub Stripe) and off
 *   trial caps that belong to the business, not the login
 *   per-network and per-browser trial limits
 *   accounts that predate all of this are untouched
 *
 * Stubs on, a fresh data directory, the network off, email to the outbox.
 *
 *   npm run check:abuse
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-abuse-"));
for (const k of Object.keys(process.env)) {
  if (k.startsWith("FLAG_") || ["RESEND_API_KEY", "DATABASE_URL", "STRIPE_SECRET_KEY", "ANTHROPIC_API_KEY"].includes(k)) delete process.env[k];
}
process.env.FLAG_STUBS = "on";
process.env.FLAG_EMAIL_TRANSACTIONAL = "on";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_check_abuse";

let fetches = 0;
globalThis.fetch = (async () => {
  fetches++;
  throw new Error("network is off in check:abuse");
}) as typeof fetch;

const { seedIfEmpty } = await import("../src/lib/seed");
const { signUp } = await import("../src/lib/onboarding");
const store = await import("../src/lib/store");
const { getLocation, getTenant, getUser, upsertLocation, saveTenant, saveCall, listAbuseRows } = store;
const verify = await import("../src/lib/email-verify");
const { outboxFile } = await import("../src/lib/mailer");
const { normaliseDomain, normalisePhone, isDisposableEmail } = await import("../src/lib/abuse/business-key");
const review = await import("../src/lib/abuse/review");
const { paidWorkRefusal, verifyRefusal } = await import("../src/lib/abuse/gate");
const { listExceptions } = await import("../src/lib/exceptions");
const { configDigest } = await import("../src/lib/onboarding/selftest-state");
const { activateVenue } = await import("../src/lib/onboarding/activate");
const { handleStripeWebhook } = await import("../src/lib/billing/webhook");
const card = await import("../src/lib/billing/card");
const stubs = await import("../src/lib/testing/stubs");
const { lapseOf, serviceState } = await import("../src/lib/billing/entitlement");
const { startCall } = await import("../src/lib/calls");
const { consumeLoginToken, signLoginToken } = await import("../src/lib/auth");
const { draftFromRequest } = await import("../src/lib/onboarding/uploads");
const { TRIAL } = await import("../src/lib/billing/plans");
const { todayIn } = await import("../src/lib/time");
type Loc = import("../src/lib/types").Location;

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${err instanceof Error ? err.message.replace(/\s+/g, " ") : String(err)}`);
    failed++;
  }
}

const ROOT = path.resolve(import.meta.dirname, "..");
const source = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const outbox = () =>
  fs.existsSync(outboxFile())
    ? fs.readFileSync(outboxFile(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { to: string; subject: string; text: string })
    : [];
const codeFor = (email: string) => {
  const mail = outbox().filter((m) => m.to === email).pop();
  return /code is (\d{6})/.exec(mail?.text ?? "")?.[1] ?? "";
};
const PASSWORD = "Correct-Horse-Battery-9";
const minutes = (n: number) => n * 60_000;
let seq = 0;

async function selfServe(name: string, opts: { ip?: string; device?: string; email?: string } = {}) {
  seq++;
  const out = await signUp({
    businessName: name,
    email: opts.email ?? `owner${seq}@abuse-${seq}.test`,
    password: PASSWORD,
    vertical: "salon",
    selfServe: { ip: opts.ip ?? `10.0.${seq}.1`, device: opts.device ?? `device-abuse-${seq}-xxxxxxxx` },
  });
  assert.ok(out.ok, out.ok ? "" : out.error);
  return out.ok ? out : null!;
}

/** Every step before Go live done, the checks passed against the setup as it is. */
function ready(l: Loc, site: string, extra: Partial<Loc> = {}): Loc {
  const at = new Date().toISOString();
  const base: Loc = {
    ...l,
    ...extra,
    address: "Shop 4, Jumeirah Beach Road, Dubai",
    agent: { ...l.agent, faqs: [{ q: "Is there parking?", a: "Yes, behind the building." }] },
    onboarding: {
      version: 1,
      channels: { web: { domains: [site], detectedAt: at } },
      reviewedAt: at,
      destination: { kind: "requests", setAt: at },
      rulesConfirmedAt: at,
    },
  };
  return { ...base, onboarding: { ...base.onboarding!, tests: { runId: "run_abuse", at, results: [], passed: true, digest: configDigest(base) } } };
}

seedIfEmpty();

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n\x1b[1mThe 6-digit code\x1b[0m\n");

const alpha = await selfServe("Code Salon");
const alphaId = alpha.user.id;
const t0 = new Date("2031-03-01T09:00:00Z");

await test("a self-serve signup must confirm its email; an account made any other way is grandfathered", async () => {
  assert.equal(verify.needsEmailVerification(getUser(alphaId)), true);
  const internal = await signUp({ businessName: "Old Way Salon", email: "owner@old-way.test", password: PASSWORD, vertical: "salon" });
  assert.ok(internal.ok);
  assert.equal(verify.needsEmailVerification(internal.ok ? internal.user : null), false);
  assert.equal(getTenant(internal.ok ? internal.user.tenantId : "")!.signup, undefined);
  // What production's existing users look like: no verification record at all.
  assert.equal(verify.needsEmailVerification({ emailVerification: undefined, emailVerifiedAt: undefined }), false);
});

await test("a code goes to the outbox, never to Resend, and only its hash is stored", async () => {
  const sent = verify.sendVerificationCode(alphaId, { now: t0 });
  assert.ok(sent.ok && sent.mode === "email");
  if (sent.ok) await sent.delivery;
  const code = codeFor(alpha.user.email);
  assert.match(code, /^\d{6}$/);
  const stored = JSON.stringify(getUser(alphaId));
  assert.ok(!stored.includes(code), "the code itself was stored");
  assert.equal(fetches, 0);
});

await test("a new code at most once a minute", () => {
  const again = verify.sendVerificationCode(alphaId, { now: new Date(t0.getTime() + 20_000) });
  assert.ok(!again.ok && again.status === 429);
  assert.match(again.ok ? "" : again.error, /40 seconds/);
});

await test("a wrong code uses a try and says how many are left; the fifth uses the code up", async () => {
  const s = verify.sendVerificationCode(alphaId, { now: new Date(t0.getTime() + minutes(2)) });
  assert.ok(s.ok);
  if (s.ok) await s.delivery;
  const right = codeFor(alpha.user.email);
  const wrong = right === "111112" ? "111113" : "111112";
  const at = new Date(t0.getTime() + minutes(3));
  const first = verify.checkVerificationCode(alphaId, wrong, { now: at });
  assert.ok(!first.ok && /4 tries left/.test(first.error), JSON.stringify(first));
  for (let i = 0; i < 4; i++) verify.checkVerificationCode(alphaId, wrong, { now: at });
  const late = verify.checkVerificationCode(alphaId, right, { now: at });
  assert.ok(!late.ok && late.status === 429, "the right code still worked after five wrong ones");
  assert.equal(verify.needsEmailVerification(getUser(alphaId)), true);
});

await test("a code expires after 15 minutes", async () => {
  const s = verify.sendVerificationCode(alphaId, { now: new Date(t0.getTime() + minutes(5)) });
  assert.ok(s.ok);
  if (s.ok) await s.delivery;
  const code = codeFor(alpha.user.email);
  const expired = verify.checkVerificationCode(alphaId, code, { now: new Date(t0.getTime() + minutes(5 + verify.CODE_MINUTES) + 1000) });
  assert.ok(!expired.ok && expired.status === 410 && /expired/.test(expired.error));
});

await test("five codes an hour, then a wait measured in minutes", () => {
  // Three sent so far this hour (2 min, 5 min, and the first).
  const s4 = verify.sendVerificationCode(alphaId, { now: new Date(t0.getTime() + minutes(21)) });
  const s5 = verify.sendVerificationCode(alphaId, { now: new Date(t0.getTime() + minutes(23)) });
  assert.ok(s4.ok && s5.ok);
  const s6 = verify.sendVerificationCode(alphaId, { now: new Date(t0.getTime() + minutes(25)) });
  assert.ok(!s6.ok && s6.status === 429 && /5 codes in an hour/.test(s6.error), JSON.stringify(s6));
  const later = verify.sendVerificationCode(alphaId, { now: new Date(t0.getTime() + minutes(62)) });
  assert.ok(later.ok, "still limited after the hour");
});

await test("the right code, in time, confirms the address and unlocks paid work", async () => {
  const at = new Date(t0.getTime() + minutes(63));
  const code = codeFor(alpha.user.email);
  assert.ok(verifyRefusal(getUser(alphaId)));
  const ok = verify.checkVerificationCode(alphaId, code, { now: at });
  assert.ok(ok.ok, ok.ok ? "" : ok.error);
  assert.equal(verify.needsEmailVerification(getUser(alphaId)), false);
  assert.equal(getUser(alphaId)!.emailVerification!.verifiedBy, "code");
  assert.equal(paidWorkRefusal(getUser(alphaId), getLocation(alpha.location.id)), null);
});

await test("a wrong address can be corrected: a throwaway, a taken or the same one is refused, three changes an hour", async () => {
  const beta = await selfServe("Typo Salon", { email: "owner@typo-salon.test" });
  const id = beta.user.id;
  const at = new Date("2031-04-01T09:00:00Z");
  const throwaway = verify.changeUnverifiedEmail(id, "someone@mailinator.com", { now: at });
  assert.ok(!throwaway.ok && /temporary email/.test(throwaway.error));
  const taken = verify.changeUnverifiedEmail(id, alpha.user.email, { now: at });
  assert.ok(!taken.ok && taken.status === 409);
  const same = verify.changeUnverifiedEmail(id, "owner@typo-salon.test", { now: at });
  assert.ok(!same.ok);
  const moved = verify.changeUnverifiedEmail(id, "owner@typo-salon-fixed.test", { now: at });
  assert.ok(moved.ok, JSON.stringify(moved));
  if (moved.ok) await moved.delivery;
  assert.equal(getUser(id)!.email, "owner@typo-salon-fixed.test");
  assert.equal(store.listBusinesses(beta.user.tenantId)[0].email, "owner@typo-salon-fixed.test");
  assert.match(codeFor("owner@typo-salon-fixed.test"), /^\d{6}$/);
  assert.ok(verify.changeUnverifiedEmail(id, "a1@typo-salon-fixed2.test", { now: new Date(at.getTime() + 1000) }).ok);
  assert.ok(verify.changeUnverifiedEmail(id, "a2@typo-salon-fixed3.test", { now: new Date(at.getTime() + 2000) }).ok);
  const fourth = verify.changeUnverifiedEmail(id, "a3@typo-salon-fixed4.test", { now: new Date(at.getTime() + 3000) });
  assert.ok(!fourth.ok && fourth.status === 429);
});

await test("a sign-in link from an email confirms the address too", async () => {
  const gamma = await selfServe("Link Salon");
  const user = consumeLoginToken(signLoginToken(getUser(gamma.user.id)!));
  assert.ok(user);
  assert.equal(verify.needsEmailVerification(getUser(gamma.user.id)), false);
  assert.equal(getUser(gamma.user.id)!.emailVerification!.verifiedBy, "link");
});

await test("with email off nobody is stranded: the team gets a ticket, and a staff confirmation clears both", async () => {
  delete process.env.FLAG_EMAIL_TRANSACTIONAL;
  try {
    const off = await selfServe("Email Off Salon");
    const sent = verify.sendVerificationCode(off.user.id);
    assert.ok(sent.ok && sent.mode === "team");
    assert.equal(outbox().filter((m) => m.to === off.user.email).length, 0, "a code was written with email off");
    const ticket = listExceptions({ kind: "email_unverified" }).find((e) => e.context.userId === off.user.id);
    assert.ok(ticket, "no email_unverified ticket");
    assert.match(verifyRefusal(getUser(off.user.id))!.error, /Belline team/);
    verify.markEmailVerified(off.user.id, "staff: Andreas");
    assert.equal(verify.needsEmailVerification(getUser(off.user.id)), false);
    const route = source("src/app/api/sales/abuse/route.ts");
    assert.match(route, /markEmailVerified\(user\.id/);
    assert.match(route, /kind: "email_unverified"[\s\S]{0,200}updateException/);
  } finally {
    process.env.FLAG_EMAIL_TRANSACTIONAL = "on";
  }
});

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n\x1b[1mPaid work waits for the confirmed address\x1b[0m\n");

const pending = await selfServe("Unconfirmed Salon");

await test("every route that spends money asks the gate first", () => {
  const gated: [string, RegExp][] = [
    ["src/app/api/setup/route.ts", /paidWorkRefusal\(user, venue\)[\s\S]*draftFromRequest\(req, \{\}, screen\)/],
    ["src/app/api/setup/assistant/route.ts", /paidWorkRefusal\(user[\s\S]*runSetupTurn\(/],
    ["src/app/api/setup/selftest/route.ts", /paidWorkRefusal\(auth\.user, location\)[\s\S]*runSelftest\(/],
    ["src/app/api/phone/number/route.ts", /paidWorkRefusal\(auth\.user, location\)[\s\S]*assignNumber\(/],
    ["src/app/api/voices/preview/route.ts", /verifyRefusal\(auth\.user\)[\s\S]*ttsEnabled\(\)/],
    ["server.ts", /pathname === "\/ws\/voice"[\s\S]{0,900}paidWorkRefusal\(user, consoleVenue\)[\s\S]{0,400}browserWss\.handleUpgrade/],
    ["src/lib/onboarding/activate.ts", /paidWorkRefusal\(getUser\(by\.id\), location/],
  ];
  for (const [file, pattern] of gated) assert.match(source(file), pattern, file);
});

await test("an unconfirmed owner is refused with the page that fixes it; setting up by hand is not paid work", () => {
  const refusal = paidWorkRefusal(getUser(pending.user.id), getLocation(pending.location.id));
  assert.ok(refusal);
  assert.equal(refusal!.status, 403);
  assert.equal(refusal!.fix, "/verify");
  assert.match(refusal!.error, /6-digit code/);
  assert.match(refusal!.error, /by hand/);
  // The review save (PUT /api/setup) checks for a duplicate business, never for the email.
  assert.doesNotMatch(source("src/app/api/setup/route.ts").split("export async function PUT")[1], /paidWorkRefusal|verifyRefusal/);
});

await test("Go live is refused for an unconfirmed owner even when every step is done", async () => {
  upsertLocation(ready(getLocation(pending.location.id)!, "https://unconfirmed-salon.test"));
  const out = await activateVenue(pending.location.id, getUser(pending.user.id)!);
  assert.ok(!out.ok && out.status === 403 && out.code === "email_unverified", JSON.stringify(out));
  assert.equal(getLocation(pending.location.id)!.onboarding!.activatedAt, undefined);
});

await test("a website another account has is refused before anything is read", async () => {
  let modelCalls = 0;
  const req = new Request("http://localhost/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ website: "https://www.code-salon-site.test" }) });
  const out = await draftFromRequest(
    req,
    {
      model: async () => {
        modelCalls++;
        throw new Error("the model was called");
      },
    },
    undefined,
    (website) => (website.includes("code-salon-site") ? { status: 409, body: { error: review.DUPLICATE_MESSAGE, fix: review.DUPLICATE_PAGE } } : null),
  );
  assert.equal(out.status, 409);
  assert.equal(out.body.fix, "/account-exists");
  assert.equal(modelCalls, 0);
});

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n\x1b[1mThrowaway mailboxes\x1b[0m\n");

await test("a throwaway provider, or a subdomain of one, is refused in plain words and recorded", async () => {
  for (const email of ["x@mailinator.com", "x@eu.mailinator.com", "x@YOPMAIL.com", "x@guerrillamail.info"]) {
    assert.ok(isDisposableEmail(email), email);
    const out = await signUp({ businessName: "Burner Salon", email, password: PASSWORD, vertical: "salon", selfServe: { ip: "10.9.9.9" } });
    assert.ok(!out.ok && out.field === "email", email);
    assert.match(out.ok ? "" : out.error, /temporary email address\. Use a work or personal address/);
  }
  for (const email of ["owner@gmail.com", "owner@marina-salon.ae", "owner@icloud.com", "owner@outlook.com"]) assert.ok(!isDisposableEmail(email), email);
  const rows = listAbuseRows().filter((r) => r.kind === "disposable_email" && r.email === "x@mailinator.com");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ip, "10.9.9.9");
});

await test("the list ships in the repo with its source, and nothing fetches it", () => {
  const list = source("src/lib/abuse/disposable-domains.ts");
  assert.match(list, /github\.com\/disposable-email-domains/);
  assert.doesNotMatch(list, /fetch\(|https?:\/\/[^\s]*\.(txt|conf|json)["']/);
  assert.equal(fetches, 0);
});

await test("staff allow one address, and that address can sign up", async () => {
  const row = listAbuseRows().find((r) => r.kind === "disposable_email" && r.email === "x@mailinator.com")!;
  assert.ok(review.decide(row.id, "allow", "Andreas", "Known customer, uses it for everything").ok);
  const out = await signUp({ businessName: "Allowed Burner Salon", email: "x@mailinator.com", password: PASSWORD, vertical: "salon", selfServe: {} });
  assert.ok(out.ok, out.ok ? "" : out.error);
  const other = await signUp({ businessName: "Other Burner", email: "y@mailinator.com", password: PASSWORD, vertical: "salon", selfServe: {} });
  assert.ok(!other.ok, "allowing one address allowed the whole provider");
});

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n\x1b[1mWhat makes two accounts one business\x1b[0m\n");

await test("domains: www, scheme, path, case and subdomains fold; a country's second level is kept", () => {
  const cases: [string, string | null][] = [
    ["https://www.Marina-Salon.ae/book?x=1", "marina-salon.ae"],
    ["marina-salon.ae", "marina-salon.ae"],
    ["http://book.marinasalon.com", "marinasalon.com"],
    ["www2.marinasalon.com.", "marinasalon.com"],
    ["https://marina.co.uk/", "marina.co.uk"],
    ["shop.marina.com.au", "marina.com.au"],
    ["marina.wixsite.com/home", "marina.wixsite.com"],
    ["https://instagram.com/marinasalon", null],
    ["www.facebook.com/marina", null],
    ["m.facebook.com/marina", null],
    ["linktr.ee/marina", null],
    ["https://wa.me/971501234567", null],
    ["maps.app.goo.gl/abc", null],
    ["http://127.0.0.1:4173", null],
    ["localhost:3000", null],
    ["", null],
    ["not a website", null],
  ];
  for (const [raw, want] of cases) assert.equal(normaliseDomain(raw), want, raw);
});

await test("phones: spaces, dashes and brackets fold to E.164; a number without its country code is not a key", () => {
  assert.equal(normalisePhone("+971 50 123 4567"), "+971501234567");
  assert.equal(normalisePhone("+971-50-123-4567"), "+971501234567");
  assert.equal(normalisePhone("00971501234567"), "+971501234567");
  assert.equal(normalisePhone("(+44) 20 7946 0958"), "+442079460958");
  assert.equal(normalisePhone(""), null);
  assert.equal(normalisePhone("call us"), null);
});

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n\x1b[1mOne free trial per business\x1b[0m\n");

const first = await selfServe("Palm Spa");
upsertLocation({ ...getLocation(first.location.id)!, businessPhone: "+971 4 555 0199", onboarding: { version: 1, channels: { web: { domains: ["https://palm-spa.test"] } } } });
const second = await selfServe("Palm Spa Again");

await test("the same website, typed differently, refuses a second trial with a clear message and a link, and is recorded", () => {
  const out = review.screenTrial(getLocation(second.location.id)!, "import", { website: "http://www.PALM-SPA.test/prices" });
  assert.ok(out);
  assert.equal(out!.status, 409);
  assert.equal(out!.error, "This business already has a Belline account — sign in or contact us. A business gets one free trial.");
  assert.equal(out!.fix, "/account-exists");
  const row = listAbuseRows().find((r) => r.kind === "duplicate_business" && r.tenantId === second.user.tenantId)!;
  assert.equal(row.match!.by, "domain");
  assert.equal(row.match!.value, "palm-spa.test");
  assert.equal(row.match!.tenantId, first.user.tenantId);
  assert.equal(row.stage, "import");
  const page = source("src/app/account-exists/page.tsx");
  assert.match(page, /SignInButton/);
  assert.match(page, /mailto:hello@belline\.ai/);
});

await test("raised again, the same match is counted on its row rather than added", () => {
  review.screenTrial(getLocation(second.location.id)!, "review", { website: "palm-spa.test" });
  const rows = listAbuseRows().filter((r) => r.kind === "duplicate_business" && r.tenantId === second.user.tenantId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 2);
});

await test("the same business phone in another format is a match; a shared host is not", () => {
  const byPhone = review.findDuplicate(getLocation(second.location.id)!, { phone: "+971-4-555-0199" });
  assert.equal(byPhone?.by, "phone");
  assert.equal(review.findDuplicate(getLocation(second.location.id)!, { website: "instagram.com/palmspa" }), null);
  assert.equal(review.findDuplicate(getLocation(second.location.id)!, { website: "palm-spa-two.test" }), null);
});

await test("the same card is a match, by Stripe's fingerprint", () => {
  upsertLocation({ ...getLocation(first.location.id)!, stripe: { cardFingerprint: "fp_same_card" } });
  const withCard = { ...getLocation(second.location.id)!, stripe: { cardFingerprint: "fp_same_card" } };
  assert.equal(review.findDuplicate(withCard)?.by, "card");
  upsertLocation({ ...getLocation(first.location.id)!, stripe: undefined });
});

await test("a paid account counts as the business having Belline; our own and demo venues never do", () => {
  const demo = store.listLocations({ includeInternal: true }).find((l) => l.demo?.enabled);
  if (demo) {
    const site = demo.embed?.allowedOrigins?.[0];
    if (site) assert.equal(review.findDuplicate(getLocation(second.location.id)!, { website: site }), null, "matched a demo venue");
  }
  const f = getLocation(first.location.id)!;
  upsertLocation({ ...f, subscription: { ...f.subscription!, status: "active", trial: undefined } });
  assert.equal(review.findDuplicate(getLocation(second.location.id)!, { website: "palm-spa.test" })?.by, "domain");
  upsertLocation(f);
});

await test("an account that predates screening is never refused, only matched against", async () => {
  const old = await signUp({ businessName: "Palm Spa Fixture", email: "owner@palm-fixture.test", password: PASSWORD, vertical: "salon" });
  assert.ok(old.ok);
  const loc = getLocation(old.ok ? old.location.id : "")!;
  assert.equal(review.screenTrial(loc, "import", { website: "palm-spa.test" }), null);
});

await test("staff allow the account: the same website goes through, and the override is recorded", () => {
  const row = listAbuseRows().find((r) => r.kind === "duplicate_business" && r.tenantId === second.user.tenantId)!;
  const out = review.decide(row.id, "allow", "Andreas", "Second branch, different owner");
  assert.ok(out.ok);
  assert.equal(getTenant(second.user.tenantId)!.abuse!.allowedBy, "Andreas");
  assert.equal(review.screenTrial(getLocation(second.location.id)!, "import", { website: "palm-spa.test" }), null);
  assert.equal(out.ok && out.record.notes[0].text, "Second branch, different owner");
});

await test("staff suspend a trial: paid work stops and the receptionist stops answering on it; lifting it restores both", () => {
  const third = listAbuseRows().find((r) => r.kind === "duplicate_business" && r.tenantId === second.user.tenantId)!;
  verify.markEmailVerified(second.user.id, "staff: test");
  assert.ok(review.decide(third.id, "suspend", "Andreas").ok);
  const loc = getLocation(second.location.id)!;
  const refusal = paidWorkRefusal(getUser(second.user.id), loc);
  assert.equal(refusal?.code, "trial_suspended");
  const today = todayIn(loc.timezone);
  assert.equal(serviceState(loc, today, { channel: "phone" }).refused, "trial_suspended");
  assert.doesNotMatch(serviceState(loc, today, { channel: "phone" }).callerMessage ?? "", /trial|suspend|pay/i);
  assert.ok(review.decide(third.id, "unsuspend", "Andreas").ok);
  assert.equal(paidWorkRefusal(getUser(second.user.id), getLocation(second.location.id)), null);
  assert.equal(serviceState(getLocation(second.location.id)!, today, { channel: "phone" }).answering, true);
});

await test("the sales console has the review list, its actions, and is staff only", () => {
  assert.match(source("src/app/(internal)/layout.tsx"), /href: "\/sales\/abuse"/);
  const page = source("src/app/(internal)/sales/abuse/page.tsx");
  assert.match(page, /isBellineStaff\(user\)/);
  const route = source("src/app/api/sales/abuse/route.ts");
  assert.match(route, /isBellineStaff\(auth\.user\)/);
  for (const action of ["allow", "note", "suspend"]) assert.match(source("src/app/(internal)/sales/abuse/AbuseActions.tsx"), new RegExp(`act\\("${action}"\\)`));
});

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n\x1b[1mTrial caps belong to the business\x1b[0m\n");

await test("a second account on the same domain draws down the first one's voice minutes and conversations", async () => {
  const a = await selfServe("Caps Studio");
  const b = await selfServe("Caps Studio Two");
  for (const id of [a.location.id, b.location.id]) {
    upsertLocation({ ...getLocation(id)!, onboarding: { version: 1, channels: { web: { domains: ["https://caps-studio.test"] } } } });
  }
  const today = todayIn("Asia/Dubai");
  assert.equal(lapseOf(getLocation(b.location.id)!, today), null);
  const call = startCall(getLocation(a.location.id)!, "phone", "+971501234567");
  call.status = "completed";
  call.startedAt = new Date().toISOString();
  call.endedAt = new Date(Date.now() + minutes(TRIAL.minutes)).toISOString();
  saveCall(call);
  assert.equal(lapseOf(getLocation(a.location.id)!, today), "trial_minutes_used");
  assert.equal(lapseOf(getLocation(b.location.id)!, today), "trial_minutes_used", "a second login got a fresh set of minutes");
  assert.equal(serviceState(getLocation(b.location.id)!, today, { channel: "phone" }).refused, "trial_minutes_used");
  // An unrelated trial is untouched.
  assert.equal(lapseOf(getLocation(first.location.id)!, today), null);
});

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n\x1b[1mTrials per network and per browser\x1b[0m\n");

await test("a fourth trial in a month from one network is refused and recorded; the second in a day is flagged", async () => {
  const ip = "203.0.113.7";
  for (let i = 0; i < 3; i++) {
    assert.ok(review.screenSignup({ ip, email: `n${i}@net.test` }).ok);
    await selfServe(`Network Salon ${i}`, { ip, device: `net-device-${i}-xxxxxxxxxx` });
  }
  assert.ok(listAbuseRows().some((r) => r.kind === "many_signups_ip" && r.ip === ip));
  const fourth = review.screenSignup({ ip, email: "n3@net.test" });
  assert.ok(!fourth.ok && fourth.kind === "ip_limit");
  assert.match(fourth.ok ? "" : fourth.error, /contact us/);
  assert.ok(listAbuseRows().some((r) => r.kind === "ip_limit" && r.ip === ip && r.status === "open"));
  // Staff allow the network (an office, a co-working space): it goes through.
  const row = listAbuseRows().find((r) => r.kind === "ip_limit" && r.ip === ip)!;
  review.decide(row.id, "allow", "Andreas", "Co-working space");
  assert.ok(review.screenSignup({ ip, email: "n4@net.test" }).ok);
});

await test("a third trial from one browser is refused, whatever network it comes from", async () => {
  const device = "one-browser-device-xxxxxxxx";
  await selfServe("Browser Salon A", { device });
  await selfServe("Browser Salon B", { device });
  const third = review.screenSignup({ ip: "198.51.100.9", device, email: "b3@browser.test" });
  assert.ok(!third.ok && third.kind === "device_limit");
});

await test("the signup route keeps its hourly limit and adds these, with the device cookie", () => {
  const route = source("src/app/api/signup/route.ts");
  assert.match(route, /limiter\.blocked\(key\)/);
  assert.match(route, /screenSignup\(\{ ip: key, device: known/);
  assert.match(route, /selfServe: \{ ip: key, device \}/);
  assert.match(route, /cookies\.set\(DEVICE_COOKIE/);
  assert.match(route, /next: "\/verify"/);
});

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n\x1b[1mThe card at Go live\x1b[0m\n");

async function liveReady(name: string, site: string) {
  const s = await selfServe(name);
  verify.markEmailVerified(s.user.id, "code");
  upsertLocation(ready(getLocation(s.location.id)!, site));
  return { ...s, owner: getUser(s.user.id)!, get: () => getLocation(s.location.id)! };
}

/** Play Stripe: open the card page, and deliver its signed webhook (twice, as Stripe may). */
async function saveCard(locationId: string, fingerprint?: string) {
  const loc = getLocation(locationId)!;
  const session = await card.createCardSetup({ location: loc, email: "owner@card.test", successUrl: "http://localhost:3000/setup/golive?card=saved", cancelUrl: "http://localhost:3000/setup/golive" });
  const stored = stubs.readStubCheckoutSession(new URL(session.url).searchParams.get("session")!)!;
  assert.equal((stored.params as { mode?: string }).mode, "setup", "the card page is not a setup-mode checkout");
  if (fingerprint) stubs.registerStubCard(`seti_stub_${stored.id.slice(-12)}`, fingerprint);
  const payload = stubs.stubCompletedEvent(stored);
  for (let i = 0; i < 2; i++) {
    const out = handleStripeWebhook(payload, stubs.signWebhook(payload, process.env.STRIPE_WEBHOOK_SECRET!));
    assert.equal(out.status, 200, out.applied);
  }
}

await test("payments off: Go live needs no card, activates, stamps the month from today and tells the team", async () => {
  delete process.env.FLAG_BILLING_STRIPE;
  const v = await liveReady("Stripe Off Salon", "https://stripe-off-salon.test");
  assert.equal(v.get().subscription!.trial!.endsOn, undefined, "the month started before Go live");
  const now = new Date();
  const out = await activateVenue(v.location.id, v.owner, now);
  assert.ok(out.ok, out.ok ? "" : `${out.status} ${out.error}`);
  const trial = v.get().subscription!.trial!;
  assert.equal(trial.endsOn, card.trialEndFor(now, v.get().timezone));
  const days = (Date.parse(`${trial.endsOn}T00:00:00Z`) - Date.parse(`${card.dayIn(v.get().timezone, now)}T00:00:00Z`)) / 86_400_000;
  assert.equal(days, TRIAL.days);
  assert.ok(listExceptions({ kind: "stripe_off_trial_end", locationId: v.location.id }).length === 1, "no stripe_off_trial_end row");
  assert.equal(v.get().stripe, undefined);
});

process.env.FLAG_BILLING_STRIPE = "on";

await test("payments on: Go live without a card is refused with 402, the free-until sentence and the card page", async () => {
  const v = await liveReady("Card Salon", "https://card-salon.test");
  const out = await activateVenue(v.location.id, v.owner);
  assert.ok(!out.ok && out.status === 402 && out.code === "card_required", JSON.stringify(out));
  assert.match(out.ok ? "" : out.error, /^Add a card to go live\. Nothing is charged today: Belline is free until \d{1,2} \w+\. Cancel any time before then and you pay nothing\.$/);
  assert.equal(out.ok ? "" : out.fix, `/api/billing/card?locationId=${v.location.id}`);
  assert.equal(v.get().onboarding!.activatedAt, undefined);
});

await test("payments on: the card is saved by the signed webhook, Go live charges nothing and the first invoice falls on day 31", async () => {
  const v = await liveReady("Card Salon Two", "https://card-salon-two.test");
  await saveCard(v.location.id);
  assert.ok(v.get().stripe?.cardSavedAt, "the webhook did not save the card");
  const now = new Date();
  const out = await activateVenue(v.location.id, v.owner, now);
  assert.ok(out.ok, out.ok ? "" : `${out.status} ${out.error}`);
  const live = v.get();
  assert.ok(live.onboarding!.activatedAt);
  assert.equal(live.subscription!.status, "trialing");
  assert.ok(live.stripe!.cardFingerprint?.startsWith("fp_stub_"));
  const sub = stubs.stubSubscriptions().find((s) => s.id === live.stripe!.trialSubscriptionId)!;
  assert.ok(sub, "no subscription at Stripe");
  assert.equal(sub.firstInvoiceOn, live.subscription!.trial!.endsOn);
  assert.equal(sub.firstInvoiceOn, card.trialEndFor(now, live.timezone));
  assert.equal(sub.invoices.length, 0, "charged at Go live");
  // Stripe's clock: nothing the day before day 31, the plan fee on it.
  const dayBefore = stubs.stubAdvanceSubscriptions(new Date(Date.parse(`${sub.firstInvoiceOn}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10), () => 1).find((s) => s.id === sub.id)!;
  assert.equal(dayBefore.invoices.length, 0);
  const onDay = stubs.stubAdvanceSubscriptions(sub.firstInvoiceOn, (s) => Number(s.metadata.belline_amount)).find((s) => s.id === sub.id)!;
  assert.equal(onDay.invoices.length, 1);
  assert.equal(onDay.invoices[0].on, live.subscription!.trial!.endsOn);
  assert.ok(onDay.invoices[0].amount > 0);
  // And Stripe telling us the subscription is active puts the venue on its plan.
  const event = JSON.stringify({ id: "evt_trial_active", object: "event", type: "customer.subscription.updated", created: Math.floor(Date.now() / 1000), data: { object: { id: sub.id, object: "subscription", status: "active", metadata: sub.metadata } } });
  const applied = handleStripeWebhook(event, stubs.signWebhook(event, process.env.STRIPE_WEBHOOK_SECRET!));
  assert.equal(applied.status, 200);
  assert.equal(v.get().subscription!.status, "active");
});

await test("payments on: cancelling inside the free month charges nothing", async () => {
  const v = await liveReady("Cancel Salon", "https://cancel-salon.test");
  await saveCard(v.location.id);
  assert.ok((await activateVenue(v.location.id, v.owner)).ok);
  const id = v.get().stripe!.trialSubscriptionId!;
  stubs.stubCancelSubscription(id);
  const after = stubs.stubAdvanceSubscriptions("2099-01-01", () => 9999).find((s) => s.id === id)!;
  assert.equal(after.status, "canceled");
  assert.equal(after.invoices.length, 0);
  const event = JSON.stringify({ id: "evt_trial_cancel", object: "event", type: "customer.subscription.deleted", created: Math.floor(Date.now() / 1000), data: { object: { id, object: "subscription", status: "canceled", metadata: { belline_location: v.location.id } } } });
  assert.equal(handleStripeWebhook(event, stubs.signWebhook(event, process.env.STRIPE_WEBHOOK_SECRET!)).status, 200);
  assert.equal(v.get().subscription!.status, "cancelled");
});

await test("payments on: a card already on another account's trial refuses Go live, and the match is recorded", async () => {
  const a = await liveReady("Card Owner Salon", "https://card-owner-salon.test");
  await saveCard(a.location.id, "fp_shared_card");
  assert.ok((await activateVenue(a.location.id, a.owner)).ok);
  const b = await liveReady("Card Farmer Salon", "https://card-farmer-salon.test");
  await saveCard(b.location.id, "fp_shared_card");
  const out = await activateVenue(b.location.id, b.owner);
  assert.ok(!out.ok && out.code === "duplicate_business", JSON.stringify(out));
  assert.equal(b.get().onboarding!.activatedAt, undefined);
  const row = listAbuseRows().find((r) => r.tenantId === b.user.tenantId && r.kind === "duplicate_business")!;
  assert.equal(row.match!.by, "card");
  assert.equal(row.stage, "golive");
});

await test("a plan chosen after Go live replaces the free month's subscription, so the card is never charged twice", async () => {
  const v = await liveReady("Upgrade Salon", "https://upgrade-salon.test");
  await saveCard(v.location.id);
  assert.ok((await activateVenue(v.location.id, v.owner)).ok);
  const trialSub = v.get().stripe!.trialSubscriptionId!;
  const event = JSON.stringify({
    id: "evt_upgrade_checkout",
    object: "event",
    type: "checkout.session.completed",
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: "cs_upgrade", object: "checkout.session", mode: "subscription", customer: v.get().stripe!.customerId, subscription: "sub_chosen_plan", metadata: { belline_location: v.location.id, belline_products: "v2_starter", belline_market: "AE", belline_cycle: "monthly" } } },
  });
  const applied = handleStripeWebhook(event, stubs.signWebhook(event, process.env.STRIPE_WEBHOOK_SECRET!));
  assert.equal(applied.status, 200, applied.applied);
  assert.equal(v.get().subscription!.status, "active", applied.applied);
  assert.equal(v.get().stripe!.subscriptionId, "sub_chosen_plan");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(stubs.stubSubscriptions().find((s) => s.id === trialSub)!.status, "canceled");
});

await test("the card route is owner-only, needs payments open and a confirmed email, and never trusts the browser coming back", () => {
  const route = source("src/app/api/billing/card/route.ts");
  assert.match(route, /canManageUsers\(user\)/);
  assert.match(route, /stripeEnabled\(\)/);
  assert.match(route, /verifyRefusal\(user\)/);
  assert.doesNotMatch(route, /cardSavedAt/);
});

delete process.env.FLAG_BILLING_STRIPE;

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n\x1b[1mExisting accounts\x1b[0m\n");

await test("a venue live before this shipped needs no card, no code and no screening", async () => {
  process.env.FLAG_BILLING_STRIPE = "on";
  try {
    const old = await signUp({ businessName: "Fixture Venue", email: "owner@fixture-venue.test", password: PASSWORD, vertical: "salon" });
    assert.ok(old.ok);
    const id = old.ok ? old.location.id : "";
    const tenant = getTenant(old.ok ? old.user.tenantId : "")!;
    saveTenant({ ...tenant });
    const live = { ...getLocation(id)!, onboarding: { version: 1 as const, channels: {}, activatedAt: "2026-09-01T00:00:00Z", activatedBy: "backfill" } };
    upsertLocation(live);
    assert.equal(verify.needsEmailVerification(getUser(old.ok ? old.user.id : "")), false);
    assert.equal(paidWorkRefusal(getUser(old.ok ? old.user.id : ""), getLocation(id)), null);
    assert.equal(review.screenTrial(getLocation(id)!, "golive", { website: "palm-spa.test" }), null);
    // Already live: activation is not asked again, so no card is either.
    const again = await activateVenue(id, getUser(old.ok ? old.user.id : "")!);
    assert.ok(!again.ok && again.status === 409);
  } finally {
    delete process.env.FLAG_BILLING_STRIPE;
  }
});

console.log(`\n${failed ? "\x1b[31m" : "\x1b[32m"}${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed ? 1 : 0);

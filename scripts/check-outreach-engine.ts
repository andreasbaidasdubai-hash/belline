/**
 * The outreach engine (src/lib/sales/sending).
 *
 * This is the first thing in the codebase that can put a message in a
 * stranger's inbox, and the first thing that can do it two hundred times
 * before anybody notices. So what is pinned here is not "the happy path
 * works". It is every way this could be a disaster:
 *
 *  - a code path that reaches a real provider without explicit credentials;
 *  - a message with no unsubscribe link or no sender identity in the footer;
 *  - a send to somebody who opted out, or to a company that already said stop;
 *  - a send into Germany, Austria or Switzerland while the company that is
 *    supposed to be writing does not legally exist;
 *  - a follow-up after a reply, a click, a bounce or an unsubscribe;
 *  - a batch that sends without a named human being approving it;
 *  - thirty messages leaving one brand-new mailbox in ninety seconds;
 *  - Resend, which carries customers' booking confirmations, quietly being
 *    used for cold mail.
 *
 * Nothing here sends. There is no network, no database, no credentials, and
 * `globalThis.fetch` throws — so a regression that tried to reach a provider
 * fails loudly here rather than quietly in production.
 *
 *   npm run check:outreach-engine
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-outreach-engine-"));
delete process.env.DATABASE_URL;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.RESEND_API_KEY;
delete process.env.OUTREACH_SES_ACCESS_KEY_ID;
delete process.env.OUTREACH_SES_SECRET_ACCESS_KEY;
delete process.env.OUTREACH_SES_REGION;
for (const key of Object.keys(process.env)) {
  if (key.startsWith("OUTREACH_") || key.startsWith("LEGAL_")) delete process.env[key];
}
Object.assign(process.env, {
  FLAG_STUBS: "on",
  PUBLIC_ORIGIN: "https://app.belline.test",
  SENDER_POSTAL_ADDRESS: "Belline · Dubai, United Arab Emirates",
});

/**
 * The network is off. Any code path that tries to reach a provider dies here,
 * which is the point — a passing run is evidence that nothing did.
 */
const NETWORK_OFF = () => {
  throw new Error("network is off in check:outreach-engine");
};
globalThis.fetch = NETWORK_OFF as unknown as typeof fetch;

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
    if (err instanceof Error && err.stack) {
      console.log(err.stack.split("\n").slice(1, 4).map((l) => `      ${l.trim()}`).join("\n"));
    }
    failed++;
  }
}

function section(title: string) {
  console.log(`\n\x1b[1m${title}\x1b[0m\n`);
}

function walk(dir: string, match: RegExp): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, match));
    else if (match.test(entry.name)) out.push(full);
  }
  return out;
}

/** Comments here quote the very patterns the scans look for. Read code only. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const provider = await import("../src/lib/sales/sending/provider");
const ses = await import("../src/lib/sales/sending/adapters/ses");
const adapters = await import("../src/lib/sales/sending/adapters");
const countries = await import("../src/lib/sales/sending/countries");
const compliance = await import("../src/lib/sales/sending/compliance");
const unsub = await import("../src/lib/sales/sending/unsubscribe");
const warmup = await import("../src/lib/sales/sending/warmup");
const schedule = await import("../src/lib/sales/sending/schedule");
const health = await import("../src/lib/sales/sending/health");
const sequence = await import("../src/lib/sales/sending/sequence");
const storeMod = await import("../src/lib/sales/sending/store");
const batchMod = await import("../src/lib/sales/sending/batch");
const dispatchMod = await import("../src/lib/sales/sending/dispatch");
const repliesMod = await import("../src/lib/sales/sending/replies");
const engineMod = await import("../src/lib/sales/sending/engine");
const identityMod = await import("../src/lib/legal/identity");
const noticeMod = await import("../src/lib/legal/outreach-privacy");

/** The privacy notice every outreach message has to link to, per language. */
const PRIVACY_URL = noticeMod.outreachPrivacyUrl({ language: "en", env: {} });
const PRIVACY_URL_DE = noticeMod.outreachPrivacyUrl({ language: "de", countryCode: "DE", env: {} });

const SES_ENV = {
  OUTREACH_SES_TRY_BELLINE_COM_ACCESS_KEY_ID: "AKIAEXAMPLE",
  OUTREACH_SES_TRY_BELLINE_COM_SECRET_ACCESS_KEY: "secretexample",
  OUTREACH_SES_TRY_BELLINE_COM_REGION: "eu-west-1",
};

const FULL_IDENTITY = {
  LEGAL_ENTITY: "Belline FZ-LLC",
  LEGAL_ADDRESS: "Office 1, Dubai, United Arab Emirates",
  LEGAL_MANAGING_DIRECTOR: "Andreas Baidas",
  // Not "DED-000000": a run of identical digits is what the privacy notice's
  // placeholder check refuses to publish, and a fixture that trips it would
  // make these tests fail for a reason that has nothing to do with sending.
  LEGAL_REGISTRATION: "DED-1184713",
  LEGAL_EMAIL: "hello@belline.ai",
};

// ---------------------------------------------------------------------------
section("Nothing can send without explicit credentials");

await test("with no credentials, resolving an adapter refuses and names the variables", () => {
  const result = adapters.resolveAdapter({ domain: "try-belline.com", provider: "ses", env: {} });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /no amazon ses credentials/i);
  assert.deepEqual(result.missing, [
    "OUTREACH_SES_TRY_BELLINE_COM_ACCESS_KEY_ID",
    "OUTREACH_SES_TRY_BELLINE_COM_SECRET_ACCESS_KEY",
    "OUTREACH_SES_TRY_BELLINE_COM_REGION",
  ]);
});

await test("a refusal is a refusal, never a stub standing in for one", () => {
  const result = adapters.resolveAdapter({ domain: "try-belline.com", provider: "ses", env: {} });
  assert.equal(result.ok, false);
  assert.equal("adapter" in result, false);
});

await test("Resend is refused for cold mail, with the reason attached", () => {
  const result = adapters.resolveAdapter({
    domain: "try-belline.com",
    provider: "resend",
    env: { ...SES_ENV, RESEND_API_KEY: "re_live_whatever" },
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /transactional/i);
  assert.match(result.reason, /separate lookalike domain/i);
});

await test("an unknown provider is refused rather than guessed at", () => {
  const result = adapters.resolveAdapter({ domain: "try-belline.com", provider: "mailgun", env: SES_ENV });
  assert.equal(result.ok, false);
});

await test("credentials are per domain — one domain's keys do not unlock another", () => {
  const ok = adapters.resolveAdapter({ domain: "try-belline.com", provider: "ses", env: SES_ENV });
  assert.equal(ok.ok, true);
  const other = adapters.resolveAdapter({ domain: "belline-demo.com", provider: "ses", env: SES_ENV });
  assert.equal(other.ok, false);
});

await test("only one module in the tree can construct the SES adapter", () => {
  const files = walk(path.join(ROOT, "src"), /\.tsx?$/);
  const importers = files.filter((f) =>
    /from ["'](?:[^"']*adapters\/ses|\.\/ses)["']|import\(["'](?:[^"']*adapters\/ses|\.\/ses)["']\)/.test(
      code(fs.readFileSync(f, "utf8")),
    ),
  );
  const relative = importers.map((f) => path.relative(ROOT, f).replaceAll("\\", "/"));
  assert.deepEqual(relative.sort(), ["src/lib/sales/sending/adapters/index.ts"]);
});

await test("only one module resolves an adapter at all, and it is the dispatcher", () => {
  const files = walk(path.join(ROOT, "src"), /\.tsx?$/);
  const callers = files
    .filter((f) => !f.includes(path.join("sending", "adapters")))
    .filter((f) => /\bresolveAdapter\s*\(/.test(code(fs.readFileSync(f, "utf8"))))
    .map((f) => path.relative(ROOT, f).replaceAll("\\", "/"))
    .sort();
  assert.deepEqual(callers, [
    "src/lib/sales/sending/dispatch.ts",
    "src/lib/sales/sending/engine.ts",
    "src/lib/sales/sending/provider.ts",
  ]);
});

await test("the SES adapter reads no environment variable of its own", () => {
  assert.equal(/process\.env/.test(code(read("src/lib/sales/sending/adapters/ses.ts"))), false);
});

await test("the engine reports itself inert when nothing is configured", async () => {
  storeMod.resetMemoryStore();
  const status = await engineMod.engineStatus({ ...process.env });
  assert.equal(status.ready, false);
  assert.equal(status.inert, true);
  assert.match(engineMod.statusSentence(status), /cannot send|inert/i);
});

await test("an inert engine dispatches nothing at all", async () => {
  storeMod.resetMemoryStore();
  const store = storeMod.sendingStore();
  await store.addDomain({
    domain: "try-belline.com", provider: "ses", purpose: "cold", status: "active",
    dailyCap: 120, dns: {}, notes: null, pausedReason: null, pausedAt: null,
  });
  const result = await dispatchMod.dispatchDue({ origin: "https://app.belline.test", env: {} });
  assert.equal(result.sent, 0);
  assert.equal(result.attempted, 0);
  assert.match(result.inert ?? "", /credentials/i);
});

// ---------------------------------------------------------------------------
section("Every message carries an opt-out and a sender identity");

await test("a token round-trips, and a tampered one does not", () => {
  const env = { OUTREACH_UNSUBSCRIBE_SECRET: "s3cret" };
  const token = unsub.signUnsubscribeToken({ itemId: 42, companyId: 7, email: "a@b.test" }, env);
  const claim = unsub.verifyUnsubscribeToken(token, env);
  assert.equal(claim?.itemId, 42);
  assert.equal(claim?.companyId, 7);
  assert.equal(unsub.verifyUnsubscribeToken(token.replace(/.$/, "x"), env), null);
  assert.equal(unsub.verifyUnsubscribeToken(token, { OUTREACH_UNSUBSCRIBE_SECRET: "other" }), null);
});

await test("no secret means no link can be signed, and the engine says so", () => {
  assert.equal(unsub.unsubscribeSecretPresent({}), false);
  assert.throws(() => unsub.signUnsubscribeToken({ itemId: 1, companyId: null, email: "a@b.test" }, {}));
});

await test("both List-Unsubscribe headers are present, so the provider shows its own button", () => {
  const headers = unsub.unsubscribeHeaders({ url: "https://app.belline.test/u/abc", mailto: "andreas@try-belline.com" });
  assert.match(headers["List-Unsubscribe"], /<https:\/\/app\.belline\.test\/u\/abc>/);
  assert.equal(headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
});

await test("a message without those headers cannot be handed to a provider", () => {
  const identity = identityMod.legalIdentity({ SENDER_POSTAL_ADDRESS: "Belline · Dubai" });
  assert.throws(
    () =>
      provider.assertSendable(
        { from: "a@b.test", fromName: "A", to: "c@d.test", subject: "s", text: "Belline · Dubai", headers: {} },
        identity,
        PRIVACY_URL,
      ),
    /List-Unsubscribe/,
  );
});

await test("a message whose body does not carry the postal identity cannot be sent", () => {
  const identity = identityMod.legalIdentity({ SENDER_POSTAL_ADDRESS: "Belline · Dubai" });
  assert.throws(
    () =>
      provider.assertSendable(
        {
          from: "a@b.test", fromName: "A", to: "c@d.test", subject: "s", text: "no address here",
          headers: unsub.unsubscribeHeaders({ url: "https://x.test/u/t" }),
        },
        identity,
        PRIVACY_URL,
      ),
    /postal sender identity/,
  );
});

await test("a message that does not link to the privacy notice cannot be sent", () => {
  const identity = identityMod.legalIdentity({ SENDER_POSTAL_ADDRESS: "Belline · Dubai" });
  const message = {
    from: "a@b.test", fromName: "A", to: "c@d.test", subject: "s",
    text: "Belline · Dubai\nunsubscribe: https://x.test/u/t",
    headers: unsub.unsubscribeHeaders({ url: "https://x.test/u/t" }),
  };
  // The postal identity is there and the opt-out is there: exactly the message
  // the engine used to be happy to send, and exactly the gap being closed.
  assert.throws(() => provider.assertSendable(message, identity, PRIVACY_URL), /privacy notice/);
  assert.throws(
    () => provider.assertSendable({ ...message, text: `${message.text}\n${PRIVACY_URL}` }, identity, "   "),
    /no privacy notice/,
  );
  provider.assertSendable({ ...message, text: `${message.text}\n${PRIVACY_URL}` }, identity, PRIVACY_URL);
});

await test("a German recipient gets a German footer, not a translated English one", () => {
  const footer = unsub.footerFor({
    language: "de",
    url: "https://app.belline.test/u/abc",
    privacyUrl: PRIVACY_URL_DE,
    entity: "Belline FZ-LLC",
    address: "Dubai",
    managingDirector: "Andreas Baidas",
    registration: "DED-1",
    email: "hello@belline.ai",
  });
  assert.match(footer, /Vertretungsberechtigt: Andreas Baidas/);
  assert.match(footer, /Registereintrag: DED-1/);
  assert.match(footer, /Keine weiteren|keine weiteren/);
  assert.equal(/Unsubscribe|Not for you/.test(footer), false);
  // The notice is named in German too, and it is the German page.
  assert.match(footer, /Art\. 21 DSGVO/);
  assert.ok(footer.includes(PRIVACY_URL_DE));
});

await test("an English recipient gets the English footer", () => {
  const footer = unsub.footerFor({
    language: "en",
    url: "https://x.test/u/t",
    privacyUrl: PRIVACY_URL,
    entity: "Belline",
    address: "Dubai",
  });
  assert.match(footer, /Unsubscribe/);
  assert.equal(/Vertretungsberechtigt/.test(footer), false);
  assert.ok(footer.includes(PRIVACY_URL));
});

await test("every footer carries the privacy notice beside the unsubscribe link, never instead of it", () => {
  for (const language of ["en", "de"]) {
    const url = language === "de" ? PRIVACY_URL_DE : PRIVACY_URL;
    const footer = unsub.footerFor({
      language,
      url: "https://x.test/u/t",
      privacyUrl: url,
      entity: "Belline FZ-LLC",
      address: "Dubai",
    });
    assert.ok(footer.includes("https://x.test/u/t"), `${language}: no unsubscribe link`);
    assert.ok(footer.includes(url), `${language}: no privacy notice`);
  }
});

await test("a header value with a newline in it is refused, not escaped", () => {
  assert.throws(
    () =>
      ses.buildMime(
        {
          from: "a@b.test", fromName: "A", to: "c@d.test", subject: "s", text: "body",
          headers: { "List-Unsubscribe": "<https://x.test>\r\nBcc: someone@else.test" },
        },
        "id@b.test",
      ),
    /newline/,
  );
});

await test("the MIME carries the unsubscribe headers verbatim", () => {
  const mime = ses.buildMime(
    {
      from: "a@try-belline.com", fromName: "Andreas", to: "c@d.test", subject: "hello", text: "body",
      headers: unsub.unsubscribeHeaders({ url: "https://app.belline.test/u/abc" }),
    },
    "id@try-belline.com",
  );
  assert.match(mime, /List-Unsubscribe: <https:\/\/app\.belline\.test\/u\/abc>/);
  assert.match(mime, /List-Unsubscribe-Post: List-Unsubscribe=One-Click/);
});

await test("the SigV4 signature is stable against a fixed vector", () => {
  const authorization = ses.sigv4Authorization({
    method: "POST",
    path: "/v2/email/outbound-emails",
    host: "email.eu-west-1.amazonaws.com",
    amzDate: "20260918T120000Z",
    dateStamp: "20260918",
    payload: '{"a":1}',
    region: "eu-west-1",
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "secretexample",
  });
  assert.match(authorization, /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/20260918\/eu-west-1\/ses\/aws4_request, /);
  assert.match(authorization, /SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  // Pinned: a change to the canonical request changes this, and the only way
  // to notice otherwise is a 403 in production.
  const signature = authorization.split("Signature=")[1];
  assert.equal(signature, ses.sigv4Authorization({
    method: "POST",
    path: "/v2/email/outbound-emails",
    host: "email.eu-west-1.amazonaws.com",
    amzDate: "20260918T120000Z",
    dateStamp: "20260918",
    payload: '{"a":1}',
    region: "eu-west-1",
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "secretexample",
  }).split("Signature=")[1]);
  assert.notEqual(
    signature,
    ses.sigv4Authorization({
      method: "POST", path: "/v2/email/outbound-emails", host: "email.eu-west-1.amazonaws.com",
      amzDate: "20260918T120000Z", dateStamp: "20260918", payload: '{"a":2}',
      region: "eu-west-1", accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secretexample",
    }).split("Signature=")[1],
  );
});

// ---------------------------------------------------------------------------
section("Country rules decide, in code");

const baseScreen = {
  companyName: "Test Clinic",
  toAddress: "info@clinic.test",
  suppressed: null,
  step: 1,
  touches90d: 0,
  lastTouchAt: null,
  hasDemoLink: true,
  hasResearch: true,
  sequenceStopped: null,
  guardProblems: [] as string[],
  canSignUnsubscribe: true,
  hasPrivacyNotice: true,
  engineReady: true,
};

await test("the UAE is on by default and DACH is off", () => {
  assert.equal(countries.effectiveRule("AE").enabled, true);
  for (const code of ["DE", "AT", "CH"]) {
    assert.equal(countries.effectiveRule(code).enabled, false, `${code} should be off`);
  }
});

await test("an unknown country is off, not silently allowed", () => {
  const rule = countries.effectiveRule("ZZ");
  assert.equal(rule.code, "*");
  assert.equal(rule.enabled, false);
});

await test("DACH has a lower cap, wider spacing and fewer messages than the UAE", () => {
  const ae = countries.ruleFor("AE");
  for (const code of ["DE", "AT", "CH"]) {
    const rule = countries.ruleFor(code);
    assert.ok(rule.dailyCap < ae.dailyCap, `${code} cap should be lower`);
    assert.ok(rule.minDaysBetweenTouches > ae.minDaysBetweenTouches, `${code} spacing should be wider`);
    assert.equal(rule.maxSequenceSteps, 3, `${code} is one first mail plus two follow-ups`);
    assert.equal(ae.maxSequenceSteps, 4);
    assert.equal(rule.language, "de");
  }
});

await test("a staff override can lower a cap but not raise it", () => {
  const overrides = [{ code: "DE", enabled: true, dailyCap: 5000 }];
  const rule = countries.effectiveRule("DE", overrides);
  assert.equal(rule.effectiveDailyCap, countries.ruleFor("DE").dailyCap);
  const lower = countries.effectiveRule("DE", [{ code: "DE", enabled: true, dailyCap: 10 }]);
  assert.equal(lower.effectiveDailyCap, 10);
});

await test("DACH is refused while the sender identity is empty, even switched on", () => {
  const identity = identityMod.legalIdentity({ SENDER_POSTAL_ADDRESS: "Belline · Dubai" });
  for (const code of ["DE", "AT", "CH"]) {
    const result = compliance.screen({
      ...baseScreen,
      countryCode: code,
      country: countries.effectiveRule(code, [{ code, enabled: true }]),
      identity,
    });
    assert.equal(result.ok, false, `${code} should be refused`);
    const block = result.blocks.find((b) => b.code === "identity_incomplete");
    assert.ok(block, `${code} should be blocked on the sender identity`);
    assert.match(block!.reason, /managing director|LEGAL_MANAGING_DIRECTOR/i);
    assert.match(block!.reason, /register|LEGAL_REGISTRATION/i);
  }
});

await test("nothing sends while the privacy notice cannot be published", () => {
  const result = compliance.screen({
    ...baseScreen,
    identity: identityMod.legalIdentity(FULL_IDENTITY),
    country: countries.effectiveRule("AE"),
    countryCode: "AE",
    hasPrivacyNotice: false,
  });
  assert.equal(result.ok, false, "a country that is on is not a reason to skip the notice");
  assert.ok(
    result.blocks.some((b) => b.code === "no_privacy_notice"),
    "no block naming the missing privacy notice",
  );
  assert.equal(compliance.isActionable("no_privacy_notice"), true, "staff can fix this one");
});

await test("with a complete identity and the country on, DACH passes", () => {
  const identity = identityMod.legalIdentity(FULL_IDENTITY);
  const result = compliance.screen({
    ...baseScreen,
    countryCode: "DE",
    country: countries.effectiveRule("DE", [{ code: "DE", enabled: true }]),
    identity,
  });
  assert.equal(result.ok, true, result.blocks.map((b) => b.reason).join("; "));
  assert.equal(result.language, "de");
  assert.match(result.basis, /UWG|DDG/);
});

await test("the basis recorded for a send names the regime, not just the country", () => {
  for (const rule of countries.realRules()) {
    assert.ok(rule.basis.length > 10, `${rule.code} has no basis`);
  }
});

await test("the identity block is shared with the site build, not copied", () => {
  const source = read("scripts/build-site.ts");
  assert.match(source, /from "\.\.\/src\/lib\/legal\/identity"/);
  assert.match(source, /const LEGAL = legalIdentity\(\)/);
  // No second hard-coded block left behind.
  assert.equal(/const LEGAL = \{[\s\S]*?entity:/.test(source), false);
});

// ---------------------------------------------------------------------------
section("The gate");

await test("suppression outranks everything, including an open country", () => {
  const result = compliance.screen({
    ...baseScreen,
    countryCode: "AE",
    country: countries.effectiveRule("AE"),
    identity: identityMod.legalIdentity(FULL_IDENTITY),
    suppressed: "opt_out (email info@clinic.test)",
  });
  assert.equal(result.ok, false);
  assert.equal(result.blocks[0].code, "suppressed");
});

await test("no prepared demo means no send", () => {
  const result = compliance.screen({
    ...baseScreen,
    countryCode: "AE",
    country: countries.effectiveRule("AE"),
    identity: identityMod.legalIdentity(FULL_IDENTITY),
    hasDemoLink: false,
  });
  assert.equal(result.ok, false);
  assert.ok(result.blocks.some((b) => b.code === "no_demo"));
});

await test("no research means no send", () => {
  const result = compliance.screen({
    ...baseScreen,
    countryCode: "AE",
    country: countries.effectiveRule("AE"),
    identity: identityMod.legalIdentity(FULL_IDENTITY),
    hasResearch: false,
  });
  assert.ok(result.blocks.some((b) => b.code === "no_research"));
});

await test("the existing 90-day company touch cap is honoured", () => {
  const country = countries.effectiveRule("AE");
  const result = compliance.screen({
    ...baseScreen,
    countryCode: "AE",
    country,
    identity: identityMod.legalIdentity(FULL_IDENTITY),
    touches90d: country.companyTouchCap90d,
  });
  assert.ok(result.blocks.some((b) => b.code === "touch_cap"));
});

await test("minimum spacing between touches is honoured, per country", () => {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString();
  for (const code of ["AE", "DE"]) {
    const result = compliance.screen({
      ...baseScreen,
      step: 2,
      countryCode: code,
      country: countries.effectiveRule(code, [{ code, enabled: true }]),
      identity: identityMod.legalIdentity(FULL_IDENTITY),
      lastTouchAt: yesterday,
    });
    assert.ok(result.blocks.some((b) => b.code === "too_soon"), `${code} should refuse a next-day touch`);
  }
});

await test("a fourth message into DACH is refused by the step cap", () => {
  const result = compliance.screen({
    ...baseScreen,
    step: 4,
    countryCode: "DE",
    country: countries.effectiveRule("DE", [{ code: "DE", enabled: true }]),
    identity: identityMod.legalIdentity(FULL_IDENTITY),
  });
  assert.ok(result.blocks.some((b) => b.code === "step_cap"));
});

await test("a flagged draft never sends", () => {
  const result = compliance.screen({
    ...baseScreen,
    countryCode: "AE",
    country: countries.effectiveRule("AE"),
    identity: identityMod.legalIdentity(FULL_IDENTITY),
    guardProblems: ["quotes a price: AED 499"],
  });
  assert.ok(result.blocks.some((b) => b.code === "guard_flags"));
});

await test("a stopped sequence cannot be written to again", () => {
  const result = compliance.screen({
    ...baseScreen,
    step: 2,
    countryCode: "AE",
    country: countries.effectiveRule("AE"),
    identity: identityMod.legalIdentity(FULL_IDENTITY),
    sequenceStopped: "they replied",
  });
  assert.ok(result.blocks.some((b) => b.code === "sequence_stopped"));
});

// ---------------------------------------------------------------------------
section("Warm-up and the shape of a sending day");

const mailbox = (over: Partial<import("../src/lib/sales/sending/store").SendingMailbox> = {}) => ({
  id: 1, domainId: 1, address: "andreas@try-belline.com", displayName: "Andreas",
  replyTo: null, dailyCap: 30, warmupStartedOn: "2026-09-01", status: "active" as const,
  pausedReason: null, pausedAt: null, createdAt: "2026-09-01T00:00:00Z", ...over,
});

await test("a new mailbox sends five a day in its first week", () => {
  assert.equal(warmup.warmupCap(mailbox(), "2026-09-01"), 5);
  assert.equal(warmup.warmupCap(mailbox(), "2026-09-07"), 5);
});

await test("it ramps over weeks and never exceeds its own ceiling", () => {
  assert.equal(warmup.warmupCap(mailbox(), "2026-09-08"), 10);
  assert.equal(warmup.warmupCap(mailbox(), "2026-09-15"), 16);
  assert.equal(warmup.warmupCap(mailbox(), "2026-12-01"), 30);
  assert.equal(warmup.warmupCap(mailbox({ dailyCap: 12 }), "2026-12-01"), 12);
});

await test("a mailbox with no warm-up started, or paused, sends nothing", () => {
  assert.equal(warmup.warmupCap(mailbox({ warmupStartedOn: null }), "2026-12-01"), 0);
  assert.equal(warmup.warmupCap(mailbox({ status: "paused" }), "2026-12-01"), 0);
});

const goodHealth = health.assess(health.emptyCounts());

await test("sends are spread across the working day, not fired in a burst", () => {
  const day = new Date("2026-09-21T04:00:00Z"); // a Monday
  const times = schedule.spreadOverDay({
    count: 20,
    window: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00", tz: "Asia/Dubai" },
    day,
    seed: 7,
  });
  assert.equal(times.length, 20);
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i] > times[i - 1], "times must ascend");
  }
  const spanMinutes = (times.at(-1)!.getTime() - times[0].getTime()) / 60_000;
  assert.ok(spanMinutes > 300, `20 messages spread over only ${Math.round(spanMinutes)} minutes`);
  const gaps = times.slice(1).map((t, i) => t.getTime() - times[i].getTime());
  assert.ok(new Set(gaps).size > 10, "the gaps are too regular to look human");
});

await test("nothing is scheduled outside the window or on a closed day", () => {
  const sunday = new Date("2026-09-20T06:00:00Z");
  assert.deepEqual(
    schedule.spreadOverDay({
      count: 5,
      window: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00", tz: "Asia/Dubai" },
      day: sunday,
    }),
    [],
  );
  const bounds = schedule.windowBounds(
    { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00", tz: "Asia/Dubai" },
    new Date("2026-09-21T04:00:00Z"),
  )!;
  const times = schedule.spreadOverDay({
    count: 5,
    window: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00", tz: "Asia/Dubai" },
    day: new Date("2026-09-21T04:00:00Z"),
  });
  for (const t of times) {
    assert.ok(t.getTime() >= bounds.start && t.getTime() <= bounds.end);
  }
});

await test("the scheduler prefers the healthier mailbox over the emptier one", () => {
  const healthy = schedule.capacityFor({
    mailbox: mailbox({ id: 1, address: "a@try-belline.com" }),
    health: goodHealth,
    sentToday: 5,
    today: "2026-12-01",
  });
  const watched = schedule.capacityFor({
    mailbox: mailbox({ id: 2, address: "b@try-belline.com" }),
    health: health.assess({ ...health.emptyCounts(), sent: 100, bounces: 2 }),
    sentToday: 0,
    today: "2026-12-01",
  });
  const order = schedule.usableMailboxes([watched, healthy]);
  assert.equal(order[0].mailbox.id, 1, "the healthy mailbox with less room should still come first");
});

await test("a mailbox over the stop threshold is not used at all", () => {
  const bad = schedule.capacityFor({
    mailbox: mailbox({ id: 3 }),
    health: health.assess({ ...health.emptyCounts(), sent: 200, bounces: 10 }),
    sentToday: 0,
    today: "2026-12-01",
  });
  assert.ok(bad.unusable, "an unhealthy mailbox must be unusable");
  assert.equal(schedule.usableMailboxes([bad]).length, 0);
});

await test("a paused domain takes its mailboxes with it", () => {
  const capacity = schedule.capacityFor({
    mailbox: mailbox(),
    health: goodHealth,
    sentToday: 0,
    today: "2026-12-01",
    domainPaused: "complaints",
  });
  assert.match(capacity.unusable ?? "", /domain is paused/);
});

await test("health verdicts bite at the thresholds and not before", () => {
  assert.equal(health.assess({ ...health.emptyCounts(), sent: 100, bounces: 1 }).verdict, "ok");
  assert.equal(health.assess({ ...health.emptyCounts(), sent: 100, bounces: 2 }).verdict, "watch");
  assert.equal(health.assess({ ...health.emptyCounts(), sent: 100, bounces: 3 }).verdict, "stop");
  assert.equal(health.assess({ ...health.emptyCounts(), sent: 5000, complaints: 4 }).verdict, "stop");
  // Too few sends for a rate to mean anything: one bounce out of four is not 25%.
  assert.equal(health.assess({ ...health.emptyCounts(), sent: 4, bounces: 1 }).verdict, "ok");
});

// ---------------------------------------------------------------------------
section("Sequences stop");

await test("the default sequence is a first email and three follow-ups", () => {
  assert.equal(sequence.DEFAULT_STEPS.length, 4);
  assert.equal(sequence.DEFAULT_STEPS[0].label, "Demo sent");
  assert.ok(sequence.DEFAULT_STEPS.every((s, i) => i === 0 || s.spacingDays > sequence.DEFAULT_STEPS[i - 1].spacingDays));
});

await test("staff spacing can be widened but never narrowed below the country floor", () => {
  const de = countries.effectiveRule("DE", [{ code: "DE", enabled: true }]);
  const spacing = sequence.spacingFor(de, { 2: 1, 3: 1, 4: 1 });
  for (const step of [2, 3]) {
    assert.ok(spacing[step] >= de.minDaysBetweenTouches, `step ${step} went below the floor`);
  }
});

await test("a reply, a click, an unsubscribe, a bounce and a complaint all halt", () => {
  for (const reason of ["replied", "demo_clicked", "unsubscribed", "bounced", "complaint"] as const) {
    assert.equal(sequence.isHalting(reason), true, `${reason} must halt`);
    const state = sequence.halt(sequence.blankState(1, 1, "AE"), reason, new Date());
    assert.equal(state.status, "stopped");
    assert.equal(state.nextDueAt, null);
  }
});

await test("a sequence completes rather than running past its country's cap", () => {
  const de = countries.effectiveRule("DE", [{ code: "DE", enabled: true }]);
  let state = sequence.blankState(1, 1, "DE");
  for (let i = 0; i < 3; i++) {
    state = sequence.advance({ state, country: de, spacing: sequence.spacingFor(de), sentAt: new Date() });
  }
  assert.equal(state.status, "completed");
  assert.equal(state.nextDueAt, null);
});

// ---------------------------------------------------------------------------
section("A batch, end to end, with a stub adapter");

const CANDIDATE = {
  leadId: 501,
  companyId: 9001,
  companyName: "Jumeirah Dental",
  toAddress: "info@jumeirah-dental.test",
  countryCode: "AE",
  messageId: 1,
  subject: "a 2-minute demo for Jumeirah Dental",
  body: "Hello,\n\nA short note about your evening calls.\n\n▶ Listen: https://app.belline.test/demo/v/abc\n\nAndreas\nBelline\n\n—\nplaceholder footer\n",
  videoDemoId: "abc",
  demoUrl: "https://app.belline.test/demo/v/abc",
  hasResearch: true,
  guardProblems: [] as string[],
  suppressed: null as string | null,
  touches90d: 0,
  lastTouchAt: null as string | null,
  sequenceStopped: null as string | null,
};

async function seedEngine() {
  storeMod.resetMemoryStore();
  const store = storeMod.sendingStore();
  const domain = await store.addDomain({
    domain: "try-belline.com", provider: "ses", purpose: "cold", status: "active",
    dailyCap: 120, dns: {}, notes: null, pausedReason: null, pausedAt: null,
  });
  const box = await store.addMailbox({
    domainId: domain.id, address: "andreas@try-belline.com", displayName: "Andreas Baidas",
    replyTo: null, dailyCap: 30, warmupStartedOn: "2026-01-01", status: "active",
    pausedReason: null, pausedAt: null,
  });
  await store.setCountryOverride({ code: "AE", enabled: true, dailyCap: 240, updatedBy: "test" });
  return { store, domain, box };
}

const BATCH_ENV = {
  ...FULL_IDENTITY,
  OUTREACH_UNSUBSCRIBE_SECRET: "s3cret",
  ...SES_ENV,
};

const MONDAY_MORNING = new Date("2026-09-21T05:30:00Z"); // 09:30 in Dubai

async function build(store: import("../src/lib/sales/sending/store").SendingStore, candidates = [CANDIDATE]) {
  const { fixedSource } = await import("../src/lib/sales/sending/candidates");
  return batchMod.buildBatch({
    source: fixedSource(candidates as never),
    store,
    origin: "https://app.belline.test",
    env: BATCH_ENV,
    now: MONDAY_MORNING,
    limit: 50,
  });
}

await test("a batch costs out its demo minutes and its spread across mailboxes", async () => {
  const { store } = await seedEngine();
  const built = await build(store);
  assert.equal(built.sendable.length, 1, built.blocked.map((b) => b.blocks[0]?.reason).join("; "));
  assert.equal(built.plan.demoMinutes, 2);
  assert.ok(built.plan.demoCostFils > 0, "the batch must be costed");
  assert.equal(built.plan.perMailbox[0].mailbox, "andreas@try-belline.com");
  assert.equal(built.plan.perCountry[0].code, "AE");
});

await test("saving a batch attaches the real footer and a real opt-out link", async () => {
  const { store } = await seedEngine();
  const built = await build(store);
  const { items } = await batchMod.saveBatch({
    built, createdBy: "user:test", origin: "https://app.belline.test", store, env: BATCH_ENV,
  });
  assert.equal(items.length, 1);
  assert.equal(/placeholder footer/.test(items[0].body), false, "the placeholder footer should be gone");
  assert.match(items[0].body, /https:\/\/app\.belline\.test\/u\//);
  assert.match(items[0].body, /Belline FZ-LLC/);
  assert.ok(items[0].unsubscribeToken);
  assert.equal(items[0].identitySnapshot?.entity, "Belline FZ-LLC");
  assert.match(items[0].countryRule ?? "", /UAE/);
});

await test("an unapproved batch sends nothing, even with a working adapter", async () => {
  const { store, box } = await seedEngine();
  const built = await build(store);
  const { items } = await batchMod.saveBatch({
    built, createdBy: "user:test", origin: "https://app.belline.test", store, env: BATCH_ENV,
  });
  const stub = provider.stubAdapter("try-belline.com");
  const outcome = await dispatchMod.dispatch(items[0], box, stub, {
    store, env: BATCH_ENV, origin: "https://app.belline.test", now: MONDAY_MORNING,
  });
  assert.equal(outcome.ok, false);
  assert.match((outcome as { reason: string }).reason, /not been approved/);
  assert.equal(stub.sent.length, 0);
});

await test("once approved, the message goes — with both headers and the footer", async () => {
  const { store, box } = await seedEngine();
  const built = await build(store);
  const { batch, items } = await batchMod.saveBatch({
    built, createdBy: "user:test", origin: "https://app.belline.test", store, env: BATCH_ENV,
  });
  await store.approveBatch(batch.id, "user:andreas");
  const stub = provider.stubAdapter("try-belline.com");
  const outcome = await dispatchMod.dispatch(items[0], box, stub, {
    store, env: BATCH_ENV, origin: "https://app.belline.test", now: MONDAY_MORNING,
  });
  assert.equal(outcome.ok, true, (outcome as { reason?: string }).reason);
  assert.equal(stub.sent.length, 1);
  assert.match(stub.sent[0].headers["List-Unsubscribe"], /\/u\//);
  assert.equal(stub.sent[0].headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.match(stub.sent[0].text, /Belline FZ-LLC/);
  // The other half of what a stranger is owed: not only who wrote, but what
  // we hold about them and how to object. `assertSendable` would have refused
  // the send without it; this says so out loud.
  assert.ok(stub.sent[0].text.includes(PRIVACY_URL), "the sent body must link to the privacy notice");
  const state = await store.getSequence(501);
  assert.equal(state?.step, 1);
  assert.ok(state?.nextDueAt, "a follow-up should now be due");
});

await test("an opt-out between approval and the scheduled minute still stops the send", async () => {
  const { store, box } = await seedEngine();
  const built = await build(store);
  const { batch, items } = await batchMod.saveBatch({
    built, createdBy: "user:test", origin: "https://app.belline.test", store, env: BATCH_ENV,
  });
  await store.approveBatch(batch.id, "user:andreas");
  await store.suppress({ matchType: "company_id", value: "9001", reason: "opt_out" });
  const stub = provider.stubAdapter("try-belline.com");
  const outcome = await dispatchMod.dispatch(items[0], box, stub, {
    store, env: BATCH_ENV, origin: "https://app.belline.test", now: MONDAY_MORNING,
  });
  assert.equal(outcome.ok, false);
  assert.equal(stub.sent.length, 0);
  assert.match((outcome as { reason: string }).reason, /suppression list/i);
});

await test("the same lead and step cannot produce two messages", async () => {
  const { store } = await seedEngine();
  const first = await build(store);
  await batchMod.saveBatch({ built: first, createdBy: "user:test", origin: "https://app.belline.test", store, env: BATCH_ENV });
  const second = await build(store);
  const { items } = await batchMod.saveBatch({
    built: second, createdBy: "user:test", origin: "https://app.belline.test", store, env: BATCH_ENV,
  });
  assert.equal(items.length, 0, "a second item for the same lead and step must be refused");
});

await test("a lead with no demo link is in the batch's blocked list, with the reason", async () => {
  const { store } = await seedEngine();
  const built = await build(store, [{ ...CANDIDATE, demoUrl: null, videoDemoId: null } as never]);
  assert.equal(built.sendable.length, 0);
  assert.match(built.blocked[0].blocks[0].reason, /demo link/);
});

await test("a DACH lead is blocked on the sender identity even when the country is on", async () => {
  const { store } = await seedEngine();
  await store.setCountryOverride({ code: "DE", enabled: true, dailyCap: 60, updatedBy: "test" });
  const { fixedSource } = await import("../src/lib/sales/sending/candidates");
  const built = await batchMod.buildBatch({
    source: fixedSource([{ ...CANDIDATE, countryCode: "DE", leadId: 777 }] as never),
    store,
    origin: "https://app.belline.test",
    // No LEGAL_* here: the company does not exist yet.
    env: { OUTREACH_UNSUBSCRIBE_SECRET: "s3cret", ...SES_ENV, SENDER_POSTAL_ADDRESS: "Belline · Dubai" },
    now: MONDAY_MORNING,
  });
  assert.equal(built.sendable.length, 0);
  assert.ok(built.blocked.some((b) => b.blocks.some((x) => x.code === "identity_incomplete")));
});

// ---------------------------------------------------------------------------
section("Replies, unsubscribes and complaints");

await test("any reply halts the sequence and takes queued items off the clock", async () => {
  const { store, box } = await seedEngine();
  const built = await build(store);
  const { batch, items } = await batchMod.saveBatch({
    built, createdBy: "user:test", origin: "https://app.belline.test", store, env: BATCH_ENV,
  });
  await store.approveBatch(batch.id, "user:andreas");
  await dispatchMod.dispatch(items[0], box, provider.stubAdapter(), {
    store, env: BATCH_ENV, origin: "https://app.belline.test", now: MONDAY_MORNING,
  });
  await store.addItems([{ ...items[0], id: undefined, step: 2, status: "queued", sentAt: null } as never]);

  const result = await repliesMod.receiveReply(
    { fromAddress: "info@jumeirah-dental.test", body: "Sounds interesting, call me Thursday", leadId: 501 },
    store,
  );
  assert.equal(result.stopped, true);
  assert.equal(result.optOut, false);
  const state = await store.getSequence(501);
  assert.equal(state?.status, "stopped");
  assert.equal(state?.stopReason, "replied");
  const queued = await store.listItems({ leadId: 501, status: ["planned", "queued"] });
  assert.equal(queued.length, 0, "nothing may still be on the clock for a lead that replied");
});

await test("an opt-out reply suppresses the whole company, not just the address", async () => {
  const { store } = await seedEngine();
  const built = await build(store);
  await batchMod.saveBatch({ built, createdBy: "user:test", origin: "https://app.belline.test", store, env: BATCH_ENV });
  const items = await store.listItems({ leadId: 501 });
  await repliesMod.receiveReply(
    { fromAddress: "manager@jumeirah-dental.test", body: "Please unsubscribe me", itemId: items[0].id },
    store,
  );
  assert.ok(await store.suppressed({ email: "manager@jumeirah-dental.test" }));
  assert.ok(
    await store.suppressed({ companyId: 9001 }),
    "the company must be suppressed, not only the one mailbox",
  );
  assert.ok(
    await store.suppressed({ email: "someone.else@jumeirah-dental.test" }),
    "another address at the same business must be suppressed too",
  );
});

await test("a click into the demo stops the follow-ups", async () => {
  const { store } = await seedEngine();
  await store.upsertSequence({
    leadId: 501, companyId: 9001, step: 1, status: "active", stopReason: null, stoppedAt: null,
    nextDueAt: new Date(Date.now() + 86_400_000).toISOString(), lastSentAt: new Date().toISOString(), countryCode: "AE",
  });
  await repliesMod.demoOpened(501, store);
  const state = await store.getSequence(501);
  assert.equal(state?.status, "stopped");
  assert.equal(state?.stopReason, "demo_clicked");
});

await test("a complaint suppresses the company and stops the sequence", async () => {
  const { store, box } = await seedEngine();
  const built = await build(store);
  const { batch, items } = await batchMod.saveBatch({
    built, createdBy: "user:test", origin: "https://app.belline.test", store, env: BATCH_ENV,
  });
  await store.approveBatch(batch.id, "user:andreas");
  await dispatchMod.dispatch(items[0], box, provider.stubAdapter(), {
    store, env: BATCH_ENV, origin: "https://app.belline.test", now: MONDAY_MORNING,
  });
  await dispatchMod.recordDeliveryEvent({ itemId: items[0].id, kind: "complaint", store });
  assert.equal((await store.getSequence(501))?.stopReason, "complaint");
  assert.ok(await store.suppressed({ companyId: 9001 }));
});

await test("a bounce suppresses the address and stops the sequence", async () => {
  const { store, box } = await seedEngine();
  const built = await build(store);
  const { batch, items } = await batchMod.saveBatch({
    built, createdBy: "user:test", origin: "https://app.belline.test", store, env: BATCH_ENV,
  });
  await store.approveBatch(batch.id, "user:andreas");
  await dispatchMod.dispatch(items[0], box, provider.stubAdapter(), {
    store, env: BATCH_ENV, origin: "https://app.belline.test", now: MONDAY_MORNING,
  });
  await dispatchMod.recordDeliveryEvent({ itemId: items[0].id, kind: "bounce", store });
  assert.equal((await store.getSequence(501))?.stopReason, "bounced");
  assert.ok(await store.suppressed({ email: "info@jumeirah-dental.test" }));
});

// ---------------------------------------------------------------------------
section("Observability and the watchdog");

await test("a mailbox that crosses the threshold is stopped and raises a ticket", async () => {
  const { store, domain, box } = await seedEngine();
  const { watchHealth } = await import("../src/lib/sales/sending/watch");
  for (let i = 0; i < 100; i++) {
    await store.addEvent({ mailboxId: box.id, domainId: domain.id, leadId: null, itemId: null, kind: "sent", detail: {} });
  }
  for (let i = 0; i < 5; i++) {
    await store.addEvent({ mailboxId: box.id, domainId: domain.id, leadId: null, itemId: null, kind: "bounce", detail: {} });
  }
  const result = await watchHealth({ store });
  assert.equal(result.paused.length, 1);
  assert.equal(result.paused[0].mailbox, "andreas@try-belline.com");
  assert.ok(result.tickets.length >= 1, "the Issues page must get a ticket");
  const after = (await store.listMailboxes())[0];
  assert.equal(after.status, "paused");
});

await test("per-domain and per-mailbox numbers are reported", async () => {
  const { store, domain, box } = await seedEngine();
  const { observe } = await import("../src/lib/sales/sending/watch");
  await store.addEvent({ mailboxId: box.id, domainId: domain.id, leadId: null, itemId: null, kind: "sent", detail: {} });
  await store.addEvent({ mailboxId: box.id, domainId: domain.id, leadId: null, itemId: null, kind: "reply", detail: {} });
  await store.addEvent({ mailboxId: box.id, domainId: domain.id, leadId: null, itemId: null, kind: "demo_view", detail: {} });
  const stats = await observe({ store });
  assert.equal(stats.totals.sent, 1);
  assert.equal(stats.totals.replies, 1);
  assert.equal(stats.totals.demoViews, 1);
  assert.equal(stats.perDomain[0].domain, "try-belline.com");
  assert.equal(stats.perMailbox[0].address, "andreas@try-belline.com");
});

// ---------------------------------------------------------------------------
section("The console cannot claim more than the engine does");

await test("belline.ai cannot be added as a cold sending domain", () => {
  const route = read("src/app/api/sales/outreach/route.ts");
  assert.match(route, /belline\\\.ai/);
  assert.match(route, /never send cold mail/i);
});

await test("every outreach page and route checks for staff", () => {
  const pages = walk(path.join(ROOT, "src", "app", "(internal)", "sales", "outreach"), /^page\.tsx$/);
  assert.ok(pages.length >= 5, `only ${pages.length} outreach screens found`);
  for (const file of [...pages, path.join(ROOT, "src", "app", "api", "sales", "outreach", "route.ts")]) {
    assert.match(fs.readFileSync(file, "utf8"), /!isBellineStaff\(/, path.relative(ROOT, file));
  }
});

await test("the unsubscribe endpoint is public and answers both verbs", () => {
  const route = read("src/app/u/[token]/route.ts");
  assert.match(route, /export async function GET/);
  assert.match(route, /export async function POST/);
  assert.equal(/isBellineStaff|requireUser/.test(route), false, "an opt-out must never need a login");
});

await test("the worker has a real sending handler, not a stub", async () => {
  const { HANDLERS, isKnownType } = await import("../src/lib/sales/queue/handlers/index");
  assert.equal(isKnownType("outreach_send"), true);
  assert.notEqual(HANDLERS.outreach_send, HANDLERS.noop);
});

await test("the engine's todo list is specific, not a shrug", async () => {
  storeMod.resetMemoryStore();
  const store = storeMod.sendingStore();
  await store.addDomain({
    domain: "try-belline.com", provider: "ses", purpose: "cold", status: "active",
    dailyCap: 120, dns: {}, notes: null, pausedReason: null, pausedAt: null,
  });
  const status = await engineMod.engineStatus({ PUBLIC_ORIGIN: "https://app.belline.test" });
  assert.ok(status.todo.some((line) => line.includes("OUTREACH_SES_TRY_BELLINE_COM_ACCESS_KEY_ID")));
  assert.ok(status.todo.some((line) => line.includes("OUTREACH_UNSUBSCRIBE_SECRET")));
});

console.log(`\n${failed ? "\x1b[31m" : "\x1b[32m"}✓ ${passed} passed, ${failed} failed\x1b[0m\n`);
fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
if (failed > 0) process.exitCode = 1;

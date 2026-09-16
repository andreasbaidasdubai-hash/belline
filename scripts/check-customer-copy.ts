/**
 * Nothing an owner reads is written for an engineer.
 *
 * Two halves. A static scan of the screens and routes an owner reaches, for
 * env names, SDK phrases and "email hello@" dead ends. Then the failure paths
 * themselves, run with fakes: a model that throws its own auth error, a site
 * that refuses the connection, no model at all. Each must come back as a plain
 * sentence, with the raw error in the log under a trace id.
 *
 * No keys, no network, no database.
 *
 *   npm run check:customer-copy
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-copy-"));
for (const k of ["ANTHROPIC_API_KEY", "DEEPGRAM_API_KEY", "ELEVENLABS_API_KEY", "FLAG_STUBS", "FLAG_IMPORT_MODEL"]) delete process.env[k];

const ROOT = path.resolve(import.meta.dirname, "..");
const { looksInternal, customerError, redact, integrationErrorText, INTEGRATION_ERRORS, CustomerError, resetCustomerErrors, EXCEPTION_AFTER } =
  await import("../src/lib/errors/customer");
const { draftFromRequest } = await import("../src/lib/onboarding/uploads");
const { seedIfEmpty } = await import("../src/lib/seed");
const { signUp } = await import("../src/lib/onboarding");
const { runSetupTurn } = await import("../src/lib/onboarding/assistant");
const { overviewFor, visibleHealth } = await import("../src/lib/overview");
const { cleanConfirmed } = await import("../src/lib/onboarding/review");
const { getLocation } = await import("../src/lib/store");

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

/** Run fn with console.error captured, so the checks can read the log and keep the output clean. */
async function logged<T>(fn: () => T | Promise<T>): Promise<{ out: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    return { out: await fn(), lines };
  } finally {
    console.error = original;
  }
}

// ---------------------------------------------------------------------------

console.log("\n\x1b[1mWhat the screens say\x1b[0m\n");

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.(tsx?|jsx?)$/.test(e.name) ? [p] : [];
  });
}

/** Source with comments and env reads removed: what is left can reach a screen or a response. */
function said(file: string): string {
  return fs
    .readFileSync(file, "utf8")
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[\s;{}(),])\/\/.*$/gm, "$1")
    .replace(/process\.env\.\w+/g, "")
    .replace(/flag\("[\w.]+"\)/g, "");
}

const rel = (f: string) => path.relative(ROOT, f).replace(/\\/g, "/");
const owned = [
  ...walk(path.join(ROOT, "src/app/(app)")),
  ...walk(path.join(ROOT, "src/app/setup")),
  // Signup and sign-in are the first screens an owner sees (zero-touch e2e step 17).
  ...walk(path.join(ROOT, "src/app/checkout")),
  ...walk(path.join(ROOT, "src/app/login")),
  ...walk(path.join(ROOT, "src/app/api/setup")),
  ...walk(path.join(ROOT, "src/app/api/integrations")),
  ...walk(path.join(ROOT, "src/app/api/payments")),
  ...walk(path.join(ROOT, "src/lib/onboarding")),
  path.join(ROOT, "src/lib/agent/runtime.ts"),
];
// Staff-only pages under (app): nobody but Belline staff reaches them.
const STAFF_ONLY = /src\/app\/\(app\)\/prospects\//;
// Legal footers may carry the address; none live in these folders today.
const LEGAL = /legal|terms|privacy/i;

await test("the scan covers the screens and routes an owner reaches", () => {
  assert.ok(owned.length > 30, `only ${owned.length} files`);
  assert.ok(owned.some((f) => rel(f) === "src/app/setup/SetupWizard.tsx"));
});

await test("no mailto:hello@ or 'email hello@' dead end on an owner's screen", () => {
  const hits = owned.filter((f) => !LEGAL.test(rel(f)) && said(f).includes("hello@belline.ai")).map(rel);
  assert.deepEqual(hits, []);
});

await test("no env name, SDK phrase or stack reaches a screen or a response", () => {
  const bad = [/\b[A-Z][A-Z0-9]*_(API_KEY|SECRET|CLIENT_ID|CLIENT_SECRET)\b/, /DATABASE_URL/, /Expected one of/, /\bECONN[A-Z]*\b/, /\.stack\b/];
  const hits: string[] = [];
  for (const f of owned) {
    if (STAFF_ONLY.test(rel(f))) continue;
    const text = said(f);
    for (const re of bad) if (re.test(text)) hits.push(`${rel(f)}: ${re}`);
  }
  assert.deepEqual(hits, []);
});

await test("no route an owner calls puts a raw error message in a body or a redirect", () => {
  const routes = owned.filter((f) => /src\/app\/api\//.test(rel(f)) || rel(f) === "src/lib/onboarding/uploads.ts");
  const hits = routes
    .filter((f) => /(error|reason)\s*:\s*(err|e|error)\s*(instanceof\s+Error\s*\?\s*\w+\.message|\.message)|encodeURIComponent\(\s*(err|e)\b|error=\$\{encodeURIComponent\(/.test(said(f)))
    .map(rel);
  assert.deepEqual(hits, []);
});

await test("the integrations page shows a sentence for a code, never the query string itself", () => {
  const page = said(path.join(ROOT, "src/app/(app)/integrations/page.tsx"));
  assert.ok(page.includes("integrationErrorText(error)"));
  assert.ok(!/\{error\}/.test(page), "the raw ?error= value is rendered");
});

await test("the health panel is rendered for Belline staff only", () => {
  const home = said(path.join(ROOT, "src/app/(app)/page.tsx"));
  const panel = home.indexOf("Belline health");
  assert.ok(panel > 0);
  const gate = home.lastIndexOf("{staff && (", panel);
  assert.ok(gate > 0 && panel - gate < 200, "the panel is not inside {staff && (...)}");
  assert.match(home, /visibleHealth\(overview\.health, staff\)/);
});

// ---------------------------------------------------------------------------

console.log("\n\x1b[1mWhat a failure says\x1b[0m\n");

seedIfEmpty();
const made = await signUp({ businessName: "Copy Check Salon", email: "owner@copycheck.test", password: "Correct-Horse-Battery-9", vertical: "salon" });
assert.ok(made.ok);
const location = made.ok ? made.location : null!;

const json = (body: unknown) =>
  new Request("http://localhost/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const site = async () => ({ url: new URL("https://example.ae/"), text: "Example salon. ".repeat(20) });

await test("a model's own auth error becomes a sentence, and the raw text only reaches the log", async () => {
  const raw = '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}';
  const { out, lines } = await logged(() =>
    draftFromRequest(json({ website: "example.ae" }), {
      readSite: site,
      model: async () => {
        throw new Error(raw);
      },
    }),
  );
  assert.equal(out.status, 422);
  const error = String(out.body.error);
  assert.ok(!looksInternal(error), error);
  assert.ok(!error.includes("x-api-key") && !error.includes("401"), error);
  assert.match(error, /could not read that/i);
  assert.ok(out.body.fallback);
  assert.ok(lines.some((l) => /trace=\w{8}/.test(l) && l.includes("x-api-key")), "raw error not logged with a trace id");
});

await test("a refused connection says nothing about ECONNREFUSED", async () => {
  const { out } = await logged(() =>
    draftFromRequest(json({ website: "example.ae" }), {
      readSite: async () => {
        throw new Error("connect ECONNREFUSED 10.0.0.4:443");
      },
      model: async () => ({ content: [] }),
    }),
  );
  assert.ok(!/ECONN|10\.0\.0\.4/.test(String(out.body.error)), String(out.body.error));
});

await test("a sentence written for the owner is kept as it is", async () => {
  const { out } = await logged(() =>
    draftFromRequest(json({ website: "example.ae/nope" }), {
      readSite: async () => {
        throw new CustomerError("That page does not exist. Check the address.");
      },
      model: async () => ({ content: [] }),
    }),
  );
  assert.equal(out.body.error, "That page does not exist. Check the address.");
});

await test("a CustomerError carrying internal text is still replaced", async () => {
  const { out } = customerErrorQuiet(new CustomerError("Set ANTHROPIC_API_KEY first"));
  assert.ok(!out.message.includes("API_KEY"));
});

function customerErrorQuiet(err: unknown) {
  const original = console.error;
  console.error = () => {};
  try {
    return { out: customerError("import", err) };
  } finally {
    console.error = original;
  }
}

await test("with no model switched on, reading says so honestly and offers the form", async () => {
  const { out, lines } = await logged(() => draftFromRequest(json({ website: "example.ae" })));
  assert.equal(out.status, 503);
  assert.match(String(out.body.error), /being prepared/);
  assert.ok(!looksInternal(String(out.body.error)));
  assert.ok(out.body.fallback);
  assert.ok(lines.some((l) => l.startsWith("[exception] import:model_off")), "no exception logged");
});

await test("Belle without a model key never names the key", async () => {
  const { out } = await logged(() => runSetupTurn(location.id, { id: made.ok ? made.user.id : "", name: "Owner" }, [{ role: "user", content: "Hello" }]));
  assert.ok(!/API_KEY|ANTHROPIC/.test(out.reply), out.reply);
  assert.match(out.reply, /not switched on/);
});

await test("the same failure three times opens one exception for the team, not three", async () => {
  resetCustomerErrors();
  const { lines } = await logged(() => {
    for (let i = 0; i < EXCEPTION_AFTER + 2; i++) customerError("google", new Error("token exchange failed"), "failed", "loc_x");
  });
  assert.equal(lines.filter((l) => l.startsWith("[exception] google:failed")).length, 1);
});

await test("logs are redacted: no email address, phone number or key", () => {
  const out = redact("owner@salon.ae called +971 50 123 4567 with sk_live_abc123XYZ");
  assert.ok(!out.includes("owner@salon.ae") && !out.includes("123 4567") && !out.includes("sk_live_abc123XYZ"), out);
});

await test("every integrations code is a plain sentence; an unknown value is not echoed", () => {
  for (const code of Object.keys(INTEGRATION_ERRORS)) {
    const text = integrationErrorText(code)!;
    assert.ok(text.length > 20 && !looksInternal(text), `${code}: ${text}`);
  }
  const forged = integrationErrorText("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first.")!;
  assert.ok(!forged.includes("GOOGLE"), forged);
  assert.equal(integrationErrorText(undefined), null);
});

await test("an owner's home screen has no 'model key missing'; staff still see it", () => {
  const health = overviewFor(getLocation(location.id)!).health;
  const speech = health.find((h) => h.label === "Speech and model");
  assert.ok(speech && !speech.ok, "the check itself should fail with no keys");
  const owner = visibleHealth(health, false);
  assert.ok(!owner.some((h) => /key missing/.test(h.detail) || h.label === "Speech and model"));
  assert.ok(visibleHealth(health, true).some((h) => h.label === "Speech and model"));
});

await test("a refused setup save says why in words, never a type error", () => {
  for (const body of [{ hours: "18:00-09:00" }, { hours: { 1: "nine" } }, { services: [{ name: "Cut", durationMin: 0 }] }]) {
    const out = cleanConfirmed(body as Record<string, unknown>);
    assert.equal(out.ok, false);
    if (!out.ok) assert.ok(!looksInternal(out.error) && !/undefined|NaN|TypeError/.test(out.error), out.error);
  }
});

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });

console.log(
  failed === 0 ? `\n\x1b[32m✓ ${passed} passed, 0 failed\x1b[0m\n` : `\n\x1b[31m✗ ${passed} passed, ${failed} failed\x1b[0m\n`,
);
if (failed > 0) process.exitCode = 1;

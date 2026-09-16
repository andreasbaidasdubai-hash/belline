import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { selfserveEnv } from "../tests/selfserve/helpers";
import { flag, stubsRefusal } from "../src/lib/flags";

/**
 * The end-to-end journey is safe to run, and honest about what it skips.
 *
 * The browser run itself is Playwright's job (`playwright.zero-touch.config.ts`),
 * which needs Chromium and three minutes. This is the part worth checking on
 * every commit: that the run can only ever point at a database that cannot
 * exist, that no real provider key reaches it, that its data directory is new
 * each time, that a step the product cannot do yet is marked and reasoned
 * rather than faked, and that the CI job nobody has switched on is still not
 * switched on.
 *
 * No keys, no network, no database.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`    ${(err as Error).message.split("\n").slice(0, 6).join("\n    ")}`);
    failed++;
  }
}

console.log("\nEnd-to-end journey\n");

const spec = read("tests/selfserve/zero-touch.spec.ts");
const config = read("playwright.zero-touch.config.ts");

await test("the journey spec runs under its own config, and not twice under the other one", () => {
  assert.match(config, /testMatch:\s*"zero-touch\.spec\.ts"/);
  assert.match(read("playwright.selfserve.config.ts"), /testIgnore:\s*"zero-touch\.spec\.ts"/);
});

await test("the server it starts cannot reach a database, and stubs are on", () => {
  const env = selfserveEnv("check");
  assert.equal(env.DATABASE_URL, "postgres://nobody:nothing@disabled.invalid:5432/none");
  assert.equal(env.FLAG_STUBS, "on");
  // Stub providers refuse to stand next to anything real; this env is safe.
  assert.equal(stubsRefusal(env), null);
  assert.notEqual(stubsRefusal({ ...env, DATABASE_URL: "postgres://u:p@db.belline.ai:5432/app" }), null);
  assert.notEqual(stubsRefusal({ ...env, NODE_ENV: "production" }), null);
});

await test("no real provider key is passed to the run", () => {
  const env = selfserveEnv("check");
  for (const key of [
    "ANTHROPIC_API_KEY",
    "DEEPGRAM_API_KEY",
    "ELEVENLABS_API_KEY",
    "RESEND_API_KEY",
    "STRIPE_SECRET_KEY",
    "TWILIO_ACCOUNT_SID",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "WHATSAPP_ACCESS_TOKEN",
  ]) {
    assert.equal(env[key], "", `${key} is not blanked for the journey run`);
  }
  // The two that are set are stub secrets the test signs with, not credentials.
  assert.equal(env.TWILIO_AUTH_TOKEN, "stub-token");
  assert.equal(env.STRIPE_WEBHOOK_SECRET, "whsec_stub");
});

await test("the flags the journey switches on are only on because it asked, never from credentials", () => {
  const env = { ...selfserveEnv("check"), FLAG_NUMBERS_POOL: "on", FLAG_BILLING_STRIPE: "on", FLAG_EMAIL_TRANSACTIONAL: "on" };
  for (const name of ["numbers.pool", "billing.stripe", "email.transactional"] as const) {
    assert.equal(flag(name, env), true, `${name} should be on under stubs when asked for`);
    assert.equal(flag(name, { ...env, FLAG_STUBS: "off" }), false, `${name} must not be on without stubs or credentials`);
  }
  // Nothing the journey does not test stays on.
  assert.equal(flag("lifecycle.send", env), false);
  assert.equal(flag("booking.google", env), false);
  assert.equal(flag("vertical.clinic.selfserve", env), false);
});

await test("the data directory is new every run, and the teardown only ever deletes a temporary one", () => {
  const a = selfserveEnv("run-a").DATA_DIR;
  const b = selfserveEnv("run-b").DATA_DIR;
  assert.notEqual(a, b);
  assert.ok(path.resolve(a).startsWith(path.resolve(os.tmpdir())), "the journey's data directory is not under the temp folder");
  const teardown = read("tests/selfserve/zero-touch.teardown.ts");
  assert.match(teardown, /startsWith\(path\.resolve\(os\.tmpdir\(\)\)\)/);
  assert.match(teardown, /rmSync/);
});

await test("every step the product cannot do yet is a fixme with a reason", () => {
  const fixmes = [...spec.matchAll(/test\.fixme\("([^"]+)",\s*\(\)\s*=>\s*\{\s*\n(\s*\/\/[^\n]*\n)+/g)];
  const declared = (spec.match(/test\.fixme\(/g) ?? []).length;
  assert.ok(declared > 0, "the journey claims to cover everything, which it does not");
  assert.equal(fixmes.length, declared, "a fixme step has no one-line reason under it");
});

await test("the journey blocks provider hosts in the browser and asserts nothing was written to one", () => {
  assert.match(spec, /from "\.\/helpers"/);
  assert.match(read("tests/selfserve/helpers.ts"), /route\.abort\("blockedbyclient"\)/);
  // No provider host is typed into the spec itself.
  assert.doesNotMatch(spec, /https:\/\/(api|graph|accounts|checkout)\.(anthropic|twilio|facebook|google|stripe)\.com/);
});

await test("the CI job is written down and still not enabled", () => {
  assert.ok(fs.existsSync(path.join(ROOT, "ci/zero-touch-e2e.yml")), "the CI job definition is missing");
  const workflows = path.join(ROOT, ".github/workflows");
  const enabled = fs.existsSync(workflows) ? fs.readdirSync(workflows) : [];
  assert.equal(
    enabled.filter((f) => f.includes("zero-touch")).length,
    0,
    "the zero-touch job is under .github/workflows, which switches it on",
  );
  // It must never be handed real credentials: no ${{ secrets.* }} but GITHUB_TOKEN.
  const uses = [...read("ci/zero-touch-e2e.yml").matchAll(/\$\{\{\s*secrets\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(uses.filter((name) => name !== "GITHUB_TOKEN"), []);
});

console.log(`\n${failed === 0 ? "\x1b[32m" : "\x1b[31m"}✓ ${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);

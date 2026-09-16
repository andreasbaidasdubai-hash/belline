/**
 * Every address the app sends somebody to is the public one.
 *
 * Behind Railway's proxy the request a route handler sees is addressed to the
 * container, so `new URL(req.url).origin` is `https://localhost:3000`. A
 * sign-in link built on it took the person who clicked it to their own
 * machine, and a checkout built on it would have sent a customer who had just
 * paid to the same place. Reproduced here by asking with a localhost request,
 * which is exactly what production hands the handler.
 *
 *   npm run check:origin
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-origin-"));
delete process.env.PUBLIC_APP_URL;
delete process.env.PUBLIC_ORIGIN;

const { signUp } = await import("../src/lib/onboarding");
const { signLoginToken } = await import("../src/lib/auth");

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

/** Absent until it is written — so the other checks still run and report. */
async function appOrigin(): Promise<string> {
  const mod = await import("../src/lib/origin").catch(() => null);
  assert.ok(mod, "src/lib/origin.ts does not exist");
  return mod.appOrigin();
}

console.log("\n\x1b[1mWhere the app lives\x1b[0m\n");

await test("with nothing configured it is app.belline.ai", async () => {
  assert.equal(await appOrigin(), "https://app.belline.ai");
});

await test("PUBLIC_ORIGIN is used, without a trailing slash", async () => {
  process.env.PUBLIC_ORIGIN = "https://belline-staging.up.railway.app/";
  try {
    assert.equal(await appOrigin(), "https://belline-staging.up.railway.app");
  } finally {
    delete process.env.PUBLIC_ORIGIN;
  }
});

await test("PUBLIC_APP_URL wins over PUBLIC_ORIGIN", async () => {
  process.env.PUBLIC_APP_URL = "https://app.example.test";
  process.env.PUBLIC_ORIGIN = "https://other.example.test";
  try {
    assert.equal(await appOrigin(), "https://app.example.test");
  } finally {
    delete process.env.PUBLIC_APP_URL;
    delete process.env.PUBLIC_ORIGIN;
  }
});

console.log("\n\x1b[1mA sign-in link, clicked behind the proxy\x1b[0m\n");

// What Railway hands the handler: the container's own address.
const BEHIND_PROXY = "http://localhost:3000";

async function click(token: string): Promise<Response> {
  const { GET } = await import("../src/app/api/auth/magic/route");
  return GET(new Request(`${BEHIND_PROXY}/api/auth/magic?t=${encodeURIComponent(token)}`));
}

await test("a forged link lands on the public sign-in page, not localhost", async () => {
  const response = await click("forged");
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), "https://app.belline.ai/login?link=expired");
});

await test("a genuine link signs in and lands on the public setup page", async () => {
  const signed = await signUp({
    businessName: "Origin Salon",
    email: "owner@originsalon.test",
    password: "Correct-Horse-Battery-9",
    vertical: "salon",
    timezone: "Asia/Dubai",
  });
  assert.ok(signed.ok, "could not create the account");
  const response = await click(signLoginToken(signed.user));
  assert.equal(response.headers.get("location"), "https://app.belline.ai/setup");
  assert.match(response.headers.get("set-cookie") ?? "", /belline_session=/);
});

console.log("\n\x1b[1mNo route builds an outward address from the request\x1b[0m\n");

await test("nothing under src/app takes the origin from req.url", () => {
  const offenders: string[] = [];
  const patterns = [
    /new URL\(\s*(req|request)\.url\s*\)\.origin/,
    /redirect\(\s*new URL\([^)]*,\s*url\.origin\s*\)/,
    // A redirect resolved against the request itself. The two patterns above
    // both look for `.origin`, so this shape passed the sweep and shipped: the
    // Google callback sent an owner to https://localhost:3000/integrations
    // after a connection that had otherwise succeeded.
    /redirect\(\s*new URL\([^;]*,\s*(req|request)\.url\s*\)/,
  ];

  // Non-vacuous: the sweep must catch the line that got through, and must
  // leave the fixed version alone.
  const shipped = "  const res = NextResponse.redirect(new URL(returnPath(returnTo, locationId, outcome), request.url));";
  const fixed = "  const res = NextResponse.redirect(new URL(returnPath(returnTo, locationId, outcome), appOrigin()));";
  assert.ok(patterns.some((p) => p.test(shipped)), "the sweep would miss the redirect that shipped");
  assert.ok(!patterns.some((p) => p.test(fixed)), "the sweep flags the corrected redirect");
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) {
        fs.readFileSync(full, "utf8")
          .split("\n")
          .forEach((line, i) => {
            if (patterns.some((p) => p.test(line))) {
              offenders.push(`${path.relative(process.cwd(), full)}:${i + 1}`);
            }
          });
      }
    }
  };
  walk(path.join(process.cwd(), "src", "app"));
  assert.deepEqual(offenders, [], `built from the request: ${offenders.join(", ")}`);
});

await test("nothing invents its own name for the public origin", () => {
  // The widget snippet was built from PUBLIC_APP_ORIGIN — a third spelling
  // that .env.example, Railway and origin.ts had never heard of. It could not
  // be set, so its fallback always won, and every owner on staging was handed
  // a line of HTML pointing at production. Only the two names origin.ts reads
  // are allowed to appear anywhere.
  // PUBLIC_WS_ORIGIN is not a third spelling of this one: it carries a wss://
  // scheme for the voice socket, which is a different address answering a
  // different question, and Railway sets it deliberately alongside the others.
  const allowed = new Set(["PUBLIC_APP_URL", "PUBLIC_ORIGIN", "PUBLIC_WS_ORIGIN"]);
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) {
        fs.readFileSync(full, "utf8")
          .split("\n")
          .forEach((line, i) => {
            for (const [, name] of line.matchAll(/process\.env\.(PUBLIC_[A-Z_]*(?:ORIGIN|URL))/g)) {
              if (!allowed.has(name)) offenders.push(`${path.relative(process.cwd(), full)}:${i + 1} ${name}`);
            }
          });
      }
    }
  };
  walk(path.join(process.cwd(), "src"));
  assert.deepEqual(offenders, [], `unknown origin variable: ${offenders.join(", ")}`);

  // Non-vacuous: the line that shipped must be caught, the fix must not be.
  const shipped = 'const origin = process.env.PUBLIC_APP_ORIGIN || "https://app.belline.ai";';
  const fixed = "const origin = appOrigin();";
  const bad = /process\.env\.(PUBLIC_[A-Z_]*(?:ORIGIN|URL))/g;
  assert.ok([...shipped.matchAll(bad)].some(([, n]) => !allowed.has(n)), "the sweep would miss the line that shipped");
  assert.equal([...fixed.matchAll(bad)].length, 0, "the sweep flags the corrected line");
});

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });

console.log(`\n${failed ? "\x1b[31m" : "\x1b[32m"}✓ ${passed} passed, ${failed} failed\x1b[0m\n`);
if (failed > 0) process.exitCode = 1;

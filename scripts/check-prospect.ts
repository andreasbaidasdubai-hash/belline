/**
 * The personalised-demo guardrails.
 *
 * This feature takes a URL from a user and fetches it server-side, which is
 * the textbook shape of a server-side request forgery. The tests that matter
 * are the refusals, so they run without a network or a model key.
 *
 *   npm run check:prospect
 */

import assert from "node:assert/strict";
import { assertPublicUrl, slugify, buildProspectLocation, type Extracted } from "../src/lib/prospect";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  [32m✓[0m ${name}`);
    passed++;
  } catch (err) {
    console.log(`  [31m✗[0m ${name}`);
    console.log(`      ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

async function refuses(url: string) {
  await assert.rejects(() => assertPublicUrl(url), `expected ${url} to be refused`);
}

console.log("\nPersonalised demos — what it refuses to fetch\n");

// A hostname that resolves into our own network is the whole attack: the
// cloud metadata service hands out credentials to anything that asks.
await test("refuses the cloud metadata address", () => refuses("http://169.254.169.254/latest/meta-data/"));
await test("refuses localhost", () => refuses("http://localhost:3000/api/team"));
await test("refuses 127.0.0.1", () => refuses("http://127.0.0.1/"));
await test("refuses a private 10.x address", () => refuses("http://10.0.0.5/"));
await test("refuses a private 192.168.x address", () => refuses("http://192.168.1.1/"));
await test("refuses a private 172.16-31.x address", () => refuses("http://172.20.0.1/"));
await test("refuses IPv6 loopback", () => refuses("http://[::1]/"));
await test("refuses a non-http scheme", () => refuses("file:///etc/passwd"));
await test("refuses gibberish", () => refuses("not a url at all"));

await test("accepts a public host, and assumes https", async () => {
  const url = await assertPublicUrl("example.com");
  assert.equal(url.protocol, "https:");
  assert.equal(url.hostname, "example.com");
});

console.log("\nSlugs\n");

await test("slug is url-safe", () => {
  assert.equal(slugify("Dr. Smith & Partners Dental!"), "dr-smith-and-partners-dental");
});
await test("slug never ends up empty", () => {
  assert.equal(slugify("!!!"), "demo");
});

console.log("\nWhat a generated venue looks like\n");

const found: Extracted = {
  name: "Meridian Dental",
  vertical: "clinic",
  address: "1 High Street, London",
  timezone: "Europe/London",
  greeting: "Good afternoon, Meridian Dental.",
  services: [{ name: "Hygiene", durationMin: 45, price: 70 }],
  staff: ["Dr Reid"],
  faqs: [{ q: "Is there parking?", a: "Yes, behind the building." }],
};

await test("carries a prospect marker and an expiry", () => {
  const loc = buildProspectLocation(found, "https://meridian.example", "meridian-dental");
  assert.ok(loc.prospect, "no prospect config");
  assert.equal(loc.prospect!.slug, "meridian-dental");
  assert.ok(new Date(loc.prospect!.expiresAt).getTime() > Date.now());
});

await test("is a capped demo line, never a live venue", () => {
  const loc = buildProspectLocation(found, "https://meridian.example", "meridian-dental");
  assert.equal(loc.demo?.enabled, true);
  assert.ok((loc.demo?.maxCallsPerDay ?? 0) <= 20);
  assert.match(loc.demo!.disclosure, /demonstration/i);
});

await test("has no phone number, so nothing can dial it by accident", () => {
  const loc = buildProspectLocation(found, "https://meridian.example", "meridian-dental");
  assert.equal(loc.phone, "");
});

await test("clamps an absurd service duration rather than trusting the model", () => {
  const loc = buildProspectLocation(
    { ...found, services: [{ name: "Odd", durationMin: 9999, price: -5 }] },
    "https://meridian.example",
    "x",
  );
  const service = loc.salon!.services[0];
  assert.equal(service.durationMin, 240);
  assert.equal(service.price, 0);
});

await test("a restaurant gets tables, a clinic gets a diary", () => {
  const clinic = buildProspectLocation(found, "https://x.example", "a");
  assert.ok(clinic.salon && !clinic.restaurant);
  const rest = buildProspectLocation({ ...found, vertical: "restaurant" }, "https://x.example", "b");
  assert.ok(rest.restaurant && !rest.salon);
});

console.log(
  failed === 0
    ? `\n[32m✓ ${passed} passed, 0 failed[0m\n`
    : `\n[31m✗ ${passed} passed, ${failed} failed[0m\n`,
);
if (failed > 0) process.exitCode = 1;

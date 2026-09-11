/**
 * The enquiry form.
 *
 * This is the only place a stranger writes into the product, and the only
 * lead capture we have — so it is tested from both ends: nothing hostile gets
 * in, and nothing real gets turned away.
 *
 * The email checks carry most of the weight. A mistyped domain passes every
 * syntax test ever written and the reply then vanishes with no bounce anyone
 * reads, which for a form whose entire job is to produce a reply is a total
 * failure that looks exactly like success.
 *
 *   npm run check:leads
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-leads-"));

const { checkShape, suggest, verify } = await import("../src/lib/leads/email");
const { buildLead, normalisePhone, findRecentDuplicate } = await import("../src/lib/leads");

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  const run = async () => {
    try {
      await fn();
      console.log(`  [32m✓[0m ${name}`);
      passed++;
    } catch (err) {
      console.log(`  [31m✗[0m ${name}`);
      console.log(`      ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  };
  queue = queue.then(run);
}

let queue: Promise<void> = Promise.resolve();

console.log("\nEmail shape\n");

test("an ordinary address is accepted", () => {
  assert.equal(checkShape("andreas@belline.ai").valid, true);
});

test("the address is normalised, so the same person is one person", () => {
  assert.equal(checkShape("  Andreas@Belline.AI ").email, "andreas@belline.ai");
});

test("no @ is refused", () => {
  assert.equal(checkShape("andreas.belline.ai").valid, false);
});

test("a bare domain with no TLD is refused", () => {
  assert.equal(checkShape("andreas@localhost").valid, false);
});

test("two dots in a row are refused", () => {
  assert.equal(checkShape("andreas..b@gmail.com").valid, false);
});

test("a throwaway mailbox is refused, and told why", () => {
  const check = checkShape("someone@mailinator.com");
  assert.equal(check.valid, false);
  assert.equal(check.disposable, true);
  assert.match(check.reason!, /temporary mailbox/i);
});

test("a shared mailbox is accepted but flagged as one", () => {
  const check = checkShape("info@someclinic.ae");
  assert.equal(check.valid, true);
  assert.equal(check.role, true, "info@ was not recognised as a shared mailbox");
});

console.log("\nSpelling — the failure that looks like success\n");

for (const [typo, meant] of [
  ["a@gmial.com", "a@gmail.com"],
  ["a@gmai.com", "a@gmail.com"],
  ["a@hotmial.com", "a@hotmail.com"],
  ["a@outlok.com", "a@outlook.com"],
  ["a@yahooo.com", "a@yahoo.com"],
  ["a@iclould.com", "a@icloud.com"],
] as const) {
  test(`${typo} is offered ${meant}`, () => {
    assert.equal(suggest(typo), meant);
  });
}

test("a correctly spelled famous domain is not second-guessed", () => {
  assert.equal(suggest("a@gmail.com"), null);
});

test("a company's own domain is left alone", () => {
  // The failure mode that matters here: telling a real business its own
  // address is wrong. Nothing within one edit of a known provider.
  assert.equal(suggest("andreas@azuretable.ae"), null);
  assert.equal(suggest("reception@lumiere-zurich.ch"), null);
});

test("a suggestion is never a refusal", () => {
  const check = checkShape("a@gmial.com");
  assert.equal(check.valid, true, "a spelling suggestion refused the address outright");
  assert.equal(check.suggestion, "a@gmail.com");
});

console.log("\nDeliverability\n");

test("a domain that cannot exist is refused", async () => {
  const check = await verify("someone@this-domain-does-not-exist-belline-test.invalid");
  assert.equal(check.valid, false, "a non-existent domain was accepted");
  assert.equal(check.mx, false);
  assert.match(check.reason!, /no domain|cannot receive/i);
});

test("a real domain passes, or is left unjudged when DNS is unreachable", async () => {
  const check = await verify("hello@gmail.com");
  // Never false: gmail.com has MX. `null` is the honest answer when the
  // network is down, and it must not fail the address — an outage on our side
  // is not the customer's email being wrong.
  assert.notEqual(check.mx, false, "gmail.com was reported as undeliverable");
  assert.equal(check.valid, true);
});

console.log("\nPhone\n");

test("a UAE mobile typed locally becomes E.164", () => {
  assert.deepEqual(normalisePhone("050 123 4567"), { phone: "+971501234567", valid: true });
});

test("an international number is kept as given", () => {
  assert.deepEqual(normalisePhone("+41 44 555 21 80"), { phone: "+41445552180", valid: true });
});

test("00 is treated as a plus", () => {
  assert.equal(normalisePhone("0044 20 7946 0958").phone, "+442079460958");
});

test("too few digits is refused rather than guessed at", () => {
  assert.equal(normalisePhone("12345").valid, false);
});

test("a number from outside the three countries we prospect in still works", () => {
  // The sales-side normaliser only knows AE, SA and CH. An inbound enquiry can
  // come from anywhere, and refusing one is a lead thrown away.
  assert.equal(normalisePhone("+1 571 778 5920").valid, true);
});

console.log("\nThe whole form\n");

const good = {
  name: "Andreas",
  email: "andreas@gmail.com",
  phone: "+971501234567",
  company: "Azure Table",
  vertical: "Restaurant",
  source: "website: Business",
};

test("a complete enquiry is accepted", async () => {
  const result = await buildLead(good);
  assert.equal(result.ok, true, result.ok ? "" : result.error);
});

test("each required field is named when it is missing", async () => {
  for (const field of ["name", "email", "phone", "company"]) {
    const result = await buildLead({ ...good, [field]: "" });
    assert.equal(result.ok, false, `${field} was allowed to be empty`);
    if (!result.ok) assert.equal(result.field, field);
  }
});

test("a near-miss domain is asked about rather than silently accepted", async () => {
  // gmial.com is a registered typosquat: it resolves, mail is delivered to
  // somebody else, nothing bounces, and the lead is lost invisibly. Accepting
  // it without asking is the worst of the three options.
  const result = await buildLead({ ...good, email: "andreas@gmial.com" });
  assert.equal(result.ok, false, "a known typosquat was accepted without a word");
  if (!result.ok) {
    assert.equal(result.field, "email");
    assert.equal(result.confirmable, true, "the refusal gave them no way past it");
    assert.equal(result.suggestion, "andreas@gmail.com");
  }
});

test("and is accepted once they say they meant it", async () => {
  const result = await buildLead({
    ...good,
    email: "andreas@gmial.com",
    emailConfirmed: "1",
  });
  assert.equal(result.ok, true, "confirming their own address still would not go through");
  if (result.ok) assert.equal(result.lead.email, "andreas@gmial.com");
});

test("an ordinary company address is never questioned on spelling", async () => {
  // Asserted on the spelling challenge specifically rather than on overall
  // acceptance: azuretable.ae is a made-up domain, so a DNS refusal here is
  // the engine working, and a test that cannot tell those apart is no test.
  const result = await buildLead({ ...good, email: "reception@azuretable.ae" });
  if (!result.ok) {
    assert.notEqual(
      result.confirmable,
      true,
      "a normal company address was queried as a possible typo",
    );
  }
});

test("the honeypot is refused, and separately from a real error", async () => {
  const result = await buildLead({ ...good, website2: "http://spam.example" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.field, "website2");
});

test("oversized input is cut, not rejected", async () => {
  const result = await buildLead({ ...good, notes: "x".repeat(50_000) });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.lead.notes!.length, 2000);
});

test("control characters are stripped", async () => {
  const result = await buildLead({ ...good, company: "Azure Table" });
  assert.equal(result.ok, true);
  if (result.ok) assert.ok(!/[ -]/.test(result.lead.company));
});

test("the same person filling it in twice is one enquiry", async () => {
  const first = await buildLead(good);
  const second = await buildLead({ ...good, notes: "Forgot to say — two venues." });
  assert.ok(first.ok && second.ok);
  if (first.ok && second.ok) {
    assert.ok(
      findRecentDuplicate([first.lead], second.lead),
      "a second submission from the same address was not recognised",
    );
  }
});

test("a different person from the same company is not a duplicate", async () => {
  const first = await buildLead(good);
  const second = await buildLead({ ...good, email: "manager@gmail.com" });
  assert.ok(first.ok && second.ok);
  if (first.ok && second.ok) {
    assert.equal(findRecentDuplicate([first.lead], second.lead), undefined);
  }
});

test("an enquiry from last week is not a duplicate of one today", async () => {
  const first = await buildLead(good);
  const second = await buildLead(good);
  assert.ok(first.ok && second.ok);
  if (first.ok && second.ok) {
    const old = { ...first.lead, createdAt: new Date(Date.now() - 8 * 864e5).toISOString() };
    assert.equal(findRecentDuplicate([old], second.lead), undefined);
  }
});

test("what the form captured is kept, so whoever rings back has the context", async () => {
  const result = await buildLead({
    ...good,
    venues: "Two to five",
    callVolume: "30 to 80",
    availability: "Weekday mornings",
    timezone: "Asia/Dubai",
    website: "azuretable.ae",
  });
  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.lead.venues, "Two to five");
    assert.equal(result.lead.callVolume, "30 to 80");
    assert.equal(result.lead.timezone, "Asia/Dubai");
    assert.equal(result.lead.source, "website: Business");
    assert.equal(result.lead.status, "new");
  }
});

queue.then(() => {
  fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
  console.log(
    failed === 0
      ? `\n[32m✓ ${passed} passed, 0 failed[0m\n`
      : `\n[31m✗ ${passed} passed, ${failed} failed[0m\n`,
  );
  if (failed > 0) process.exitCode = 1;
});

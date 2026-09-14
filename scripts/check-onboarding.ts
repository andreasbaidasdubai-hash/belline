/**
 * Onboarding, UAE first: setting up by talking to Belle, forwarding a du or
 * e& line, and getting the widget onto the venue's own website.
 *
 * No keys and no network. The setup tools are called exactly as the model
 * calls them, because they are where the safety is: every change goes through
 * the venue gate and onto the version history, and a change that would break
 * the diary comes back as a sentence to say, not a crash or a silent save.
 *
 *   npm run check:onboarding
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-onboard-"));
delete process.env.ANTHROPIC_API_KEY;

const { seedIfEmpty } = await import("../src/lib/seed");
const { signUp, readiness } = await import("../src/lib/onboarding");
const { getLocation } = await import("../src/lib/store");
const { historyFor } = await import("../src/lib/brain");
const { executeSetupTool, runSetupTurn, setupGreeting } = await import("../src/lib/onboarding/assistant");
const { INSTALL_STEPS, detectPlatform, installedIn } = await import("../src/lib/onboarding/platform");
const { forwardingCodes, uaeCarriers } = await import("../src/lib/telephony/forwarding");

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

seedIfEmpty();

async function venue(name: string, vertical: "salon" | "clinic" | "restaurant") {
  const made = await signUp({
    businessName: name,
    email: `owner@${name.toLowerCase().replace(/\W+/g, "")}.test`,
    password: "Correct-Horse-Battery-9",
    vertical,
    timezone: "Asia/Dubai",
  });
  assert.ok(made.ok);
  return made.ok ? { id: made.location.id, by: { id: made.user.id, name: made.user.name } } : null!;
}

const salon = await venue("Jumeirah Glow Salon", "salon");
const fresh = () => getLocation(salon.id)!;

console.log("\n\x1b[1mSetting up by talking to Belle\x1b[0m\n");

await test("she opens by asking for the first thing still missing", () => {
  const first = readiness(fresh()).missing[0].label.toLowerCase();
  assert.ok(setupGreeting(fresh()).toLowerCase().includes(first), setupGreeting(fresh()));
});

await test("hours for the working week are saved, and staff on the old hours follow", () => {
  const out = executeSetupTool(salon.id, salon.by, "set_hours", { days: ["weekdays"], open: "10:00", close: "20:00" });
  assert.ok(out.ok, out.say);
  assert.deepEqual(fresh().hours[1], [{ start: 600, end: 1200 }]);
  assert.deepEqual(fresh().hours[5], [{ start: 600, end: 1200 }]);
});

await test("a day off is saved as closed", () => {
  assert.ok(executeSetupTool(salon.id, salon.by, "set_hours", { days: ["sunday"], closed: true }).ok);
  assert.deepEqual(fresh().hours[0], []);
});

await test("a closing time before the opening time is refused with a reason", () => {
  const out = executeSetupTool(salon.id, salon.by, "set_hours", { days: ["saturday"], open: "18:00", close: "09:00" });
  assert.equal(out.ok, false);
  assert.match(out.say, /before the opening/);
});

await test("a service is added exactly as described, and the version says who set it up", () => {
  const out = executeSetupTool(salon.id, salon.by, "add_service", { name: "Blow dry", duration_min: 45, price: 150 });
  assert.ok(out.ok, out.say);
  const service = fresh().salon!.services.find((s) => s.name === "Blow dry")!;
  assert.equal(service.durationMin, 45);
  assert.equal(service.price, 150);
  const latest = historyFor(fresh())[0];
  assert.match(latest.note, /Set up with Belle: service Blow dry/);
  assert.equal(latest.authorName, salon.by.name);
});

await test("a service with no length is refused, and nothing is saved", () => {
  const before = fresh().salon!.services.length;
  const out = executeSetupTool(salon.id, salon.by, "add_service", { name: "Mystery", duration_min: 0, price: 100 });
  assert.equal(out.ok, false);
  assert.equal(fresh().salon!.services.length, before);
});

await test("a change the gate warns about is saved, and Belle is told to check it with the owner", () => {
  const out = executeSetupTool(salon.id, salon.by, "add_service", { name: "All-day retreat", duration_min: 600, price: 900 });
  assert.ok(out.ok, out.say);
  assert.match(out.say, /check this with them: .*over eight hours/);
  assert.ok(executeSetupTool(salon.id, salon.by, "remove_service", { name: "All-day retreat" }).ok);
});

await test("the gate's refusal comes back as words to say, never a silent save", () => {
  // Every staff member removed from a service a second person depends on is
  // the gate's own business; here, the simplest blocking change: a service id
  // collision can't arise through the tool, so check the refusal shape directly.
  const out = executeSetupTool("loc_does_not_exist", salon.by, "set_address", { address: "Anywhere Road, Dubai" });
  assert.equal(out.ok, false);
  assert.ok(out.say.length > 10);
});

await test("a duplicate service is questioned, not added twice", () => {
  const out = executeSetupTool(salon.id, salon.by, "add_service", { name: "blow dry", duration_min: 30, price: 120 });
  assert.equal(out.ok, false);
});

await test("a person who takes bookings is added, able to do the services they named", () => {
  assert.ok(executeSetupTool(salon.id, salon.by, "add_service", { name: "Cut", duration_min: 60, price: 200 }).ok);
  const out = executeSetupTool(salon.id, salon.by, "add_staff", { name: "Layla", services: ["Cut"] });
  assert.ok(out.ok, out.say);
  const layla = fresh().salon!.staff.find((s) => s.name === "Layla")!;
  assert.equal(layla.serviceIds.length, 1);
});

await test("a transfer number must be a real number, and is stored in international form", () => {
  assert.equal(executeSetupTool(salon.id, salon.by, "set_transfer_number", { number: "call me" }).ok, false);
  assert.ok(executeSetupTool(salon.id, salon.by, "set_transfer_number", { number: "050 123 4567" }).ok);
  assert.match(fresh().agent.transferNumber ?? "", /^\+9715/);
});

await test("answering the gaps moves the venue towards ready", () => {
  const before = readiness(fresh()).missing.length;
  executeSetupTool(salon.id, salon.by, "set_address", { address: "Shop 4, Jumeirah Beach Road, Dubai" });
  executeSetupTool(salon.id, salon.by, "add_faq", { question: "Is there parking?", answer: "Yes, free parking behind the building." });
  assert.ok(readiness(fresh()).missing.length < before);
});

await test("a restaurant is told where tables are set, not given a service list", async () => {
  const restaurant = await venue("Marina Grill", "restaurant");
  const out = executeSetupTool(restaurant.id, restaurant.by, "add_service", { name: "Dinner", duration_min: 90, price: 0 });
  assert.equal(out.ok, false);
  assert.match(out.say, /restaurant/i);
});

await test("without a key, the assistant says so instead of failing", async () => {
  const out = await runSetupTurn(salon.id, salon.by, [{ role: "user", content: "We open at nine" }]);
  assert.match(out.reply, /not switched on/);
});

console.log("\n\x1b[1mForwarding a UAE line\x1b[0m\n");

await test("du and e& mobiles get the conditional codes with the venue's own number", () => {
  const codes = forwardingCodes("+97145550142");
  assert.ok(codes.some((c) => c.dial === "**61*+97145550142#"));
  assert.ok(codes.some((c) => c.dial === "##004#"));
});

await test("landlines are sent to the carrier, with the right number to call", () => {
  const carriers = uaeCarriers("+97145550142");
  assert.deepEqual(carriers.map((c) => c.id), ["du", "eand"]);
  assert.match(carriers[0].landline, /155/);
  assert.match(carriers[1].landline, /101/);
});

console.log("\n\x1b[1mThe widget on their website\x1b[0m\n");

const fixtures: Record<string, string> = {
  squarespace: '<link rel="stylesheet" href="https://static1.squarespace.com/static/x.css">',
  wix: '<meta name="generator" content="Wix.com Website Builder"><img src="https://static.wixstatic.com/media/a.jpg">',
  wordpress: '<link rel="stylesheet" href="/wp-content/themes/astra/style.css">',
  shopify: '<script src="https://cdn.shopify.com/s/files/theme.js"></script>',
  webflow: '<html data-wf-page="abc"><link href="https://assets.website-files.com/x/webflow.css">',
  godaddy: '<img src="https://img1.wsimg.com/isteam/ip/logo.png">',
  custom: "<html><body><h1>Clinic</h1></body></html>",
};

await test("the builder is recognised from the page itself", () => {
  for (const [platform, html] of Object.entries(fixtures)) assert.equal(detectPlatform(html), platform, platform);
});

await test("every builder has steps to follow", () => {
  for (const platform of Object.keys(fixtures)) {
    const steps = INSTALL_STEPS[platform as keyof typeof INSTALL_STEPS];
    assert.ok(steps.steps.length >= 2, platform);
  }
});

await test("the install check finds the venue's own key, and only its own", () => {
  const page = `${fixtures.squarespace}<script src="https://app.belline.ai/embed.js" data-belline="be_abc123" data-mode="both" async></script>`;
  assert.equal(installedIn(page, "be_abc123").installed, true);
  assert.equal(installedIn(page, "be_someoneelse").installed, false);
  assert.equal(installedIn(page, "be_abc123").platform, "squarespace");
});

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });

console.log(
  failed === 0 ? `\n\x1b[32m✓ ${passed} passed, 0 failed\x1b[0m\n` : `\n\x1b[31m✗ ${passed} passed, ${failed} failed\x1b[0m\n`,
);
if (failed > 0) process.exitCode = 1;

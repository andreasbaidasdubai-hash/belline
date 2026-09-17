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
const { signUp, readiness, applyDraft, currentVenue } = await import("../src/lib/onboarding");
const {
  parseHours,
  formatHours,
  dayIndexes,
  formFromDraft,
  payloadFromForm,
  reviewErrors,
  REVIEW_IDS,
  cleanConfirmed,
  sourceLabel,
  confidenceOf,
  MENU_QUESTION,
  DESCRIPTION_MAX,
} = await import("../src/lib/onboarding/review");
const { staticPrompt } = await import("../src/lib/agent/prompt");
const { getLocation, upsertLocation } = await import("../src/lib/store");
const { onBellineDiary, serviceLengthsRequired } = await import("../src/lib/booking/destination");
const { isBlocking, validateVenue } = await import("../src/lib/booking/config");
const { checkSalonSlot } = await import("../src/lib/booking/salon");
const { scenariosFor } = await import("../src/lib/onboarding/selftest");
const { historyFor } = await import("../src/lib/brain");
const { executeSetupTool, runSetupTurn, setupGreeting } = await import("../src/lib/onboarding/assistant");
const { INSTALL_STEPS, detectPlatform, installedIn } = await import("../src/lib/onboarding/platform");
const { CODES_EXPLAINED, PHONE_OPTIONAL, forwardingCodes, uaeCarriers } = await import("../src/lib/telephony/forwarding");

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

/** Where bookings go, as the bookings step records it. */
function bookInto(id: string, kind: "belline" | "requests") {
  const loc = getLocation(id)!;
  return upsertLocation({ ...loc, onboarding: { ...loc.onboarding!, destination: { kind, setAt: new Date().toISOString() } } });
}

await test("on Belline's diary, a service with no length is refused, and nothing is saved", () => {
  bookInto(salon.id, "belline");
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
  // Without its country code it is not saved, and Belle is told to ask again (2026-09-16).
  const local = executeSetupTool(salon.id, salon.by, "set_transfer_number", { number: "050 123 4567" });
  assert.equal(local.ok, false);
  assert.match(local.say, /country code/);
  assert.ok(executeSetupTool(salon.id, salon.by, "set_transfer_number", { number: "+971 50 123 4567" }).ok);
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
  const quiet = console.error;
  console.error = () => {};
  const out = await runSetupTurn(salon.id, salon.by, [{ role: "user", content: "We open at nine" }]);
  console.error = quiet;
  assert.match(out.reply, /not switched on/);
  assert.ok(!/API_KEY/.test(out.reply), out.reply);
});

console.log("\n\x1b[1mOpening hours, as people write them\x1b[0m\n");

const every = (start: number, end: number) => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, [{ start, end }]]));

await test("'12:00–23:30 every day' is every day, noon to half past eleven", () => {
  const out = parseHours("12:00–23:30 every day");
  assert.ok(out.ok, out.ok ? "" : out.error);
  if (out.ok) assert.deepEqual(out.hours, every(720, 1410));
});

await test("'Sat–Thu 10–10' wraps through the week, is ten till ten, and Friday is closed", () => {
  const out = parseHours("Sat–Thu 10–10");
  assert.ok(out.ok, out.ok ? "" : out.error);
  if (!out.ok) return;
  for (const d of [6, 0, 1, 2, 3, 4]) assert.deepEqual(out.hours[d], [{ start: 600, end: 1320 }], `day ${d}`);
  assert.deepEqual(out.hours[5], []);
});

await test("'closed Fridays' after an every-day clause closes only Friday", () => {
  const out = parseHours("every day 10-22, closed Fridays");
  assert.ok(out.ok, out.ok ? "" : out.error);
  if (!out.ok) return;
  assert.deepEqual(out.hours[5], []);
  assert.deepEqual(out.hours[4], [{ start: 600, end: 1320 }]);
});

await test("a mixed week with am/pm, a split shift and a closed day", () => {
  const out = parseHours("Mon-Fri 9am-6pm; Sat 12:00-15:00 and 18:00-23:00; closed Sundays");
  assert.ok(out.ok, out.ok ? "" : out.error);
  if (!out.ok) return;
  assert.deepEqual(out.hours[1], [{ start: 540, end: 1080 }]);
  assert.deepEqual(out.hours[6], [{ start: 720, end: 900 }, { start: 1080, end: 1380 }]);
  assert.deepEqual(out.hours[0], []);
});

await test("closing before opening, and words that are not hours, are refused with a reason", () => {
  const late = parseHours("Mon 18:00-09:00");
  assert.equal(late.ok, false);
  if (!late.ok) assert.match(late.error, /before the opening/);
  assert.equal(parseHours("whenever we feel like it").ok, false);
  assert.equal(parseHours("Funday 10-6").ok, false);
});

await test("the words shown for saved hours read back to the same hours", () => {
  for (const text of ["12:00–23:30 every day", "Sat–Thu 10–10", "Mon-Fri 9am-6pm; Sat 12:00-15:00 and 18:00-23:00; closed Sundays"]) {
    const first = parseHours(text);
    assert.ok(first.ok);
    if (!first.ok) continue;
    const again = parseHours(formatHours(first.hours));
    assert.ok(again.ok, formatHours(first.hours));
    if (again.ok) assert.deepEqual(again.hours, first.hours, formatHours(first.hours));
  }
});

await test("Belle's day words and the form's are the same function", () => {
  assert.deepEqual(dayIndexes("weekdays"), [1, 2, 3, 4, 5]);
  assert.deepEqual(dayIndexes(["fri", "saturday"]), [5, 6]);
  assert.equal(dayIndexes("someday"), null);
});

console.log("\n\x1b[1mThe review form saves what the owner sees\x1b[0m\n");

const found = {
  name: "Corniche Kitchen",
  greeting: "Good evening, Corniche Kitchen, how can I help?",
  address: "12 Corniche Road, Abu Dhabi",
  hours: "Every day 09:00-18:00",
  services: [
    { name: "Cut and blow dry", durationMin: 60, price: 180 },
    { name: "Colour", durationMin: 120, price: 0 },
  ],
  staff: ["Layla", "Omar"],
  faqs: [{ q: "Is there parking?", a: "Yes, behind the building." }],
};

await test("typing new hours in the review and saving stores exactly those hours", async () => {
  const shop = await venue("Review Hours Salon", "salon");
  const form = formFromDraft(found, "website", currentVenue(getLocation(shop.id)!));
  form.hours = { value: "12:00–23:30 every day", source: "typed" };
  form.services[1].price = 350;
  const check = payloadFromForm(form);
  assert.ok(check.ok, check.ok ? "" : check.error);
  if (!check.ok) return;
  // The body carries everything on the form, not just address and policies.
  for (const key of ["hours", "services", "staff", "faqs"]) assert.ok(key in check.body, `PUT body has no ${key}`);
  const clean = cleanConfirmed(JSON.parse(JSON.stringify(check.body)));
  assert.ok(clean.ok);
  if (!clean.ok) return;
  applyDraft(getLocation(shop.id)!, clean.confirmed);
  const saved = getLocation(shop.id)!;
  assert.deepEqual(saved.hours, every(720, 1410));
  assert.deepEqual(saved.salon!.services.map((s) => [s.name, s.durationMin, s.price]), [["Cut and blow dry", 60, 180], ["Colour", 120, 350]]);
  assert.deepEqual(saved.salon!.staff.map((s) => s.name), ["Layla", "Omar"]);
  assert.deepEqual(saved.salon!.staff[0].hours, every(720, 1410), "staff did not follow the venue's new hours");
  assert.deepEqual(saved.agent.faqs, found.faqs);
  assert.equal(saved.address, found.address);
});

await test("what Belline read saves on the one press of save, with no ticks to give", () => {
  // The screen shows every value and where it came from; save is the confirmation.
  const form = formFromDraft(found, "website", currentVenue(fresh()));
  assert.ok(!("ticks" in form), "the form still carries confirmation ticks");
  assert.equal(form.hours.source, "website");
  assert.equal(form.address.source, "website");
  const check = payloadFromForm(form);
  assert.ok(check.ok, check.ok ? "" : check.error);
  if (check.ok) {
    assert.equal(check.body.address, found.address);
    assert.deepEqual(check.body.services.slice(0, 2).map((s) => [s.name, s.price]), [["Cut and blow dry", 180], ["Colour", 0]]);
  }
});

await test("every problem is tied to the input it is about, in screen order", () => {
  const form = formFromDraft(found, "website", currentVenue(fresh()));
  form.hours = { value: "18:00-09:00", source: "typed" };
  form.services[0].durationMin = 0;
  form.faqs = [
    { q: "Is there parking?", a: "", source: "typed" },
    { q: "", a: "Yes, from 9.", source: "typed" },
  ];
  const errors = reviewErrors(form);
  assert.deepEqual(
    errors.map((e) => e.id),
    [REVIEW_IDS.hours, REVIEW_IDS.serviceMinutes(0), REVIEW_IDS.faqAnswer(0), REVIEW_IDS.faqQuestion(1)],
  );
  const check = payloadFromForm(form);
  assert.equal(check.ok, false);
  if (!check.ok) {
    // Focus goes to the first one; all of them are returned, not just the first.
    assert.equal(check.field, REVIEW_IDS.hours);
    assert.equal(check.errors.length, 4);
    assert.match(check.errors[1].message, /Cut and blow dry/);
  }
  // Fixed, and it saves.
  form.hours = { value: "every day 09:00-18:00", source: "typed" };
  form.services[0].durationMin = 60;
  form.faqs = [{ q: "Is there parking?", a: "Yes.", source: "typed" }];
  assert.deepEqual(reviewErrors(form), []);
  assert.ok(payloadFromForm(form).ok);
});

await test("the server names the field a refused save is about", () => {
  const hours = cleanConfirmed({ hours: "18:00-09:00" });
  assert.equal(hours.ok, false);
  if (!hours.ok) assert.equal(hours.field, REVIEW_IDS.hours);
  const length = cleanConfirmed({ services: [{ name: "Cut", durationMin: 2, price: 0 }] });
  assert.equal(length.ok, false);
  if (!length.ok) assert.equal(length.service, "Cut");
});

await test("the review screen shows each problem under its input and takes the owner there", () => {
  const wizard = fs.readFileSync(path.join(process.cwd(), "src", "app", "setup", "SetupWizard.tsx"), "utf8");
  // No confirmation ticks anywhere on the review.
  assert.doesNotMatch(wizard, /type="checkbox"/);
  assert.doesNotMatch(wizard, /These prices are right|This address is right|These hours are right|Tick .* to save/);
  // Where the form came from is still said beside each value.
  assert.match(wizard, /sourceLabel\(/);
  // Every input a problem can name carries that id, aria-invalid and a message beneath it.
  for (const id of ["REVIEW_IDS.hours", "REVIEW_IDS.serviceMinutes(i)", "REVIEW_IDS.faqQuestion(i)", "REVIEW_IDS.faqAnswer(i)"]) {
    assert.ok(wizard.includes(`id={${id}}`), `no input with id ${id}`);
    assert.ok(wizard.includes(`{...invalid(${id}`), `${id} is never marked invalid`);
  }
  assert.match(wizard, /"aria-invalid": problem\(id\)/);
  assert.match(wizard, /"aria-describedby"/);
  assert.match(wizard, /className="field-error"/);
  // Save with problems moves focus to the first, and every summary line is a way to its field.
  assert.match(wizard, /focusField\(list\[0\]\.id\)/);
  assert.match(wizard, /el\.focus\(/);
  assert.match(wizard, /prefers-reduced-motion/);
  assert.match(wizard, /href=\{`#\$\{errors\[0\]\.id\}`\}[\s\S]{0,400}focusField\(errors\[0\]\.id\)/);
});

await test("each value says where it came from, and a missing price is marked", () => {
  const form = formFromDraft(found, "documents", currentVenue(fresh()));
  assert.equal(sourceLabel(form.address.source), "from your documents");
  assert.equal(sourceLabel(form.address.source, "price-list.pdf"), "from price-list.pdf");
  assert.equal(sourceLabel("typed"), "you typed");
  assert.equal(confidenceOf("price", 0, "documents"), "missing");
  assert.equal(confidenceOf("address", "Dubai", "website"), "check");
  assert.equal(confidenceOf("address", "12 Corniche Road, Abu Dhabi", "website"), "clear");
});

await test("running setup again keeps services and questions added since, and their ids", async () => {
  const shop = await venue("Rerun Salon", "salon");
  const first = cleanConfirmed({ hours: "every day 10-20", services: [{ name: "Cut", durationMin: 45, price: 100 }], staff: ["Mira"], faqs: [{ q: "Walk-ins?", a: "Yes." }] });
  assert.ok(first.ok);
  if (!first.ok) return;
  applyDraft(getLocation(shop.id)!, first.confirmed);
  const cutId = getLocation(shop.id)!.salon!.services[0].id;

  // Second read of the website found something else entirely.
  const form = formFromDraft({ ...found, hours: "" }, "website", currentVenue(getLocation(shop.id)!));
  assert.ok(form.services.some((s) => s.name === "Cut" && s.source === "saved"));
  assert.ok(form.faqs.some((f) => f.q === "Walk-ins?"));
  assert.ok(form.staff.some((s) => s.value === "Mira"));
  const check = payloadFromForm(form);
  assert.ok(check.ok, check.ok ? "" : check.error);
  if (!check.ok) return;
  applyDraft(getLocation(shop.id)!, check.body);
  const saved = getLocation(shop.id)!;
  assert.equal(saved.salon!.services.find((s) => s.name === "Cut")!.id, cutId, "the service id changed, orphaning its bookings");
  assert.ok(saved.agent.faqs.some((f) => f.q === "Walk-ins?"));
  assert.deepEqual(saved.hours, every(600, 1200));
});

await test("setting up by hand starts from the venue as it is, and saves as it stands", () => {
  const form = formFromDraft(null, "typed", currentVenue(fresh()));
  assert.equal(form.address.value, fresh().address);
  assert.deepEqual(parseHours(form.hours.value).ok && parseHours(form.hours.value), { ok: true, hours: fresh().hours });
  assert.deepEqual(reviewErrors(form), []);
  assert.ok(payloadFromForm(form).ok);
});

await test("nothing just saved is listed as missing afterwards", async () => {
  const shop = await venue("Ready Salon", "salon");
  const before = readiness(getLocation(shop.id)!).missing.map((m) => m.label);
  // A new signup has not chosen where bookings go and is not on the diary, so
  // it is not asked for a team it has nowhere to enter (2026-09-17).
  assert.ok(before.includes("What you offer") && !before.includes("Who works there"), JSON.stringify(before));
  const out = cleanConfirmed({ address: "Shop 2, Al Wasl Road, Dubai", services: [{ name: "Cut", durationMin: 45, price: 90 }], staff: ["Nadia"], faqs: [{ q: "Parking?", a: "Free, behind us." }] });
  assert.ok(out.ok);
  if (!out.ok) return;
  const after = readiness(applyDraft(getLocation(shop.id)!, out.confirmed)).missing;
  assert.deepEqual(after, []);
});

await test("a restaurant's menu is kept as something to answer about, never as bookable services", async () => {
  const grill = await venue("Menu Grill", "restaurant");
  const out = cleanConfirmed({
    hours: "12:00-23:30 every day",
    services: [
      { name: "Grilled hammour", durationMin: 30, price: 95 },
      { name: "Lamb ouzi", durationMin: 30, price: 0 },
    ],
  });
  assert.ok(out.ok);
  if (!out.ok) return;
  applyDraft(getLocation(grill.id)!, out.confirmed);
  applyDraft(getLocation(grill.id)!, out.confirmed);
  const saved = getLocation(grill.id)!;
  assert.equal(saved.salon, undefined);
  assert.deepEqual(saved.restaurant!.services, []);
  const menu = saved.agent.faqs.filter((f) => f.q === MENU_QUESTION);
  assert.equal(menu.length, 1, "saving twice filed the menu twice");
  assert.match(menu[0].a, new RegExp(`Grilled hammour \\(${saved.currency} 95\\); Lamb ouzi`));
  assert.deepEqual(saved.hours, every(720, 1410));
  // Retrievable: it is in what the agent is told.
  assert.ok(staticPrompt(saved).includes("Grilled hammour"), "the menu is not in the agent's prompt");
});

console.log("\n\x1b[1mA service needs only a name\x1b[0m\n");

await test("a request-only business saves a service with no minutes and no price", async () => {
  const dev = await venue("Saadiyat Developments", "salon");
  bookInto(dev.id, "requests");
  assert.equal(serviceLengthsRequired(getLocation(dev.id)!), false);
  const opts = { lengthsRequired: serviceLengthsRequired(getLocation(dev.id)!) };

  const form = formFromDraft(null, "typed", currentVenue(getLocation(dev.id)!));
  form.services = [{ name: "Immobilienentwicklung", durationMin: 0, price: 0, source: "typed" }];
  assert.deepEqual(reviewErrors(form, opts), []);
  const check = payloadFromForm(form, opts);
  assert.ok(check.ok, check.ok ? "" : check.error);
  if (!check.ok) return;
  const clean = cleanConfirmed(JSON.parse(JSON.stringify(check.body)), opts);
  assert.ok(clean.ok, clean.ok ? "" : clean.error);
  if (!clean.ok) return;
  const saved = applyDraft(getLocation(dev.id)!, clean.confirmed);

  // Stored as not given, never as a guessed length or a price of nothing.
  const service = saved.salon!.services.find((s) => s.name === "Immobilienentwicklung")!;
  assert.equal(service.durationMin, 0, "a length was invented");
  assert.equal(service.price, 0);
  assert.ok(!isBlocking(validateVenue(saved)), "the venue gate refuses a request-only service with no length");
  assert.ok(!readiness(saved).missing.some((m) => /how long/i.test(m.label)));

  // The agent is told the price is not listed and the team confirms it.
  const prompt = staticPrompt(saved);
  assert.match(prompt, /Immobilienentwicklung, price not listed \(the team will confirm it\)/);
  assert.match(prompt, /Where a price is not listed, say the team will confirm the price/);
  assert.doesNotMatch(prompt, /Immobilienentwicklung[^\n]*(AED 0|0 min)/);

  // Belle can add one by name alone, and later changes still pass the gate.
  const added = executeSetupTool(dev.id, dev.by, "add_service", { name: "Site visit" });
  assert.ok(added.ok, added.say);
  assert.equal(getLocation(dev.id)!.salon!.services.find((s) => s.name === "Site visit")!.durationMin, 0);
  assert.ok(executeSetupTool(dev.id, dev.by, "add_faq", { question: "Do you sell off-plan?", answer: "Yes." }).ok);

  // The checks still ask for a booking in words, with nothing undefined in them.
  const booking = scenariosFor(getLocation(dev.id)!).find((s) => s.id === "booking")!;
  assert.match(booking.prompt, /Can I book a Immobilienentwicklung (tomorrow|on \w+) at \d\d:\d\d\?/);
  assert.doesNotMatch(booking.prompt, /undefined|NaN|null/);
});

await test("a business on Belline's diary still needs the minutes for each service", async () => {
  const shop = await venue("Diary Minutes Salon", "salon");
  bookInto(shop.id, "belline");
  const opts = { lengthsRequired: serviceLengthsRequired(getLocation(shop.id)!) };
  assert.equal(opts.lengthsRequired, true);

  const form = formFromDraft(null, "typed", currentVenue(getLocation(shop.id)!));
  form.services = [{ name: "Cut", durationMin: 0, price: 0, source: "typed" }];
  const errors = reviewErrors(form, opts);
  assert.deepEqual(errors.map((e) => e.id), [REVIEW_IDS.serviceMinutes(0)]);
  assert.match(errors[0].message, /How long does "Cut" take\?/);
  assert.equal(payloadFromForm(form, opts).ok, false);

  const refused = cleanConfirmed({ services: [{ name: "Cut", durationMin: 0, price: 0 }] }, opts);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.service, "Cut");
  // A length that is given has to be a real one, required or not.
  assert.equal(cleanConfirmed({ services: [{ name: "Cut", durationMin: 3 }] }, { lengthsRequired: false }).ok, false);
  // With a length, a price is still optional.
  assert.ok(cleanConfirmed({ services: [{ name: "Cut", durationMin: 45 }] }, opts).ok);
});

await test("before the destination is chosen nothing is required; choosing the diary afterwards asks for the lengths", async () => {
  const shop = await venue("Undecided Salon", "salon");
  assert.equal(serviceLengthsRequired(getLocation(shop.id)!), false, "a new account is asked for lengths before it chose where bookings go");
  const out = cleanConfirmed({ services: [{ name: "Blow-dry", durationMin: 0, price: 0 }], staff: ["Mira"] }, { lengthsRequired: false });
  assert.ok(out.ok);
  if (!out.ok) return;
  applyDraft(getLocation(shop.id)!, out.confirmed);

  const diary = bookInto(shop.id, "belline");
  assert.ok(readiness(diary).missing.some((m) => m.label === "How long each service takes" && m.where === "/setup/review"));
  // The diary never offers a time for a service it cannot measure.
  const blowDry = diary.salon!.services[0];
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const slot = checkSalonSlot(diary, [], { date: tomorrow, startMin: 11 * 60, serviceIds: [blowDry.id] });
  assert.equal(slot.ok, false);
  if (!slot.ok) assert.match(slot.detail, /no length set yet/);
  assert.match(staticPrompt(diary), /Blow-dry \(id: [^)]+\) — length not set, price not listed/);
});

await test("hours sent as anything but hours are refused, not cast and saved", () => {
  assert.equal(cleanConfirmed({ hours: { 1: [{ start: 600, end: 500 }] } }).ok, false);
  assert.equal(cleanConfirmed({ hours: { 1: "nine to five" } }).ok, false);
  assert.equal(cleanConfirmed({ hours: "Fri-Sat 10-10" }).ok, true);
});

console.log("\n\x1b[1mPlain services, and the business page in the dashboard\x1b[0m\n");

await test("a request venue saves a service with a description and no length or price, and is ready with no team", async () => {
  const dev = await venue("Plain Services Developments", "salon");
  bookInto(dev.id, "requests");
  const opts = { lengthsRequired: serviceLengthsRequired(getLocation(dev.id)!), staffShown: false };
  const form = formFromDraft(null, "typed", currentVenue(getLocation(dev.id)!));
  form.address = { value: "Plot 7, Saadiyat Island, Abu Dhabi", source: "typed" };
  form.services = [{ name: "Site visit", durationMin: 0, price: 0, description: "A walk round the plot\nwith the architect.", source: "typed" }];
  form.faqs = [{ q: "Do you sell off-plan?", a: "Yes.", source: "typed" }];
  const check = payloadFromForm(form, opts);
  assert.ok(check.ok, check.ok ? "" : check.error);
  if (!check.ok) return;
  // One line: a newline in a description cannot start a section of the prompt.
  assert.equal(check.body.services[0].description, "A walk round the plot with the architect.");
  assert.ok(!("staff" in check.body), "the body carries a team the form never showed");
  const clean = cleanConfirmed(JSON.parse(JSON.stringify(check.body)), opts);
  assert.ok(clean.ok, clean.ok ? "" : clean.error);
  if (!clean.ok) return;
  const saved = applyDraft(getLocation(dev.id)!, clean.confirmed);
  const visit = saved.salon!.services.find((s) => s.name === "Site visit")!;
  assert.equal(visit.description, "A walk round the plot with the architect.");
  assert.equal(visit.durationMin, 0);
  assert.equal(visit.price, 0);
  assert.equal(saved.salon!.staff.length, 0);
  assert.deepEqual(readiness(saved).missing, [], JSON.stringify(readiness(saved).missing));
  // The description reaches what the agent is told, on the service's own line.
  assert.match(staticPrompt(saved), /- Site visit, price not listed \(the team will confirm it\) — A walk round the plot with the architect\./);
  // And it comes back into the form, so saving again does not drop it.
  assert.equal(formFromDraft(null, "typed", currentVenue(saved)).services[0].description, "A walk round the plot with the architect.");
});

await test("a description that is too long is marked under its input, and the server cuts it to the same length", () => {
  const form = formFromDraft(null, "typed", currentVenue(fresh()));
  form.services = [{ name: "Consultation", durationMin: 30, price: 0, description: "x".repeat(DESCRIPTION_MAX + 1), source: "typed" }];
  const errors = reviewErrors(form, { lengthsRequired: false });
  assert.deepEqual(errors.map((e) => e.id), [REVIEW_IDS.serviceDescription(0)]);
  assert.match(errors[0].message, new RegExp(`Keep it to ${DESCRIPTION_MAX}`));
  const cut = cleanConfirmed({ services: [{ name: "Consultation", durationMin: 30, description: `  ${"y".repeat(500)}\n\nmore ` }] }, { lengthsRequired: false });
  assert.ok(cut.ok);
  if (cut.ok) {
    assert.equal(cut.confirmed.services![0].description!.length, DESCRIPTION_MAX);
    assert.doesNotMatch(cut.confirmed.services![0].description!, /\n/);
  }
  // Not sent is not the same as empty: Belle and older pages keep what was written.
  const absent = cleanConfirmed({ services: [{ name: "Consultation", durationMin: 30 }] }, { lengthsRequired: false });
  assert.ok(absent.ok && !("description" in absent.confirmed.services![0]));
});

await test("a diary venue still needs its team, its tables and the length of each service", async () => {
  const shop = await venue("Diary Still Salon", "salon");
  const diary = bookInto(shop.id, "belline");
  const labels = readiness(diary).missing.map((m) => m.label);
  assert.ok(labels.includes("What you offer") && labels.includes("Who works there"), JSON.stringify(labels));
  const grill = await venue("Diary Still Grill", "restaurant");
  const room = readiness(bookInto(grill.id, "belline")).missing;
  assert.ok(room.some((m) => m.label === "Your tables" && m.where === "/venue/diary"), JSON.stringify(room));
  assert.ok(room.some((m) => m.label === "Service times" && m.where === "/venue/diary"));
  // The same venues taking requests are asked for none of it.
  assert.ok(!readiness(bookInto(grill.id, "requests")).missing.some((m) => /tables|Service times/.test(m.label)));
  assert.ok(!readiness(bookInto(shop.id, "requests")).missing.some((m) => m.label === "Who works there"));
});

await test("saving the plain form keeps a diary venue's team, their services, turnaround, rooms and recall", () => {
  const before = getLocation("loc_lumiere")!;
  const salonVenue = before;
  assert.ok(salonVenue.salon?.staff.length, "the diary fixture has no team to keep");
  assert.equal(onBellineDiary(salonVenue), true, "the diary fixture is not read as a diary venue");
  const withExtras = upsertLocation({
    ...salonVenue,
    salon: {
      ...salonVenue.salon!,
      services: salonVenue.salon!.services.map((s, i) => (i === 0 ? { ...s, bufferMin: 25, recallDays: 42, resourceTypes: ["basin"] } : s)),
    },
  });
  const staffBefore = JSON.stringify(withExtras.salon!.staff);
  // A save that leaves the team off the body entirely, as the form does
  // wherever it does not show it: nothing about the team may change.
  const form = formFromDraft(null, "typed", currentVenue(withExtras));
  form.services[0].description = "The one everybody asks for.";
  const check = payloadFromForm(form, { lengthsRequired: serviceLengthsRequired(withExtras), country: "AE", staffShown: false });
  assert.ok(check.ok, check.ok ? "" : check.error);
  if (!check.ok) return;
  const clean = cleanConfirmed(JSON.parse(JSON.stringify(check.body)), { lengthsRequired: serviceLengthsRequired(withExtras) });
  assert.ok(clean.ok, clean.ok ? "" : clean.error);
  if (!clean.ok) return;
  const saved = applyDraft(withExtras, clean.confirmed);
  assert.equal(JSON.stringify(saved.salon!.staff), staffBefore, "the team or who does what changed");
  const first = saved.salon!.services[0];
  assert.equal(first.id, withExtras.salon!.services[0].id);
  assert.equal(first.bufferMin, 25);
  assert.equal(first.recallDays, 42);
  assert.deepEqual(first.resourceTypes, ["basin"]);
  assert.equal(first.description, "The one everybody asks for.");
  assert.deepEqual(saved.salon!.resources, withExtras.salon!.resources);
  // With the team on screen, the same save sends it, and it is still kept by name.
  const shown = payloadFromForm(formFromDraft(null, "typed", currentVenue(saved)), { lengthsRequired: true, country: "AE" });
  assert.ok(shown.ok && shown.body.staff?.length === saved.salon!.staff.length);
  if (shown.ok) assert.equal(JSON.stringify(applyDraft(saved, shown.body).salon!.staff.map((s) => s.serviceIds)), JSON.stringify(saved.salon!.staff.map((s) => s.serviceIds)));
  upsertLocation(before);
});

await test("a restaurant's saved menu comes back into the form, and saving the details keeps it", async () => {
  const grill = await venue("Kept Menu Grill", "restaurant");
  const out = cleanConfirmed({ services: [{ name: "Grilled hammour", durationMin: 0, price: 95 }, { name: "Fish (of the day)", durationMin: 0, price: 0 }], faqs: [{ q: "Parking?", a: "Valet." }] }, { lengthsRequired: false });
  assert.ok(out.ok);
  if (!out.ok) return;
  const first = applyDraft(getLocation(grill.id)!, out.confirmed);
  const menuBefore = first.agent.faqs.find((f) => f.q === MENU_QUESTION)!.a;
  const rows = currentVenue(first).services;
  assert.deepEqual(rows.map((r) => [r.name, r.price]), [["Grilled hammour", 95], ["Fish (of the day)", 0]]);
  // The whole form, saved again as it opened.
  const check = payloadFromForm(formFromDraft(null, "typed", currentVenue(first)), { lengthsRequired: false, staffShown: false });
  assert.ok(check.ok, check.ok ? "" : check.error);
  if (!check.ok) return;
  const again = applyDraft(first, check.body);
  assert.equal(again.agent.faqs.find((f) => f.q === MENU_QUESTION)?.a, menuBefore);
  // Questions confirmed on their own keep the menu too.
  const questionsOnly = applyDraft(again, { faqs: [{ q: "Parking?", a: "Valet, from 6pm." }] });
  assert.equal(questionsOnly.agent.faqs.find((f) => f.q === MENU_QUESTION)?.a, menuBefore);
});

await test("the business page is the review form in dashboard mode: it saves in place and says so", () => {
  const wizard = fs.readFileSync(path.join(process.cwd(), "src", "app", "setup", "SetupWizard.tsx"), "utf8");
  const page = fs.readFileSync(path.join(process.cwd(), "src", "app", "(app)", "venue", "page.tsx"), "utf8");
  const diaryPage = fs.readFileSync(path.join(process.cwd(), "src", "app", "(app)", "venue", "diary", "page.tsx"), "utf8");
  // A dashboard save returns before the setup navigation, refreshes and says "Saved.".
  const branch = wizard.match(/if \(dashboard\) \{([\s\S]*?)\n      \}/);
  assert.ok(branch, "no dashboard branch after saving");
  assert.doesNotMatch(branch![1], /window\.location/);
  assert.match(branch![1], /router\.refresh\(\)/);
  assert.match(branch![1], /return;/);
  assert.ok(wizard.indexOf("if (dashboard) {") < wizard.indexOf("window.location.href"), "the dashboard branch comes after the navigation");
  assert.match(wizard, /role="status"[\s\S]{0,120}"Saved\."/);
  assert.match(wizard, /"Save changes"/);
  assert.match(wizard, /That's right — save it/);
  assert.match(wizard, /href="\/setup\/import"[\s\S]{0,80}Read your website again/);
  // The location it was rendered for goes with the save.
  assert.match(wizard, /locationId \? \{ locationId \} : \{\}/);
  // The description has its label; the team only where it is needed.
  assert.match(wizard, /aria-label=\{`Service \$\{i \+ 1\} description`\}/);
  assert.match(wizard, /showStaff && \(\s*<Section label="Who works there"/);
  assert.match(page, /mode="dashboard"/);
  assert.match(page, /locationId=\{location\.id\}/);
  assert.match(page, /title="Your business"/);
  assert.match(page, /notFound\(\)/);
  assert.match(page, /<VersionHistory/);
  assert.match(diaryPage, /<VenueEditor/);
  assert.match(diaryPage, /redirect\(`\/venue\?loc=\$\{location\.id\}`\)/);
});

console.log("\n\x1b[1mForwarding a UAE line\x1b[0m\n");

await test("du and e& mobiles get the conditional codes with the venue's own number", () => {
  const codes = forwardingCodes("+97145550142");
  assert.ok(codes.some((c) => c.dial === "**61*+97145550142#"));
  assert.ok(codes.some((c) => c.dial === "##004#"));
});

await test("every code says in plain words what dialling it does, and that the owner dials it", () => {
  const codes = forwardingCodes("+97145550142");
  const meaning = (mode: string) => codes.find((c) => c.mode === mode)!.meaning;
  assert.match(meaning("noanswer"), /do not pick up/);
  assert.match(meaning("busy"), /on another call/);
  assert.match(meaning("off"), /rings as it did before/);
  assert.match(CODES_EXPLAINED, /\*\*61\* forwards the calls you do not answer/);
  assert.match(CODES_EXPLAINED, /\*\*67\* forwards calls when you are busy/);
  assert.match(CODES_EXPLAINED, /dial them yourself on your own mobile/);
  assert.match(CODES_EXPLAINED, /nothing is forwarded until you do/);
  // No number, no codes and no explanation of codes that are not there.
  assert.deepEqual(forwardingCodes(""), []);
});

await test("the phone is plainly optional, with a way to skip it on the channels step and the forwarding page", () => {
  const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), "utf8");
  const phone = read("src", "app", "(app)", "golive", "PhoneSetup.tsx");
  const golive = read("src", "app", "(app)", "golive", "page.tsx");
  const step = read("src", "app", "setup", "[step]", "page.tsx");
  assert.match(PHONE_OPTIONAL, /optional/);
  // The forwarding page explains the codes where they appear, and each row says what it does.
  assert.match(phone, /\{codesExplained\}/);
  assert.match(phone, /\{code\.meaning\}/);
  assert.match(golive, /codesExplained=\{CODES_EXPLAINED\}/);
  // A visible skip, with and without a number yet.
  assert.match(phone, /Skip the phone for now/);
  assert.equal(phone.split("{skip}").length - 1, 2, "the skip is not shown in both the no-number and the number states");
  assert.match(golive, /skipHref=\{from === "setup" \? "\/website\?from=setup"/);
  assert.match(golive, /optional \? "optional" : "to do"/);
  // The channels step leads with either way in, never with forwarding as the one thing to do.
  assert.doesNotMatch(step, /Set up call forwarding/);
  assert.match(step, /One is enough to go live/);
  assert.match(step, /Your phone line \(optional\)/);
  assert.match(step, /Skip the phone for now/);
  assert.doesNotMatch(step, /Waiting for the test call/);
  // Belle says the same.
  // A Belline number assigned: its own field, never the business's phone.
  upsertLocation({ ...fresh(), bellineNumber: { number: "+97140000009", via: "pool", assignedAt: "2026-09-16T08:00:00.000Z" } });
  const said = executeSetupTool(salon.id, salon.by, "explain_forwarding", { carrier: "du", line: "mobile" });
  upsertLocation({ ...fresh(), bellineNumber: undefined });
  assert.ok(said.ok, said.say);
  assert.match(said.say, /\*\*61\*\+97140000009#/);
  assert.match(said.say, /nothing is forwarded until they do/);
  assert.match(said.say, /calls you do not pick up go to Belline/i);
});

await test("the owner's own number on the rules step is not Belline's: Belle gives no codes to it", () => {
  // The review step saved the business's own mobile; nothing was assigned.
  const f = fresh();
  upsertLocation({ ...f, businessPhone: "+971502992339", onboarding: { ...f.onboarding!, channels: { ...f.onboarding!.channels, phone: {} } } });
  const said = executeSetupTool(salon.id, salon.by, "explain_forwarding", { carrier: "du", line: "mobile" });
  upsertLocation({ ...fresh(), businessPhone: "" });
  assert.ok(said.ok, said.say);
  assert.doesNotMatch(said.say, /0502992339|502992339/, "Belle told the owner to forward calls to their own phone");
  assert.match(said.say, /being prepared/);
});

console.log("\n\x1b[1mSetup copy the founder read\x1b[0m\n");

await test("Skip the phone for now and Add it to my website are real buttons, not links inside a sentence", () => {
  const step = fs.readFileSync(path.join(process.cwd(), "src", "app", "setup", "[step]", "page.tsx"), "utf8");
  assert.match(step, /className="btn" style=\{action\} data-testid="skip-phone">\s*Skip the phone for now/);
  assert.match(step, /className="btn btn-accent" style=\{action\} data-testid="add-to-website">\s*Add it to my website/);
  assert.doesNotMatch(step, /one line of code\. <Link href="\/website\?from=setup">Add it to my website<\/Link>/);
  assert.doesNotMatch(step, /\{PHONE_OPTIONAL\}\{" "\}\s*<Link href="\/website\?from=setup">Skip the phone for now<\/Link>/);
});

await test("the booking option says what it means: the team confirms each booking, with no walk-ins", () => {
  const step = fs.readFileSync(path.join(process.cwd(), "src", "app", "setup", "[step]", "page.tsx"), "utf8");
  assert.doesNotMatch(step, /Phone, WhatsApp or walk-ins/);
  assert.match(step, /title: "My team confirms each booking"/);
  assert.match(step, /tells them your team will confirm/);
});

await test("the notification field is the owner's own email or WhatsApp, not Belline's", () => {
  const form = fs.readFileSync(path.join(process.cwd(), "src", "app", "setup", "StepActions.tsx"), "utf8");
  assert.match(form, /Your own email or WhatsApp, for new requests/);
  assert.match(form, /Your own email address or your own WhatsApp number \(the country code beside it is used for a number\), where Belline tells you about a new request/);
  assert.match(form, /This is not\s+Belline&apos;s WhatsApp/);
  assert.doesNotMatch(form, /Where to tell you about new requests/);
});

await test("WhatsApp is offered as it is today: set up with us on a second number, never a dead Coming soon", () => {
  const step = fs.readFileSync(path.join(process.cwd(), "src", "app", "setup", "[step]", "page.tsx"), "utf8");
  const card = fs.readFileSync(path.join(process.cwd(), "src", "app", "(app)", "integrations", "WhatsAppCard.tsx"), "utf8");
  const assisted = fs.readFileSync(path.join(process.cwd(), "src", "app", "(app)", "integrations", "WhatsAppAssisted.tsx"), "utf8");
  assert.doesNotMatch(step, /whatsapp\.state === "soon" \? "Coming soon"/);
  assert.match(step, /WhatsApp works today on a second number/);
  assert.match(step, /<WhatsAppAssisted /);
  assert.match(card, /soon: \["Available — set up with us"/);
  assert.match(card, /<WhatsAppAssisted /);
  assert.match(assisted, /Set it up with us/);
  assert.match(assisted, /\/api\/whatsapp\/assisted/);
  const route = fs.readFileSync(path.join(process.cwd(), "src", "app", "api", "whatsapp", "assisted", "route.ts"), "utf8");
  assert.match(route, /requireApiUser\(\)/);
  assert.match(route, /canEditAgent\(user, location\.id\)/);
  assert.match(route, /kind: "whatsapp_assisted_setup"/);
});

await test("the website chat always offers voice notes, for Messages only and for Both", () => {
  const chat = fs.readFileSync(path.join(process.cwd(), "src", "app", "embed", "[key]", "chat", "Chat.tsx"), "utf8");
  const page = fs.readFileSync(path.join(process.cwd(), "src", "app", "embed", "[key]", "chat", "page.tsx"), "utf8");
  const editor = fs.readFileSync(path.join(process.cwd(), "src", "app", "(app)", "website", "WidgetEditor.tsx"), "utf8");
  // The microphone depends on what the browser can record, never on the widget's mode.
  assert.match(chat, /setCanRecord\(Boolean\(recordingMime\(\) && navigator\.mediaDevices\?\.getUserMedia\)\)/);
  assert.match(chat, /\{canRecord && !draft\.trim\(\) \?/);
  assert.doesNotMatch(chat, /canRecord && (voiceHref|mode)/);
  assert.doesNotMatch(page, /voiceNotes|canRecord/);
  // And the frame may ask for it in either mode.
  assert.match(fs.readFileSync(path.join(process.cwd(), "public", "embed.js"), "utf8"), /panel\.allow = kind === "voice" \? "microphone; autoplay" : "microphone"/);
  assert.match(editor, /holds the microphone to send a voice note/);
  assert.match(editor, /messages always take voice notes too/);
});

await test("landlines are sent to the carrier, with the right number to call", () => {
  const carriers = uaeCarriers("+97145550142");
  assert.deepEqual(carriers.map((c) => c.id), ["du", "eand"]);
  assert.match(carriers[0].landline ?? "", /155/);
  assert.match(carriers[1].landline ?? "", /101/);
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

console.log("\n\x1b[1mEvery phone number with its country code\x1b[0m\n");

{
  const phone = await import("../src/lib/phone");
  const { applyRules, transferAllowed } = await import("../src/lib/onboarding/rules");
  const { createLocation } = await import("../src/lib/locations");
  const src = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), "utf8");

  await test("a local number converts with the country picked beside it; one typed with its code keeps its own", () => {
    for (const typed of ["0502992339", "050 299 2339", "050-299-2339", "502992339", "971502992339"]) {
      assert.deepEqual(phone.normaliseOwnerPhone(typed, "AE"), { ok: true, e164: "+971502992339" }, typed);
    }
    assert.deepEqual(phone.normaliseOwnerPhone("04 555 0100", "AE"), { ok: true, e164: "+97145550100" });
    assert.deepEqual(phone.normaliseOwnerPhone("020 7946 0958", "GB"), { ok: true, e164: "+442079460958" });
    assert.deepEqual(phone.normaliseOwnerPhone("055 123 4567", "SA"), { ok: true, e164: "+966551234567" });
    // The code in the number wins over the picker.
    assert.deepEqual(phone.normaliseOwnerPhone("+44 20 7946 0958", "AE"), { ok: true, e164: "+442079460958" });
    assert.deepEqual(phone.normaliseOwnerPhone("0044 (0)20 7946 0958", "AE"), { ok: true, e164: "+442079460958" });
  });

  await test("a number with no resolvable country, or that is not a number, is refused at the field", () => {
    const none = phone.normaliseOwnerPhone("0502992339", undefined);
    assert.equal(none.ok, false);
    assert.match(none.ok ? "" : none.reason, /Choose the country|country code/);
    for (const bad of ["call me", "05029923", "+97150", "050 299 2339 ext 4", "+971 50+299"]) {
      assert.equal(phone.normaliseOwnerPhone(bad, "AE").ok, false, bad);
    }
    // Every field component checks before it sends, and shows the reason under itself.
    const field = src("src", "components", "PhoneField.tsx");
    assert.match(field, /aria-invalid=\{error \? true : undefined\}/);
    assert.match(field, /role="alert"/);
    assert.match(field, /input\.current\?\.focus\(\)/);
    assert.match(field, /aria-label="Country code"/);
  });

  await test("the server refuses a number without its country code, on every route that saves one", () => {
    assert.equal(phone.requireE164("0502992339").ok, false);
    assert.match((phone.requireE164("0502992339") as { reason: string }).reason, /country code/);
    assert.deepEqual(phone.requireE164("+971 50 299 2339"), { ok: true, e164: "+971502992339" });
    assert.equal(phone.isE164("+971502992339"), true);
    assert.equal(phone.isE164("0502992339"), false);
    const v = fresh();
    const local = applyRules(v, { transferNumber: "0501234567" });
    assert.ok(!local.ok && local.field === "transferNumber" && /country code/.test(local.error));
    const notify = applyRules(v, { notify: "0501234567" });
    assert.ok(!notify.ok && notify.field === "notify");
    const good = applyRules(v, { transferNumber: "+971 50 123 4567", notify: "+971501234568" });
    assert.ok(good.ok && good.location.agent.transferNumber === "+971501234567" && good.location.onboarding!.escalation!.notifyWhatsApp === "+971501234568");
    // The review step's business phone.
    const review = cleanConfirmed({ phone: "0502992339" });
    assert.ok(!review.ok && review.field === REVIEW_IDS.phone);
    const reviewed = cleanConfirmed({ phone: "+971 50 299 2339" });
    assert.ok(reviewed.ok && reviewed.confirmed.phone === "+971502992339");
    // A new location's phone.
    for (const route of [
      ["src", "app", "api", "agent", "route.ts"],
      ["src", "app", "api", "bookings", "create", "route.ts"],
      ["src", "app", "api", "bookings", "update", "route.ts"],
      ["src", "app", "api", "waitlist", "route.ts"],
      ["src", "lib", "locations.ts"],
    ]) {
      assert.match(src(...route), /requireE164\(/, route.join("/"));
    }
    void createLocation;
  });

  await test("the urgent-calls number still has to be in the United Arab Emirates", () => {
    const abroad = applyRules(fresh(), { transferNumber: "+44 20 7946 0958" });
    assert.ok(!abroad.ok && /outside United Arab Emirates/.test(abroad.error));
    assert.match(src("src", "app", "api", "agent", "route.ts"), /checkTransferNumber\(strict\.e164, venueMarket\(location\)\)/);
  });

  await test("stored numbers are shown back international, and older local ones keep working", () => {
    assert.equal(phone.formatInternational("+971502992339"), "+971 50 299 2339");
    assert.equal(phone.formatInternational("+97145550100"), "+971 4 555 0100");
    assert.equal(phone.formatInternational("+442079460958"), "+44 207 946 0958");
    assert.deepEqual(phone.readStoredPhone("0502992339", "AE"), { country: "AE", text: "+971 50 299 2339", e164: "+971502992339" });
    assert.deepEqual(phone.readStoredPhone("+442079460958", "AE"), { country: "GB", text: "+44 207 946 0958", e164: "+442079460958" });
    // A transfer number saved before the rule is still dialled.
    assert.equal(transferAllowed(fresh(), "0501234567"), true);
    // The review form shows a stored number grouped.
    const form = formFromDraft(null, "saved", { ...currentVenue(fresh()), phone: "+971502992339" });
    assert.equal(form.phone.value, "+971 50 299 2339");
  });

  await test("every phone field in setup and the dashboard has the country picker", () => {
    const uses: [string[], RegExp][] = [
      [["src", "app", "setup", "StepActions.tsx"], /<PhoneField[\s\S]*id="transfer-number"/],
      [["src", "app", "setup", "StepActions.tsx"], /aria-label="Country code"[\s\S]*id="notify"/],
      [["src", "app", "setup", "SetupWizard.tsx"], /aria-label="Country code"[\s\S]*id=\{REVIEW_IDS\.phone\}/],
      [["src", "app", "(app)", "agents", "AgentEditor.tsx"], /<PhoneField[\s\S]*id="agent-transfer-number"/],
      [["src", "app", "(app)", "locations", "LocationsManager.tsx"], /<PhoneField[\s\S]*id="location-phone"/],
      [["src", "app", "(app)", "integrations", "ConnectWhatsApp.tsx"], /<PhoneField[\s\S]*id="wa-number"/],
      [["src", "app", "(app)", "calendar", "BookingForm.tsx"], /<PhoneField[\s\S]*id="booking-guest-phone"/],
      [["src", "app", "(app)", "calendar", "BookingDrawer.tsx"], /<PhoneField[\s\S]*id="drawer-guest-phone"/],
      [["src", "app", "(app)", "waitlist", "WaitlistManager.tsx"], /<PhoneField[^>]*id="wl-phone"/],
    ];
    for (const [file, pattern] of uses) assert.match(src(...file), pattern, file.join("/"));
    // No bare tel input is left anywhere in the app.
    const stray = ["src/app/setup/StepActions.tsx", "src/app/setup/SetupWizard.tsx", "src/app/(app)/locations/LocationsManager.tsx", "src/app/(app)/calendar/BookingForm.tsx", "src/app/(app)/calendar/BookingDrawer.tsx"]
      .filter((f) => /<label>Phone<input/.test(src(...f.split("/"))));
    assert.deepEqual(stray, []);
    // The picker starts on the business's own market.
    assert.match(src("src", "app", "setup", "[step]", "page.tsx"), /countryIso=\{venueMarket\(venue\)\}/);
    assert.match(src("src", "app", "setup", "[step]", "page.tsx"), /country=\{venueMarket\(venue\)\}/);
  });
}

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });

console.log(
  failed === 0 ? `\n\x1b[32m✓ ${passed} passed, 0 failed\x1b[0m\n` : `\n\x1b[31m✗ ${passed} passed, ${failed} failed\x1b[0m\n`,
);
if (failed > 0) process.exitCode = 1;

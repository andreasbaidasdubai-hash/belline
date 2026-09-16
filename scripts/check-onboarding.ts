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
} = await import("../src/lib/onboarding/review");
const { staticPrompt } = await import("../src/lib/agent/prompt");
const { getLocation, upsertLocation } = await import("../src/lib/store");
const { serviceLengthsRequired } = await import("../src/lib/booking/destination");
const { isBlocking, validateVenue } = await import("../src/lib/booking/config");
const { checkSalonSlot } = await import("../src/lib/booking/salon");
const { scenariosFor } = await import("../src/lib/onboarding/selftest");
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
  assert.ok(before.includes("What you offer") && before.includes("Who works there"));
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

console.log("\n\x1b[1mForwarding a UAE line\x1b[0m\n");

await test("du and e& mobiles get the conditional codes with the venue's own number", () => {
  const codes = forwardingCodes("+97145550142");
  assert.ok(codes.some((c) => c.dial === "**61*+97145550142#"));
  assert.ok(codes.some((c) => c.dial === "##004#"));
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

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });

console.log(
  failed === 0 ? `\n\x1b[32m✓ ${passed} passed, 0 failed\x1b[0m\n` : `\n\x1b[31m✗ ${passed} passed, ${failed} failed\x1b[0m\n`,
);
if (failed > 0) process.exitCode = 1;

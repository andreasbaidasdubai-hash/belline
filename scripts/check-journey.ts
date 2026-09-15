/**
 * The journey from signup to live.
 *
 * `journey()` decides the one next step every surface shows, so it is checked
 * as a table: a venue in a given state, and the step and Go live answer it must
 * give. Then the backfill, which runs on every boot against real customers'
 * venues and must mark the live ones live, change nothing else, and do nothing
 * the second time.
 *
 *   npm run check:journey
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-journey-"));

const { seedIfEmpty } = await import("../src/lib/seed");
const { signUp } = await import("../src/lib/onboarding");
const { getLocation, listLocations, upsertLocation, saveCall } = await import("../src/lib/store");
const {
  STEP_IDS,
  NO_FACTS,
  backfillOnboarding,
  factsFrom,
  isActivated,
  journey,
  journeyFor,
  markReviewed,
  navCollapsed,
  recordStep,
} = await import("../src/lib/onboarding/journey");
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
    console.log(`      ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

const ROOT = path.resolve(import.meta.dirname, "..");
const source = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

seedIfEmpty();

const made = await signUp({ businessName: "Journey Studio", email: "owner@journey.test", password: "Correct-Horse-Battery-9", vertical: "salon" });
assert.ok(made.ok);
const fresh = made.ok ? made.location : null!;
const now = new Date("2026-09-15T10:00:00.000Z");
const at = now.toISOString();

/** The fresh venue with everything readiness() asks for. */
const complete = (l: Loc): Loc => ({
  ...l,
  address: "Shop 4, Jumeirah Beach Road, Dubai",
  salon: {
    ...l.salon!,
    services: [{ id: "svc_cut", name: "Cut", durationMin: 45, bufferMin: 10, price: 120 }],
    staff: [{ id: "stf_layla", name: "Layla", serviceIds: ["svc_cut"], hours: l.hours, timeOff: [] }],
  },
  agent: { ...l.agent, faqs: [{ q: "Is there parking?", a: "Yes." }] },
});
const withState = (l: Loc, patch: Partial<NonNullable<Loc["onboarding"]>>): Loc => ({
  ...l,
  onboarding: { version: 1, channels: {}, ...l.onboarding, ...patch },
});

console.log("\n\x1b[1mOne next step\x1b[0m\n");

await test("a new signup starts on reading the business, with a record and no activation", () => {
  assert.deepEqual(getLocation(fresh.id)!.onboarding, { version: 1, channels: {} });
  const j = journey(fresh, NO_FACTS, now);
  assert.equal(j.next?.id, "import");
  assert.equal(j.next?.url, "/setup/import");
  assert.equal(j.canGoLive, false);
  assert.equal(j.activated, false);
});

const reviewed = withState(complete(fresh), { reviewedAt: at });
const table: { name: string; venue: Loc; facts?: typeof NO_FACTS; next: string | null; canGoLive: boolean }[] = [
  { name: "imported, not reviewed", venue: withState(fresh, { importedAt: at }), next: "review", canGoLive: false },
  { name: "set up by hand (reviewed, never imported)", venue: withState(fresh, { reviewedAt: at }), next: "bookings", canGoLive: false },
  { name: "destination chosen", venue: withState(reviewed, { destination: { kind: "belline", setAt: at } }), next: "rules", canGoLive: false },
  {
    name: "rules confirmed",
    venue: withState(reviewed, { destination: { kind: "belline", setAt: at }, rulesConfirmedAt: at }),
    next: "channels",
    canGoLive: false,
  },
  {
    name: "a forwarded call arrived",
    venue: withState(reviewed, { destination: { kind: "belline", setAt: at }, rulesConfirmedAt: at }),
    facts: { ...NO_FACTS, phoneCalls: 1 },
    next: "test",
    canGoLive: false,
  },
  {
    name: "a website conversation counts as a channel too",
    venue: withState(reviewed, { destination: { kind: "belline", setAt: at }, rulesConfirmedAt: at }),
    facts: { ...NO_FACTS, webConversations: 2 },
    next: "test",
    canGoLive: false,
  },
  {
    name: "tested in the console: Go live is offered",
    venue: withState(reviewed, { destination: { kind: "belline", setAt: at }, rulesConfirmedAt: at }),
    facts: { ...NO_FACTS, phoneCalls: 1, testConversations: 1 },
    next: "golive",
    canGoLive: true,
  },
  {
    name: "every step done but no services: Go live is not offered",
    venue: withState(fresh, { reviewedAt: at, destination: { kind: "belline", setAt: at }, rulesConfirmedAt: at }),
    facts: { ...NO_FACTS, phoneCalls: 1, testConversations: 1 },
    next: "golive",
    canGoLive: false,
  },
  { name: "live, no enquiry yet", venue: withState(reviewed, { activatedAt: at }), next: "first-week", canGoLive: false },
  {
    name: "live a week with an enquiry: nothing left",
    venue: withState(reviewed, { activatedAt: "2026-09-01T10:00:00.000Z" }),
    facts: { ...NO_FACTS, enquiriesSinceLive: 3 },
    next: null,
    canGoLive: false,
  },
];

for (const row of table) {
  await test(`${row.name} → ${row.next ?? "nothing"}${row.canGoLive ? ", can go live" : ""}`, () => {
    const j = journey(row.venue, row.facts ?? NO_FACTS, now);
    assert.equal(j.next?.id ?? null, row.next);
    assert.equal(j.canGoLive, row.canGoLive);
    if (j.next) assert.match(j.next.url, /^\/setup\/[a-z-]+$/);
  });
}

await test("for any state short of finished, next is exactly one step with a URL", () => {
  for (const row of table.filter((r) => r.next)) {
    const j = journey(row.venue, row.facts ?? NO_FACTS, now);
    assert.equal(j.steps.filter((s) => s === j.next).length, 1);
    assert.equal(j.steps.length, STEP_IDS.length);
    // Everything before the next step is done: there is never a skipped hole.
    assert.ok(j.steps.slice(0, j.next!.n - 1).every((s) => s.done), row.name);
  }
});

await test("a blocker from readiness links to its editor with the way back to setup", () => {
  const row = table.find((r) => r.name.startsWith("every step done but no services"))!;
  const j = journey(row.venue, row.facts, now);
  assert.ok(j.blockers.length > 0);
  assert.ok(j.blockers.every((b) => b.fix.endsWith("?from=setup") || b.fix.startsWith("/setup/")));
  assert.ok(j.blockers.some((b) => /What you offer/.test(b.label)));
});

await test("an unfinished step is a blocker, listed before anything readiness finds", () => {
  const j = journey(withState(fresh, { importedAt: at }), NO_FACTS, now);
  assert.equal(j.blockers[0].step, "review");
  assert.equal(j.blockers[0].fix, "/setup/review");
});

console.log("\n\x1b[1mResuming\x1b[0m\n");

await test("the step comes back from what is saved, after the process forgets everything", () => {
  upsertLocation(withState(complete(getLocation(fresh.id)!), { reviewedAt: at, destination: { kind: "belline", setAt: at } }));
  assert.equal(journeyFor(getLocation(fresh.id)!, now).next?.id, "rules");
  // A new process: the in-memory cache is gone and only the files remain.
  (globalThis as { __bellineDb?: unknown }).__bellineDb = undefined;
  assert.equal(journeyFor(getLocation(fresh.id)!, now).next?.id, "rules");
});

await test("facts are counted from real calls only: demo calls do not complete a step", () => {
  const base = { locationId: fresh.id, status: "completed" as const, transcript: [], startedAt: at };
  saveCall({ ...base, id: "call_demo", channel: "phone", isDemo: true } as never);
  assert.equal(factsFrom(getLocation(fresh.id)!, [{ ...base, id: "d", channel: "phone", isDemo: true } as never]).phoneCalls, 0);
  const counted = factsFrom(getLocation(fresh.id)!, [
    { ...base, id: "a", channel: "phone" } as never,
    { ...base, id: "b", channel: "browser" } as never,
    { ...base, id: "c", channel: "webchat" } as never,
  ]);
  assert.deepEqual(counted, { phoneCalls: 1, webConversations: 1, testConversations: 1, enquiriesSinceLive: 0 });
});

console.log("\n\x1b[1mOwner actions\x1b[0m\n");

await test("the review save records review, and import only when something was read", () => {
  const typed = markReviewed(fresh, ["hours", "services"], false, now).onboarding!;
  assert.equal(typed.reviewedAt, at);
  assert.equal(typed.importedAt, undefined);
  assert.deepEqual(typed.reviewedFields, ["hours", "services"]);
  assert.equal(markReviewed(fresh, [], true, now).onboarding!.importedAt, at);
});

await test("only a destination Belline can honour today is accepted", () => {
  for (const kind of ["google", "outlook", "requests", "partner", "nonsense"]) {
    const out = recordStep(fresh, { kind: "destination", destination: kind as never }, NO_FACTS, now);
    assert.equal(out.ok, false, kind);
    if (!out.ok) assert.doesNotMatch(out.error, /undefined|Error|flag/);
  }
  const ok = recordStep(fresh, { kind: "destination", destination: "belline" }, NO_FACTS, now);
  assert.ok(ok.ok);
  if (ok.ok) assert.deepEqual(ok.location.onboarding!.destination, { kind: "belline", setAt: at });
});

await test("rules confirmation is recorded", () => {
  const out = recordStep(fresh, { kind: "rules" }, NO_FACTS, now);
  assert.ok(out.ok && out.location.onboarding!.rulesConfirmedAt === at);
});

await test("Go live is refused with the first blocker and its fix, however it is asked for", () => {
  const out = recordStep(withState(fresh, { importedAt: at }), { kind: "activate", by: "usr_1" }, NO_FACTS, now);
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.status, 409);
    assert.match(out.error, /Check what it knows/);
    assert.equal(out.fix, "/setup/review");
  }
});

await test("Go live is accepted when the journey allows it, and not twice", () => {
  const ready = table.find((r) => r.canGoLive)!;
  const out = recordStep(ready.venue, { kind: "activate", by: "usr_1" }, ready.facts!, now);
  assert.ok(out.ok);
  if (!out.ok) return;
  assert.equal(out.location.onboarding!.activatedAt, at);
  assert.equal(out.location.onboarding!.activatedBy, "usr_1");
  assert.equal(journey(out.location, ready.facts, now).next?.id, "first-week");
  const again = recordStep(out.location, { kind: "activate", by: "usr_1" }, ready.facts!, now);
  assert.ok(!again.ok && again.status === 409);
});

console.log("\n\x1b[1mThe nav\x1b[0m\n");

await test("an owner whose only business is in setup gets the collapsed nav; staff and live owners do not", () => {
  const setup = withState(fresh, {});
  const live = withState(fresh, { activatedAt: at });
  assert.equal(navCollapsed([setup], false), true);
  assert.equal(navCollapsed([setup], true), false);
  assert.equal(navCollapsed([live], false), false);
  assert.equal(navCollapsed([setup, live], false), false);
  assert.equal(navCollapsed([], false), false);
  // A venue that predates the journey and has not been backfilled yet is live.
  assert.equal(navCollapsed([{ ...fresh, onboarding: undefined }], false), false);
});

console.log("\n\x1b[1mBackfill\x1b[0m\n");

await test("every seeded venue is marked live, on Belline's diary", () => {
  const all = listLocations({ includeInternal: true, includeArchived: true }).filter((l) => l.id !== fresh.id);
  assert.ok(all.length > 0);
  for (const l of all) {
    assert.ok(l.onboarding?.activatedAt, `${l.id} is not live`);
    assert.equal(l.onboarding?.destination?.kind, "belline");
    assert.ok(isActivated(l));
  }
});

await test("a live venue from before the journey changes in nothing but the new record", () => {
  const old: Loc = { ...complete(fresh), phone: "+97140000000", onboarding: undefined, brainHistory: [{ createdAt: "2026-03-01T09:00:00.000Z" } as never] };
  const filled = backfillOnboarding(old, NO_FACTS, now)!;
  const { onboarding, ...rest } = filled;
  const { onboarding: _none, ...before } = old;
  assert.deepEqual(rest, before);
  assert.equal(onboarding!.activatedAt, "2026-03-01T09:00:00.000Z");
  assert.equal(onboarding!.activatedBy, "backfill");
  assert.equal(journey(filled, NO_FACTS, now).next?.id, "first-week");
});

await test("real calls, an active subscription or the original tenants each count as live", () => {
  const blank: Loc = { ...fresh, onboarding: undefined, phone: "" };
  assert.ok(backfillOnboarding(blank, { ...NO_FACTS, phoneCalls: 2 }, now)!.onboarding!.activatedAt);
  assert.ok(backfillOnboarding(blank, { ...NO_FACTS, webConversations: 1 }, now)!.onboarding!.activatedAt);
  assert.ok(backfillOnboarding({ ...blank, subscription: { ...fresh.subscription!, status: "active" } }, NO_FACTS, now)!.onboarding!.activatedAt);
  assert.ok(backfillOnboarding(blank, NO_FACTS, now, true)!.onboarding!.activatedAt);
});

await test("a trial part way through setup is not marked live, and is reviewed only if complete", () => {
  const blank: Loc = { ...fresh, onboarding: undefined, phone: "" };
  const unfinished = backfillOnboarding(blank, { ...NO_FACTS, testConversations: 3 }, now)!.onboarding!;
  assert.equal(unfinished.activatedAt, undefined);
  assert.equal(unfinished.reviewedAt, undefined);
  const ready = backfillOnboarding(complete(blank), NO_FACTS, now)!.onboarding!;
  assert.equal(ready.activatedAt, undefined);
  assert.ok(ready.reviewedAt);
  assert.equal(journey({ ...blank, onboarding: ready }, NO_FACTS, now).next?.id, "bookings");
});

await test("backfill is idempotent: a record is never rewritten, and a second boot writes nothing", () => {
  const once = backfillOnboarding({ ...fresh, onboarding: undefined }, NO_FACTS, now)!;
  assert.equal(backfillOnboarding(once, { ...NO_FACTS, phoneCalls: 9 }, now), null);

  // Content, not the file's timestamp: other boot steps re-save our own
  // internal venue every time, unchanged.
  const file = path.join(process.env.DATA_DIR!, "locations.json");
  const before = fs.readFileSync(file, "utf8");
  seedIfEmpty();
  seedIfEmpty();
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

await test("a venue saved without a record is backfilled on the next boot", () => {
  const legacy = { ...getLocation(fresh.id)!, id: "loc_legacy_journey", phone: "+97140000001", onboarding: undefined };
  upsertLocation(legacy);
  seedIfEmpty();
  assert.ok(getLocation("loc_legacy_journey")!.onboarding?.activatedAt);
});

console.log("\n\x1b[1mSurfaces read the journey\x1b[0m\n");

await test("the shell, the nav, the home page, login and the setup save all use it", () => {
  assert.match(source("src/app/(app)/layout.tsx"), /navCollapsed\(visible, isBellineStaff\(user\)\)/);
  assert.match(source("src/app/setup/page.tsx"), /journeyFor\(venue\)\.next\?\.url/);
  assert.match(source("src/app/(app)/page.tsx"), /journeyFor\(location\)/);
  assert.match(source("src/app/api/auth/login/route.ts"), /navCollapsed\(/);
  assert.match(source("src/app/api/setup/route.ts"), /markReviewed\(/);
  assert.match(source("src/app/api/setup/journey/route.ts"), /recordStep\(/);
});

await test("Go live is rendered only inside the canGoLive branch", () => {
  const page = source("src/app/setup/[step]/page.tsx");
  const button = page.indexOf('action="activate"');
  assert.ok(button > 0);
  assert.equal(page.split('action="activate"').length, 2, "more than one Go live button");
  const branch = page.lastIndexOf("j.canGoLive ? (", button);
  assert.ok(branch > 0 && button - branch < 400, "the Go live button is not inside j.canGoLive ? (...)");
});

await test("the old two-step wizard and its done screen are gone", () => {
  const wizard = source("src/app/setup/SetupWizard.tsx");
  assert.doesNotMatch(wizard, /Step 1 of 2|alreadyReady|stage === "done"/);
  assert.match(wizard, /body\.next/);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);

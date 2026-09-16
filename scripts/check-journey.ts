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
  answersRealCustomers,
  channelStatuses,
  checklistOf,
  isActivated,
  journey,
  journeyFor,
  markReviewed,
  recordStep,
  stepAfter,
} = await import("../src/lib/onboarding/journey");
const { configDigest } = await import("../src/lib/onboarding/selftest-state");
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

/** The venue with a checks run recorded against it exactly as it is. */
const tested = (l: Loc, ok = true): Loc => withState(l, { tests: { runId: "run_1", at, results: [], passed: ok, digest: configDigest(l) } });

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
    name: "talked to it in the console, no checks run: the checks still block",
    venue: withState(reviewed, { destination: { kind: "belline", setAt: at }, rulesConfirmedAt: at }),
    facts: { ...NO_FACTS, phoneCalls: 1, testConversations: 3 },
    next: "test",
    canGoLive: false,
  },
  {
    name: "checks passed: Go live is offered",
    venue: tested(withState(reviewed, { destination: { kind: "belline", setAt: at }, rulesConfirmedAt: at })),
    facts: { ...NO_FACTS, phoneCalls: 1 },
    next: "golive",
    canGoLive: true,
  },
  {
    name: "checks failed: back to the checks",
    venue: tested(withState(reviewed, { destination: { kind: "belline", setAt: at }, rulesConfirmedAt: at }), false),
    facts: { ...NO_FACTS, phoneCalls: 1 },
    next: "test",
    canGoLive: false,
  },
  {
    name: "checks passed, then the setup changed: the checks are stale",
    venue: (() => {
      const l = tested(withState(reviewed, { destination: { kind: "belline", setAt: at }, rulesConfirmedAt: at }));
      return { ...l, agent: { ...l.agent, greeting: "A different greeting." } };
    })(),
    facts: { ...NO_FACTS, phoneCalls: 1 },
    next: "test",
    canGoLive: false,
  },
  {
    name: "every step done but no services: Go live is not offered",
    venue: tested(withState(fresh, { reviewedAt: at, destination: { kind: "belline", setAt: at }, rulesConfirmedAt: at })),
    facts: { ...NO_FACTS, phoneCalls: 1 },
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

await test("a stale or failed run says why in the first blocker", () => {
  const stale = table.find((r) => r.name.includes("the checks are stale"))!;
  assert.match(journey(stale.venue, stale.facts, now).blockers[0].label, /changed your setup after the last checks/);
  const bad = table.find((r) => r.name.startsWith("checks failed"))!;
  assert.match(journey(bad.venue, bad.facts, now).blockers[0].label, /did not pass/);
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

await test("requests are accepted; calendars, partners and (for a new signup) the diary are not", () => {
  for (const kind of ["google", "outlook", "partner", "nonsense", "belline"]) {
    const out = recordStep(fresh, { kind: "destination", destination: kind as never }, NO_FACTS, now);
    assert.equal(out.ok, false, kind);
    if (!out.ok) assert.doesNotMatch(out.error, /undefined|Error|flag/);
  }
  const ok = recordStep(fresh, { kind: "destination", destination: "requests" }, NO_FACTS, now);
  assert.ok(ok.ok);
  if (ok.ok) assert.deepEqual(ok.location.onboarding!.destination, { kind: "requests", setAt: at });
  process.env.FLAG_BELLINE_DIARY = "on";
  try {
    assert.ok(recordStep(fresh, { kind: "destination", destination: "belline" }, NO_FACTS, now).ok, "FLAG_BELLINE_DIARY=on offers the diary");
  } finally {
    delete process.env.FLAG_BELLINE_DIARY;
  }
});

await test("rules confirmation is recorded, once a destination is chosen", () => {
  const early = recordStep(fresh, { kind: "rules" }, NO_FACTS, now);
  assert.ok(!early.ok && early.status === 409 && early.fix === "/setup/bookings");
  const out = recordStep(withState(fresh, { destination: { kind: "requests", setAt: at } }), { kind: "rules" }, NO_FACTS, now);
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

console.log("\n\x1b[1mThe dashboard is never behind setup\x1b[0m\n");

await test("the menu is the full seven destinations from signup: nothing collapses it until go-live", () => {
  const shell = source("src/app/(app)/layout.tsx");
  assert.doesNotMatch(shell, /navCollapsed|collapsed \?/, "the shell still collapses the menu");
  assert.match(shell, /const nav = shape\.items;/);
  assert.doesNotMatch(source("src/lib/onboarding/journey.ts"), /export function navCollapsed/);
  // Signing in, or back in after a reset, lands on the dashboard, whose checklist leads into setup.
  assert.match(source("src/app/api/auth/login/route.ts"), /const next = "\/";/);
  assert.match(source("src/app/api/auth/reset/route.ts"), /const next = "\/";/);
});

await test("Today shows what is left as a checklist, n of 7, each item linking to its step", () => {
  const list = checklistOf(journey(fresh, NO_FACTS, now));
  assert.equal(list.total, 7);
  assert.deepEqual(list.items.map((s) => s.id), ["business", "import", "review", "bookings", "rules", "channels", "test"]);
  assert.equal(list.done, 1, "only the business is done at signup");
  assert.equal(list.next?.id, "import");
  const later = checklistOf(journey(withState(complete(fresh), { reviewedAt: at, destination: { kind: "requests", setAt: at }, rulesConfirmedAt: at }), NO_FACTS, now));
  assert.equal(later.done, 5);
  assert.ok(later.items.every((s) => s.url === `/setup/${s.id}`));
  const home = source("src/app/(app)/page.tsx");
  assert.match(home, /checklistOf\(path\)/);
  assert.match(home, /data-testid="setup-checklist"/);
  assert.match(home, /\{checklist\.done\} of \{checklist\.total\} done/);
  assert.match(home, /checklist\.items\.map/);
});

await test("every step opens in any order, has Skip for now, and the dashboard is in the header", () => {
  const page = source("src/app/setup/[step]/page.tsx");
  assert.doesNotMatch(page, /Finish "\$\{next\.title\}" first/, "a later step still refuses to open");
  assert.match(page, /const reachable = \(_s: Step\) => true;/);
  assert.match(page, /Skip for now/);
  assert.match(page, /data-testid="setup-dashboard"/);
});

await test("Continue and Skip go onward from the step, never back to an earlier skipped one", () => {
  // Reading skipped, review and destination done: onward from bookings is rules, not import.
  const j = journey(withState(complete(fresh), { reviewedAt: at, destination: { kind: "requests", setAt: at } }), NO_FACTS, now);
  assert.equal(stepAfter(j, "bookings")?.id, "rules");
  // Skipping the channels step from a venue with nothing done goes to the checks.
  const bare = journey(fresh, NO_FACTS, now);
  assert.equal(stepAfter(bare, "channels")?.id, "test");
  // From the last unfinished step, back round to the first one left.
  assert.equal(stepAfter(bare, "golive")?.id, "import");
  // The saves use it.
  assert.match(source("src/app/api/setup/journey/route.ts"), /stepAfter\(journey\(saved, facts\), from\)/);
  assert.match(source("src/app/api/setup/route.ts"), /stepAfter\(journeyFor\(updated\), "import"\)/);
  assert.match(source("src/app/api/setup/selftest/route.ts"), /stepAfter\(j, "test"\)/);
});

console.log("\n\x1b[1mAnswering real customers, channel by channel\x1b[0m\n");

const passedAll = tested(withState(reviewed, { destination: { kind: "requests", setAt: at }, rulesConfirmedAt: at }));

await test("nothing answers a real customer before Go live, whatever is connected", () => {
  const connected = { ...passedAll, phone: "+97140000009", embed: { enabled: true, key: "k", allowedOrigins: [] } as never, onboarding: { ...passedAll.onboarding!, channels: { phone: { numberAssignedAt: at, forwardingVerifiedAt: at }, web: { domains: ["https://x.test"], detectedAt: at } } } };
  assert.equal(answersRealCustomers(connected), false);
  const s = channelStatuses(connected, NO_FACTS, { now });
  assert.deepEqual(s.map((c) => [c.id, c.state]), [["phone", "waiting"], ["web", "waiting"], ["link", "not_set_up"], ["whatsapp", "not_set_up"]]);
  assert.ok(s.every((c) => c.state !== "live"));
  assert.match(s[0].detail, /not answering customers yet|when you press Go live/);
});

await test("a connected channel waiting on the checks says so", () => {
  const unchecked = { ...withState(reviewed, { destination: { kind: "requests", setAt: at }, rulesConfirmedAt: at }), phone: "+97140000009" };
  const venue = { ...unchecked, onboarding: { ...unchecked.onboarding!, channels: { phone: { numberAssignedAt: at, forwardingVerifiedAt: at } } } };
  const phone = channelStatuses(venue, NO_FACTS, { now })[0];
  assert.equal(phone.state, "waiting");
  assert.match(phone.detail, /checks/);
});

await test("after Go live each channel is live once connected, and one connected later goes live on its own", () => {
  const live = { ...passedAll, phone: "+97140000009", embed: { enabled: true, key: "k", allowedOrigins: [] } as never, onboarding: { ...passedAll.onboarding!, activatedAt: at, channels: { phone: { numberAssignedAt: at, forwardingVerifiedAt: at } } } };
  assert.equal(answersRealCustomers(live), true);
  const before = channelStatuses(live, NO_FACTS, { now });
  assert.deepEqual(before.map((c) => [c.id, c.state]), [["phone", "live"], ["web", "waiting"], ["link", "not_set_up"], ["whatsapp", "not_set_up"]]);
  // The widget is seen on the site: live, with no second Go live.
  const later = { ...live, onboarding: { ...live.onboarding, channels: { ...live.onboarding.channels, web: { domains: ["https://x.test"], detectedAt: at } } } };
  assert.equal(channelStatuses(later, NO_FACTS, { now })[1].state, "live");
  assert.equal(channelStatuses(later, NO_FACTS, { now, whatsappConnected: true })[3].state, "live");
});

await test("no Belline number is not set up, never live", () => {
  const s = channelStatuses({ ...fresh, phone: "" }, { ...NO_FACTS }, { now });
  assert.equal(s[0].state, "not_set_up");
});

await test("the phone and WhatsApp refuse real customers before Go live; the forwarding test still answers", () => {
  const voice = source("src/app/api/twilio/voice/route.ts");
  const verification = voice.indexOf("isVerificationCall(location, params)");
  const gate = voice.indexOf("if (!answersRealCustomers(location))");
  const stream = voice.indexOf("<Stream");
  assert.ok(verification > 0 && gate > verification && stream > gate, "the not-live gate is not between the forwarding test and the stream");
  assert.match(source("src/lib/reception/respond.ts"), /conversation\.channel !== "webchat" && !answersRealCustomers\(location\)\) return \{ sent: false, skipped: "not_live" \}/);
  // The website stays gated where it was, with the owner's own preview.
  assert.match(source("src/lib/webchat-turn.ts"), /= isActivated,/);
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

await test("the home page, the channel screens, setup and the setup save all use it", () => {
  assert.match(source("src/app/setup/page.tsx"), /journeyFor\(venue\)\.next\?\.url/);
  assert.match(source("src/app/(app)/page.tsx"), /journeyFor\(location\)/);
  assert.match(source("src/app/(app)/page.tsx"), /channelStatuses\(location/);
  assert.match(source("src/app/(app)/channels/page.tsx"), /channelStatuses\(location/);
  assert.match(source("src/app/setup/[step]/page.tsx"), /channelStatuses\(venue/);
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

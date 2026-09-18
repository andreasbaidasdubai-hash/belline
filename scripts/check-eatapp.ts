/**
 * Eat App, against a fake Eat App.
 *
 * The first restaurant reservation system Belline can actually build against,
 * and therefore the first chance to get the restaurant shape wrong in code
 * rather than in a document. OpenTable and SevenRooms have only a refusal here,
 * so nothing has ever tested that a reservations partner behaves like a
 * restaurant. This does.
 *
 * What is held down:
 *
 * - **Party size is the question.** No party size, no times — never the times
 *   for a party of some number Belline chose. "Is 19:00 free?" has no answer.
 * - **Nobody asks for a waiter.** No staff tool, no staff id sent, no name
 *   offered, whatever the caller says.
 * - **The house sets the length.** Belline never sends a duration and never
 *   quotes an end time it made up, because Eat App varies the turn time by the
 *   number of covers and does not tell a booking channel what it chose.
 * - **Nothing holds a table.** Eat App publishes no slot lock, and this is the
 *   one point where the restaurant note's "expect a two-phase hold" is wrong.
 * - **Moving and cancelling are refused**, because they live on the Concierge
 *   API, which is a different grant. A guest who rings to cancel is taken as a
 *   message, and is never told it is done.
 * - **`guests`, not `covers`.** The two Eat App APIs disagree on the word, and
 *   sending the Concierge one to the Partner API would book a party of nobody.
 *
 * And the unverified part is tested as unverified: the availability envelope
 * was never confirmed against a live sandbox, so the parser must refuse every
 * shape it does not recognise rather than salvage something from it.
 *
 * A green run is Belline's side being ready. Eat App has issued no token,
 * `booking.partner.eatapp` is off everywhere, and Eat App is not on the
 * website's strip.
 *
 * Every outbound fetch is blocked for the whole run: nothing here reaches Eat App.
 *
 *   npm run check:eatapp
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-eatapp-"));
process.env.CREDENTIALS_KEY = Buffer.alloc(32, 13).toString("base64");
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PARTNER_EATAPP_") || key === "FLAG_BOOKING_PARTNER_EATAPP" || key === "FLAG_STUBS") delete process.env[key];
}

const { installFetchGuard, blockedFetches } = await import("../src/lib/testing/stubs");
installFetchGuard();

const { seedIfEmpty } = await import("../src/lib/seed");
const { listLocations } = await import("../src/lib/store");
const { PARTNERS, partnerLive, RESTAURANT_MODEL_NOTE } = await import("../src/lib/integrations/partners");
const { eatappConnector, eatappApi, slotsIn, minutesOf, EATAPP_SANDBOX_BASE } = await import(
  "../src/lib/integrations/partners/eatapp"
);
const { partnerMode } = await import("../src/lib/integrations/partners/contract");
const { sandboxPartner } = await import("../src/lib/integrations/partners/sandbox");
const { partnerProvider } = await import("../src/lib/booking/partner-provider");
const { providerFor, requestOnlyProvider, localProvider } = await import("../src/lib/booking/provider");
const { takesRequestsOnly } = await import("../src/lib/booking/destination");
const { INTEGRATIONS } = await import("./site-integrations");
const { BOOKING_TOOL_NAMES, toolsFor } = await import("../src/lib/agent/tools");
type Loc = import("../src/lib/types").Location;
type PartnerApi = import("../src/lib/integrations/partners/contract").PartnerApi;
type PartnerRequest = import("../src/lib/integrations/partners/http").PartnerRequest;

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
const head = (title: string) => console.log(`\n\x1b[1m${title}\x1b[0m\n`);

const ROOT = path.resolve(import.meta.dirname, "..");
const source = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

seedIfEmpty();
const restaurant = listLocations().find((l) => l.vertical === "restaurant" && !l.internal) ?? listLocations().find((l) => !l.internal)!;
const facts = PARTNERS.eatapp;

const venue = (link: Record<string, unknown> | null = { venueId: "rest-1", sealedToken: "sealed" }): Loc =>
  ({
    ...restaurant,
    onboarding: {
      ...(restaurant.onboarding ?? { startedAt: "2026-09-01T00:00:00.000Z", steps: [] }),
      destination: { kind: "partner", partner: "eatapp", setAt: "2026-09-01T00:00:00.000Z" },
    },
    partners: link ? { eatapp: link } : undefined,
  }) as Loc;

const withSandbox = (api: PartnerApi) => partnerProvider({ ...eatappConnector, apiFor: () => api, usable: () => true });

function fakeEatApp(slots: unknown = ["19:00", "19:30", "20:00"]) {
  const seen: PartnerRequest[] = [];
  const transport = {
    async request<T>(req: PartnerRequest): Promise<T> {
      seen.push(req);
      if (req.path === "availability") return { data: { time_slots: slots } } as T;
      return { data: { id: "res-1", reference: "EA1234" } } as T;
    },
  };
  return { transport, seen, api: eatappApi(transport, { restaurantId: "rest-1" }) };
}

// ---------------------------------------------------------------------------
head("What the research found, written down");

await test("Eat App publishes an API, and the registry says which one Belline is on", () => {
  assert.equal(facts.api.documented, true);
  assert.equal(facts.api.availability, true);
  assert.equal(facts.api.create, true);
  assert.equal(facts.model, "reservations");
  const registry = source("src/lib/integrations/partners/registry.ts");
  const entry = registry.slice(registry.indexOf("Eat App: Dubai-founded"), registry.indexOf("eatapp: {"));
  assert.match(entry, /Partner API/, "which of the two APIs Belline builds on is not recorded");
  assert.match(entry, /Concierge API/, "the richer API Belline is not on is not recorded");
  assert.match(entry, /api\.eat-sandbox\.co/, "the sandbox host is not recorded");
  assert.equal(EATAPP_SANDBOX_BASE, "https://api.eat-sandbox.co/partners/v2/");
});

await test("moving and cancelling are recorded as absent, because they are on the other grant", () => {
  assert.equal(facts.api.reschedule, false);
  assert.equal(facts.api.cancel, false);
  assert.ok(
    facts.limits.some((l) => /Concierge/.test(l) && /cancel/i.test(l)),
    "the reason Belline cannot cancel is not written down",
  );
});

await test("no staff and no catalogue, because a restaurant has neither to offer a booking channel", () => {
  assert.equal(facts.api.staffSelection, false);
  assert.equal(facts.api.catalogue, false);
});

await test("the missing slot lock is recorded, including that it contradicts the restaurant note", () => {
  assert.ok(facts.limits.some((l) => /Nothing holds a table/i.test(l)), "the absent hold is not recorded as a limit");
  // The note predicts a two-phase hold from OpenTable and SevenRooms. Eat App
  // is the first real one and does not have it, and that has to be said.
  assert.match(RESTAURANT_MODEL_NOTE, /two-phase slot lock/);
  const registry = source("src/lib/integrations/partners/registry.ts");
  const entry = registry.slice(registry.indexOf("Eat App: Dubai-founded"), registry.indexOf("eatapp: {"));
  assert.match(entry, /there is no slot lock/i, "the contradiction with the restaurant note is not called out");
});

await test("the way in is a conversation with a real address, not an invented portal", () => {
  assert.equal(facts.gate.apply, "https://restaurant.eatapp.co/become-a-partner-eat-app");
  assert.match(facts.gate.what, /eatapp\.co/);
  // developers.eatapp.co and docs.eatapp.co do not resolve; nothing may cite them.
  for (const file of ["src/lib/integrations/partners/eatapp.ts", "src/lib/integrations/partners/registry.ts"]) {
    assert.ok(
      !/https?:\/\/(developers|docs)\.eatapp\.co/.test(source(file)),
      `${file} cites an Eat App developer site that does not resolve`,
    );
  }
  assert.ok(facts.limits.some((l) => /UNVERIFIED/.test(l)), "nothing is marked unverified");
});

// ---------------------------------------------------------------------------
head("A restaurant is not an appointment book");

await test("no party size, no times — Belline never picks a number for the caller", async () => {
  const { api, seen } = fakeEatApp();
  assert.deepEqual(await api.availability({ date: "2026-09-21" }), []);
  assert.deepEqual(await api.availability({ date: "2026-09-21", partySize: 0 }), []);
  assert.deepEqual(seen, [], "Belline asked Eat App a question with no party size in it");
});

await test("the party size goes as `guests`, which is the Partner API's word for it", async () => {
  const { api, seen } = fakeEatApp();
  await api.availability({ date: "2026-09-21", partySize: 4 });
  assert.equal(seen[0].query?.guests, 4);
  // `covers` is the Concierge dialect. Sending it here books a party of nobody.
  assert.equal(seen[0].query?.covers, undefined, "the Concierge API's word was sent to the Partner API");
  assert.equal(seen[0].query?.restaurant_id, "rest-1");
  assert.equal(seen[0].query?.date, "2026-09-21");
});

await test("no duration is ever sent, because the house sets the turn time by covers", async () => {
  const { api, seen } = fakeEatApp();
  await api.availability({ date: "2026-09-21", partySize: 2 });
  await api.create({
    date: "2026-09-21",
    startMin: 19 * 60,
    endMin: 21 * 60,
    guestName: "Layla Haddad",
    guestPhone: "+971501234567",
    partySize: 2,
    idempotencyKey: "k-1",
  });
  for (const req of seen) {
    const sent = JSON.stringify({ q: req.query ?? {}, b: req.body ?? {} });
    assert.ok(!/duration|end_time|"end"/i.test(sent), `Belline told the restaurant how long to hold the table: ${sent}`);
  }
});

await test("no person is asked for, offered, or sent", async () => {
  const { api, seen } = fakeEatApp();
  const slots = await api.availability({ date: "2026-09-21", partySize: 2, staffId: "waiter-1" });
  for (const slot of slots) {
    assert.equal(slot.staffId, undefined, "a restaurant slot named a person");
    assert.equal(slot.staffName, undefined);
  }
  await api.create({
    date: "2026-09-21",
    startMin: 19 * 60,
    endMin: 19 * 60,
    guestName: "Layla",
    guestPhone: "+971501234567",
    partySize: 2,
    staffId: "waiter-1",
    idempotencyKey: "k-2",
  });
  const sent = JSON.stringify(seen.at(-1)?.body ?? {});
  assert.ok(!/waiter-1/.test(sent), "Belline asked a restaurant for a particular waiter");
});

await test("the sitting comes back on the slot where Eat App names one", async () => {
  const { api } = fakeEatApp([
    { time: "12:30", shift: "Lunch" },
    { time: "19:00", shift: "Dinner" },
  ]);
  const slots = await api.availability({ date: "2026-09-21", partySize: 2 });
  assert.deepEqual(slots.map((s) => s.section), ["Lunch", "Dinner"]);
});

// ---------------------------------------------------------------------------
head("The unverified envelope is refused rather than salvaged");

await test("a wall time is read, and anything that is not one is not guessed at", () => {
  assert.equal(minutesOf("19:00"), 19 * 60);
  assert.equal(minutesOf("9:30"), 9 * 60 + 30);
  assert.equal(minutesOf("23:59"), 23 * 60 + 59);
  for (const bad of ["25:00", "19:60", "19:00:00", "7pm", "", "19"]) {
    assert.ok(Number.isNaN(minutesOf(bad)), `${bad} was read as a time`);
  }
});

await test("a shape the adapter does not recognise yields no times at all", () => {
  for (const bad of [undefined, null, {}, "19:00", 1900, [1900], [{ start: "19:00" }], [{ time: 1900 }]]) {
    assert.deepEqual(slotsIn(bad, "2026-09-21"), [], `${JSON.stringify(bad)} was turned into bookable times`);
  }
  // Both documented shapes are accepted, and nothing between them is invented.
  assert.deepEqual(slotsIn(["19:00", "20:00"], "2026-09-21").map((s) => s.startMin), [19 * 60, 20 * 60]);
  assert.deepEqual(slotsIn([{ time: "19:00" }], "2026-09-21").map((s) => s.startMin), [19 * 60]);
});

await test("a half-readable list offers only the half it could read", () => {
  // The failure that matters: Eat App renames a field and Belline quietly
  // fills the gaps. It must drop what it cannot read, not interpolate.
  const slots = slotsIn(["19:00", { nope: true }, "20:00"], "2026-09-21");
  assert.deepEqual(slots.map((s) => s.startMin), [19 * 60, 20 * 60]);
  assert.equal(slots.length, 2, "Belline invented a slot between two it could read");
});

await test("no end time is invented for a slot", () => {
  const slots = slotsIn(["19:00"], "2026-09-21");
  assert.equal(slots[0].endMin, slots[0].startMin, "Belline decided how long the restaurant would hold the table");
});

// ---------------------------------------------------------------------------
head("Reservations");

await test("a reservation carries the party size, and is refused without one", async () => {
  const { api, seen } = fakeEatApp();
  await assert.rejects(
    () =>
      api.create({
        date: "2026-09-21",
        startMin: 19 * 60,
        endMin: 19 * 60,
        guestName: "Layla",
        guestPhone: "+971501234567",
        idempotencyKey: "k-3",
      }),
    /number of people/i,
  );
  assert.equal(seen.length, 0, "Belline sent a reservation for a party of nobody");
  const ref = await api.create({
    date: "2026-09-21",
    startMin: 19 * 60,
    endMin: 19 * 60,
    guestName: "Layla Haddad",
    guestPhone: "+971501234567",
    partySize: 4,
    idempotencyKey: "k-4",
  });
  assert.equal(ref.id, "res-1");
  // What the guest reads back to the restaurant.
  assert.equal(ref.ref, "EA1234");
  const body = seen[0].body as Record<string, unknown>;
  assert.equal(body.guests, 4);
  assert.equal(body.time, "19:00");
  assert.equal(body.first_name, "Layla");
  assert.equal(body.last_name, "Haddad");
});

await test("the slot Eat App offered is handed straight back", async () => {
  const { api, seen } = fakeEatApp([{ time: "19:00", preference_id: "pref-9" }]);
  const slots = await api.availability({ date: "2026-09-21", partySize: 2 });
  assert.equal(slots[0].token, "pref-9");
  await api.create({
    date: "2026-09-21",
    startMin: slots[0].startMin,
    endMin: slots[0].endMin,
    guestName: "Layla",
    guestPhone: "+971501234567",
    partySize: 2,
    token: slots[0].token,
    idempotencyKey: "k-5",
  });
  assert.equal((seen[1].body as { preference_id?: string }).preference_id, "pref-9");
});

await test("moving and cancelling are refused, and nothing is sent trying", async () => {
  const { api, seen } = fakeEatApp();
  await assert.rejects(() => api.reschedule({ id: "res-1" }, { date: "2026-09-22", startMin: 20 * 60, endMin: 20 * 60 }), /cannot move/i);
  await assert.rejects(() => api.cancel({ id: "res-1" }), /cannot cancel/i);
  assert.deepEqual(seen, [], "Belline asked Eat App to do something its Partner API cannot");
});

await test("a guest who rings to cancel is taken as a message, never told it is done", async () => {
  const fake = sandboxPartner(facts, { maxParty: 8, sections: [{ from: 18 * 60, to: 23 * 60, name: "Dinner" }] });
  const provider = withSandbox(fake);
  assert.equal(provider.capabilities.cancel, false);
  assert.equal(provider.capabilities.reschedule, false);
  assert.equal(provider.capabilities.staffSelection, false);
  assert.equal(provider.capabilities.waitlist, false);
  const made = await provider.createBooking(
    { location: venue() },
    { date: "2026-09-22", startMin: 19 * 60, guestName: "Reem", guestPhone: "+971503333333", partySize: 2 },
  );
  assert.ok(made.ok);
  if (!made.ok) return;
  const out = await provider.cancelBooking({ location: venue() }, made.booking);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.match(out.detail, /take a message/i);
  assert.equal(fake.bookings()[0].status, "confirmed", "the restaurant thinks it is cancelled and it is not");
  assert.ok(!fake.calls().includes("cancel"), "Eat App was asked to do something it cannot");
});

// ---------------------------------------------------------------------------
head("Not connected");

await test("no token, no restaurant: the venue takes requests", () => {
  assert.equal(partnerMode(facts, {}), "off");
  assert.equal(eatappConnector.usable(venue(), {}), false);
  assert.equal(eatappConnector.apiFor(venue(), {}), null);
  assert.equal(takesRequestsOnly(venue()), true);
  assert.equal(providerFor(venue()), requestOnlyProvider);
  assert.notEqual(providerFor(venue()), localProvider, "Eat App fell through to Belline's own diary");
  for (const channel of ["voice", "text"] as const) {
    const tools = toolsFor(venue(), channel).map((t) => t.name);
    for (const diary of BOOKING_TOOL_NAMES) assert.ok(!tools.includes(diary), `${channel} still has ${diary}`);
    assert.ok(tools.includes("take_booking_request"), channel);
  }
});

await test("a restaurant Eat App has not enabled is not connected, however good our token is", () => {
  const env = { FLAG_BOOKING_PARTNER_EATAPP: "on", PARTNER_EATAPP_API_KEY: "t", PARTNER_EATAPP_ENV: "live" };
  assert.equal(eatappConnector.usable(venue({ venueId: "rest-1" }), env), false, "a restaurant with no grant looked connected");
  assert.equal(eatappConnector.usable(venue({ venueId: "rest-1", sealedToken: "sealed" }), env), true);
  for (const withdrawn of ["expiredAt", "misconfiguredAt"] as const) {
    const loc = venue({ venueId: "rest-1", sealedToken: "sealed", [withdrawn]: "2026-09-18T00:00:00.000Z" });
    assert.equal(eatappConnector.usable(loc, env), false, withdrawn);
  }
});

await test("Eat App is not on the website's strip", () => {
  assert.equal(INTEGRATIONS.some((i) => i.flag === "booking.partner.eatapp"), false);
  assert.equal(partnerLive("eatapp", {}), false);
});

await test("a restaurant that cannot be reached quotes nothing and books nothing", async () => {
  const provider = withSandbox(sandboxPartner(facts, { maxParty: 8, down: true }));
  assert.deepEqual(await provider.checkAvailability({ location: venue() }, { locationId: restaurant.id, date: "2026-09-25", partySize: 2 }), []);
  const made = await provider.createBooking(
    { location: venue() },
    { date: "2026-09-25", startMin: 19 * 60, guestName: "Yara", guestPhone: "+971501111111", partySize: 2 },
  );
  assert.equal(made.ok, false);
});

await test("nothing in this run reached a real host", () => {
  assert.deepEqual(blockedFetches(), []);
});

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
console.log(`\n${failed ? "\x1b[31m" : "\x1b[32m"}✓ ${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);

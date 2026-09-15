/**
 * Where bookings go, and what the agent may do about it (P0-6, P0-7).
 *
 * A business that confirms its own bookings must get an agent that cannot
 * quote a free time or announce a booking: not because the prompt asks, but
 * because the tools to do either are not there. Then the request itself, the
 * Inbox item it raises, the setup choices behind it, and the clinic rule that
 * applies whatever was chosen.
 *
 *   npm run check:provider
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-provider-"));
delete process.env.FLAG_BELLINE_DIARY;
delete process.env.FLAG_VERTICAL_CLINIC_SELFSERVE;

const { seedIfEmpty } = await import("../src/lib/seed");
const { listLocations, saveCall } = await import("../src/lib/store");
const { startCall } = await import("../src/lib/calls");
const { providerFor, localProvider, requestOnlyProvider } = await import("../src/lib/booking/provider");
const { requestKey, takeBookingRequest } = await import("../src/lib/booking/requests");
const { BOOKING_TOOL_NAMES, executeTool, toolsFor } = await import("../src/lib/agent/tools");
const { CLINIC_MEDICAL_RULE, staticPrompt } = await import("../src/lib/agent/prompt");
const { attentionFor } = await import("../src/lib/attention");
const { readiness } = await import("../src/lib/onboarding");
const { NO_FACTS, bellineDiaryOffered, journey, recordStep } = await import("../src/lib/onboarding/journey");
type Loc = import("../src/lib/types").Location;
type Destination = NonNullable<NonNullable<Loc["onboarding"]>["destination"]>;

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
const now = new Date("2026-09-15T10:00:00.000Z");
const at = now.toISOString();
const venues = listLocations();
const restaurant = venues.find((l) => l.vertical === "restaurant" && !l.internal)!;
const salon = venues.find((l) => l.vertical === "salon" && !l.internal)!;
const clinic = venues.find((l) => l.vertical === "clinic" && !l.internal)!;
const internal = venues.find((l) => l.internal);

/** A venue part way through setup, with the destination given and nothing else. */
const withDestination = (l: Loc, destination?: Omit<Destination, "setAt">, extra: Partial<NonNullable<Loc["onboarding"]>> = {}): Loc => ({
  ...l,
  onboarding: { version: 1, channels: {}, ...(destination ? { destination: { ...destination, setAt: at } } : {}), ...extra },
});
const names = (tools: { name: string }[]) => tools.map((t) => t.name);

// ---------------------------------------------------------------------------
head("providerFor follows the destination");

await test("Belline's diary, or no destination recorded, is the local engine", () => {
  assert.equal(providerFor(withDestination(salon, { kind: "belline" })), localProvider);
  assert.equal(providerFor({ ...salon, onboarding: undefined }), localProvider);
});

await test("requests, partner systems and calendars without an adapter take requests", () => {
  for (const kind of ["requests", "partner", "google", "outlook"] as const) {
    assert.equal(providerFor(withDestination(salon, { kind })), requestOnlyProvider, kind);
  }
  assert.equal(requestOnlyProvider.capabilities.availability, false);
  assert.equal(requestOnlyProvider.capabilities.confirms, false);
  assert.equal(localProvider.capabilities.availability, true);
});

await test("the request-only provider answers no to everything that would book", async () => {
  const ctx = { location: withDestination(restaurant, { kind: "requests" }) };
  assert.deepEqual(await requestOnlyProvider.checkAvailability(ctx, { locationId: restaurant.id, date: "2026-09-18", partySize: 4 }), []);
  const made = await requestOnlyProvider.createBooking(ctx, { date: "2026-09-18", startMin: 20 * 60, guestName: "Sara", guestPhone: "+971501234567", partySize: 4 });
  assert.equal(made.ok, false);
  assert.equal((await requestOnlyProvider.cancelBooking(ctx, {} as never)).ok, false);
});

// ---------------------------------------------------------------------------
head("Capabilities decide the tools");

await test("requests: no availability, booking or diary tools on either channel", () => {
  const venue = withDestination(restaurant, { kind: "requests" });
  for (const channel of ["voice", "text"] as const) {
    const tools = names(toolsFor(venue, channel));
    for (const diary of BOOKING_TOOL_NAMES) assert.ok(!tools.includes(diary), `${channel} still has ${diary}`);
    assert.ok(tools.includes("take_booking_request"), channel);
    assert.ok(tools.includes("take_message"), channel);
    assert.ok(!tools.includes("send_booking_link"), "no link was given");
  }
  assert.ok(names(toolsFor(venue, "voice")).includes("transfer_call"));
  assert.ok(names(toolsFor(venue, "text")).includes("request_human_handoff"));
});

await test("a booking link is offered in messages only", () => {
  const venue = withDestination(salon, { kind: "requests", bookingLink: "https://book.example-salon.test/" });
  assert.ok(names(toolsFor(venue, "text")).includes("send_booking_link"));
  assert.ok(!names(toolsFor(venue, "voice")).includes("send_booking_link"));
});

await test("Belline's diary keeps its tools and gets no request tool", () => {
  const tools = names(toolsFor(withDestination(restaurant, { kind: "belline" }), "text"));
  assert.ok(tools.includes("check_availability") && tools.includes("book"));
  assert.ok(!tools.includes("take_booking_request"));
});

await test("Belline's own sales line is unchanged: no diary, no requests", () => {
  if (!internal) return;
  const tools = names(toolsFor(internal, "text"));
  assert.ok(!tools.includes("check_availability") && !tools.includes("take_booking_request"));
});

await test("a diary tool called anyway at a request-only venue books nothing", async () => {
  const venue = withDestination(restaurant, { kind: "requests" });
  const call = startCall(venue, "webchat", "visitor");
  for (const name of ["check_availability", "book"]) {
    const out = await executeTool(name, { date: "2026-09-18", time: "20:00", party_size: 4, guest_name: "Sara", guest_phone: "+971501234567" }, { location: venue, call });
    assert.match(JSON.stringify(out.result), /not_supported/, name);
  }
  assert.equal(call.bookingId, undefined);
});

// ---------------------------------------------------------------------------
head("A booking request");

await test("'book a table for 4 Friday 8pm' becomes one request and one Inbox item", async () => {
  const venue = withDestination(restaurant, { kind: "requests" });
  const call = startCall(venue, "webchat", "visitor");
  const input = { guest_name: "Sara Haddad", guest_phone: "+971501234567", preferred: "Friday 8pm", time: "20:00", party_size: 4 };
  const out = await executeTool("take_booking_request", input, { location: venue, call });
  const result = out.result as Record<string, unknown>;
  assert.equal(result.requested, true);
  assert.equal(result.requested_time, "20:00");
  assert.equal(call.bookingRequests?.length, 1);
  const r = call.bookingRequests![0];
  assert.equal(r.guestName, "Sara Haddad");
  assert.equal(r.guestPhone, "+971501234567");
  assert.equal(r.partySize, 4);
  assert.equal(r.startMin, 20 * 60);
  saveCall(call);

  const items = attentionFor(venue).filter((i) => i.kind === "booking_request" && i.callId === call.id);
  assert.equal(items.length, 1);
  assert.match(items[0].what, /Table for 4 · Friday 8pm/);
  assert.equal(items[0].callbackNumber, "+971501234567");
  assert.match(items[0].todo, /Confirm/);
});

await test("asking twice in one conversation records once; a different time is a second request", () => {
  const venue = withDestination(restaurant, { kind: "requests" });
  const call = startCall(venue, "webchat", "visitor");
  const input = { guestName: "Omar", guestPhone: "0501234567", preferred: "Saturday 7pm", partySize: 2, startMin: 19 * 60 };
  const first = takeBookingRequest(venue, call, input, now);
  const again = takeBookingRequest(venue, call, { ...input, preferred: " saturday  7pm " }, now);
  assert.ok(first.ok && again.ok && again.duplicate && again.request.id === first.request.id);
  const other = takeBookingRequest(venue, call, { ...input, preferred: "Sunday 1pm", startMin: 13 * 60 }, now);
  assert.ok(other.ok && !other.duplicate);
  assert.equal(call.bookingRequests!.length, 2);
  // The key is the conversation and the slot, so another conversation is another request.
  assert.notEqual(requestKey("call_a", input), requestKey("call_b", input));
});

await test("a request without what the rules ask for says what to ask", async () => {
  const venue = withDestination(restaurant, { kind: "requests" });
  const call = startCall(venue, "webchat", "visitor");
  const noParty = await executeTool("take_booking_request", { guest_name: "Sara", guest_phone: "+971501234567", preferred: "Friday" }, { location: venue, call });
  assert.match(JSON.stringify(noParty.result), /party_size/);
  const salonVenue = withDestination(salon, { kind: "requests" });
  const noService = takeBookingRequest(salonVenue, call, { guestName: "Sara", guestPhone: "050", preferred: "Friday" }, now);
  assert.ok(!noService.ok && noService.missing === "service");
  assert.equal(call.bookingRequests, undefined);
});

await test("a clinic's request has no free-text field and keeps no notes", () => {
  const venue = withDestination(clinic, { kind: "requests" });
  const tool = toolsFor(venue, "text").find((t) => t.name === "take_booking_request")!;
  assert.ok(!("notes" in (tool.input_schema.properties as object)));
  const call = startCall(venue, "webchat", "visitor");
  const out = takeBookingRequest(venue, call, { guestName: "Lina", guestPhone: "0501234567", preferred: "Monday morning", what: "Check-up", notes: "chest pain since Tuesday" }, now);
  assert.ok(out.ok && out.request.notes === undefined);
  assert.doesNotMatch(JSON.stringify(call.bookingRequests), /chest/);
});

// ---------------------------------------------------------------------------
head("The prompt follows the destination");

await test("requests: no instruction to check availability, and a plain rule against confirming", () => {
  const prompt = staticPrompt(withDestination(restaurant, { kind: "requests" }), "text");
  assert.doesNotMatch(prompt, /check_availability|SEATINGS|Largest party you may book/);
  assert.match(prompt, /take_booking_request/);
  assert.match(prompt, /Never say a booking is confirmed, booked, reserved/);
  assert.match(staticPrompt(withDestination(restaurant, { kind: "belline" }), "text"), /check_availability/);
});

await test("the owner's rules reach the prompt", () => {
  const venue = withDestination(restaurant, { kind: "requests", bookingLink: "https://book.example.test/" }, {
    requestRules: { askFor: ["partySize"], afterHours: "message", neverSay: ["Never promise a window seat"] },
  });
  const prompt = staticPrompt(venue, "text");
  assert.match(prompt, /Never say: Never promise a window seat/);
  assert.match(prompt, /Outside the opening hours below, do not take a booking request/);
  assert.match(prompt, /send_booking_link/);
  assert.doesNotMatch(staticPrompt(venue, "voice"), /send_booking_link/);
});

await test("every clinic has the medical-detail rule, whatever it chose and whatever the flag says", () => {
  for (const env of [undefined, "on"]) {
    if (env) process.env.FLAG_VERTICAL_CLINIC_SELFSERVE = env;
    else delete process.env.FLAG_VERTICAL_CLINIC_SELFSERVE;
    for (const venue of [clinic, withDestination(clinic, { kind: "requests" }), withDestination(clinic, { kind: "belline" })]) {
      for (const channel of ["voice", "text"] as const) {
        assert.ok(staticPrompt(venue, channel).includes(CLINIC_MEDICAL_RULE), `${channel}, flag ${env ?? "off"}`);
      }
    }
  }
  delete process.env.FLAG_VERTICAL_CLINIC_SELFSERVE;
  assert.ok(!staticPrompt(salon, "text").includes(CLINIC_MEDICAL_RULE));
  // Not stored with the owner's policies, so it cannot be edited away.
  assert.ok(!clinic.agent.policies.includes(CLINIC_MEDICAL_RULE));
});

// ---------------------------------------------------------------------------
head("Choosing a destination on setup");

await test("a restaurant taking requests reaches the rules step with no tables", () => {
  const bare: Loc = { ...restaurant, restaurant: { ...restaurant.restaurant!, tables: [], services: [] } };
  const venue = withDestination(bare, { kind: "requests" }, { reviewedAt: at });
  assert.equal(journey(venue, NO_FACTS, now).next?.id, "rules");
  assert.ok(!readiness(venue).missing.some((m) => /tables|Service times/i.test(m.label)));
  assert.ok(readiness(withDestination(bare, { kind: "belline" })).missing.some((m) => /tables/i.test(m.label)));
});

await test("a booking link is stored as an address, and nonsense is refused", async () => {
  const venue = withDestination(salon, undefined, { reviewedAt: at });
  const ok = recordStep(venue, { kind: "destination", destination: "requests", bookingLink: "book.example-salon.test" }, NO_FACTS, now);
  assert.ok(ok.ok);
  if (!ok.ok) return;
  assert.equal(ok.location.onboarding!.destination!.bookingLink, "https://book.example-salon.test/");
  const call = startCall(ok.location, "webchat", "visitor");
  const sent = await executeTool("send_booking_link", {}, { location: ok.location, call });
  assert.match(JSON.stringify(sent.result), /book\.example-salon\.test/);
  const bad = recordStep(venue, { kind: "destination", destination: "requests", bookingLink: "not a link" }, NO_FACTS, now);
  assert.ok(!bad.ok && bad.field === "bookingLink");
});

await test("Google and Outlook cannot be chosen, with or without their flags", () => {
  const venue = withDestination(salon, undefined, { reviewedAt: at });
  process.env.FLAG_STUBS = "on";
  process.env.FLAG_BOOKING_GOOGLE = "on";
  try {
    for (const kind of ["google", "outlook", "partner"] as const) {
      assert.equal(recordStep(venue, { kind: "destination", destination: kind }, NO_FACTS, now).ok, false, kind);
    }
  } finally {
    delete process.env.FLAG_STUBS;
    delete process.env.FLAG_BOOKING_GOOGLE;
  }
});

await test("'Request Fresha' stores the request once, and the route emits the event", () => {
  const venue = withDestination(salon, { kind: "requests" });
  const once = recordStep(venue, { kind: "integration", integration: "fresha" }, NO_FACTS, now);
  assert.ok(once.ok);
  if (!once.ok) return;
  assert.deepEqual(once.location.onboarding!.integrationRequests, ["fresha"]);
  const twice = recordStep(once.location, { kind: "integration", integration: "Fresha" }, NO_FACTS, now);
  assert.ok(twice.ok && twice.location.onboarding!.integrationRequests!.length === 1);
  // Asking changes nothing about where bookings go.
  assert.ok(twice.ok && twice.location.onboarding!.destination!.kind === "requests");
  assert.equal(recordStep(venue, { kind: "integration", integration: "acme-bookings" }, NO_FACTS, now).ok, false);
  const route = source("src/app/api/setup/journey/route.ts");
  assert.match(route, /name: "integration\.requested"/);
});

await test("the diary is offered to accounts already on it, or by FLAG_BELLINE_DIARY, never to a clinic in preview", () => {
  assert.equal(bellineDiaryOffered(withDestination(salon, undefined), {}), false);
  assert.equal(bellineDiaryOffered(withDestination(salon, { kind: "belline" }), {}), true);
  assert.equal(bellineDiaryOffered(withDestination(salon, undefined), { FLAG_BELLINE_DIARY: "on" }), true);
  assert.equal(bellineDiaryOffered(withDestination(clinic, undefined), { FLAG_BELLINE_DIARY: "on" }), false);
  assert.equal(bellineDiaryOffered(withDestination(clinic, undefined), { FLAG_BELLINE_DIARY: "on", FLAG_VERTICAL_CLINIC_SELFSERVE: "on" }), true);
  assert.equal(recordStep(withDestination(clinic, undefined), { kind: "destination", destination: "belline" }, NO_FACTS, now).ok, false);
});

await test("a clinic can set up and test, but Go live waits for the clinic flag", () => {
  const venue = withDestination(clinic, { kind: "requests" }, { reviewedAt: at, rulesConfirmedAt: at });
  const facts = { ...NO_FACTS, phoneCalls: 1, testConversations: 1 };
  const off = journey(venue, facts, now, { clinicSelfServe: false });
  assert.equal(off.canGoLive, false);
  assert.ok(off.blockers.some((b) => b.step === "golive" && /preview/.test(b.label)));
  const on = journey(venue, facts, now, { clinicSelfServe: true });
  assert.ok(!on.blockers.some((b) => b.step === "golive"));
});

await test("the bookings step shows calendars from their flags, and the integrations subtitle follows the destination", () => {
  const page = source("src/app/setup/[step]/page.tsx");
  assert.match(page, /flag\("booking\.google"\)/);
  assert.match(page, /flag\("booking\.outlook"\)/);
  assert.match(page, /Coming soon/);
  assert.doesNotMatch(page, /state: "available",\s*\}[^\]]*id: "google"/);
  assert.match(source("src/app/(app)/integrations/page.tsx"), /takesRequestsOnly\(location\)/);
});

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
console.log(`\n${failed ? "\x1b[31m" : "\x1b[32m"}✓ ${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);

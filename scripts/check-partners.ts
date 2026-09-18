/**
 * The partner destination contract: what every partner adapter must obey,
 * whatever partner it is.
 *
 * Six adapters, one shape. This check is the shape — the per-partner checks
 * (check:fresha, check:zenoti, check:mindbody, check:treatwell, check:opentable,
 * check:sevenrooms) are about what that partner in particular can and cannot
 * do, and they all inherit what is asserted here:
 *
 * - a venue on a partner nobody has connected takes requests, is offered no
 *   tools that would quote a time, and is never told a booking was made;
 * - an adapter never falls through to Belline's own diary, which does not know
 *   the salon's book;
 * - the website cannot promote a partner logo on a flag alone;
 * - every logo on the website has researched facts behind it;
 * - no partner request leaves the process without credentials.
 *
 * Every outbound fetch is blocked for the whole run: nothing here reaches a
 * partner.
 *
 *   npm run check:partners
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-partners-"));
process.env.CREDENTIALS_KEY = Buffer.alloc(32, 7).toString("base64");
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PARTNER_") || key.startsWith("FLAG_BOOKING_PARTNER_")) delete process.env[key];
}

const { installFetchGuard, blockedFetches } = await import("../src/lib/testing/stubs");
installFetchGuard();

const { seedIfEmpty } = await import("../src/lib/seed");
const { listLocations } = await import("../src/lib/store");
const { PARTNERS, PARTNER_IDS, partnerLive, partnerUsable, partnerIdOf } = await import("../src/lib/integrations/partners");
const { PARTNER_CONNECTORS } = await import("../src/lib/integrations/partners");
const { partnerMode, partnerEnvKey } = await import("../src/lib/integrations/partners/contract");
const { PARTNER_PROVIDERS } = await import("../src/lib/booking/partner-providers");
const { providerFor, requestOnlyProvider, localProvider } = await import("../src/lib/booking/provider");
const { takesRequestsOnly, destinationOf } = await import("../src/lib/booking/destination");
const { BOOKING_TOOL_NAMES, toolsFor } = await import("../src/lib/agent/tools");
const { INTEGRATIONS, integrationState, partnerOf } = await import("./site-integrations");
const { flag } = await import("../src/lib/flags");
type Loc = import("../src/lib/types").Location;
type PartnerId = import("../src/lib/integrations/partners/contract").PartnerId;

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

seedIfEmpty();
const salon = listLocations().find((l) => l.vertical === "salon" && !l.internal)!;

/** The salon, with its bookings sent to this partner. */
const on = (id: PartnerId, extra: Partial<Loc> = {}): Loc => ({
  ...salon,
  onboarding: {
    ...(salon.onboarding ?? { startedAt: new Date().toISOString(), steps: [] }),
    destination: { kind: "partner", partner: id, setAt: new Date().toISOString() },
  },
  ...extra,
} as Loc);

/** Everything a fully credentialled, fully connected venue would look like. */
function fullyConnected(id: PartnerId): { venue: Loc; env: Record<string, string> } {
  const key = partnerEnvKey(id, "API_KEY");
  return {
    venue: on(id, { partners: { [id]: { venueId: "site-1", sealedToken: "sealed" } } } as Partial<Loc>),
    env: { [key]: "a-key", [`FLAG_BOOKING_PARTNER_${id.toUpperCase()}`]: "on", [partnerEnvKey(id, "ENV")]: "live" },
  };
}

// ---------------------------------------------------------------------------
head("Every partner is honest about what it is");

await test("each partner on the website's strip has researched facts behind it", () => {
  for (const item of INTEGRATIONS) {
    const id = partnerOf(item);
    if (!id) continue;
    // `partnerOf` only answers for a `booking.partner.<id>` flag, so Calendly —
    // a destination of its own, on `booking.calendly` — never arrives here.
    // Everything that does must already be answered for.
    assert.ok(PARTNERS[id], `${item.name} is on the website with no entry in registry.ts`);
  }
});

await test("the facts say what can be done and what it would take, in words a founder can act on", () => {
  for (const id of PARTNER_IDS) {
    const facts = PARTNERS[id];
    assert.ok(facts.gate.what.length > 40, `${id}: the gate is not described`);
    assert.ok(facts.limits.length > 0, `${id}: no limits recorded, which cannot be true`);
    // A partner that can take a booking must say how it authenticates us.
    if (facts.api.create) assert.ok(facts.auth.length > 20, `${id}: no auth model recorded`);
    // A partner with no documented API cannot claim any operation.
    if (!facts.api.documented) {
      assert.deepEqual(
        [facts.api.availability, facts.api.create, facts.api.reschedule, facts.api.cancel],
        [false, false, false, false],
        `${id} claims an operation with no documented API`,
      );
    }
  }
});

await test("no partner is connected on a deployment with no partner credentials", () => {
  for (const id of PARTNER_IDS) {
    assert.equal(flag(`booking.partner.${id}`, {}), false, id);
    assert.equal(partnerMode(PARTNERS[id], {}), "off", id);
    assert.equal(partnerLive(id, {}), false, id);
  }
});

// ---------------------------------------------------------------------------
head("A venue on an unconnected partner takes requests");

await test("providerFor sends every partner venue to requests today", () => {
  for (const id of PARTNER_IDS) {
    const venue = on(id);
    assert.equal(destinationOf(venue), "partner", id);
    assert.equal(partnerUsable(venue), false, id);
    assert.equal(takesRequestsOnly(venue), true, id);
    assert.equal(providerFor(venue), requestOnlyProvider, id);
    assert.notEqual(providerFor(venue), localProvider, `${id} fell through to Belline's own diary`);
  }
});

await test("the agent is given no tool that could quote a time or announce a booking", () => {
  for (const id of PARTNER_IDS) {
    const venue = on(id);
    for (const channel of ["voice", "text"] as const) {
      const tools = toolsFor(venue, channel).map((t) => t.name);
      for (const diary of BOOKING_TOOL_NAMES) assert.ok(!tools.includes(diary), `${id}/${channel} still has ${diary}`);
      assert.ok(tools.includes("take_booking_request"), `${id}/${channel} cannot even take a request`);
    }
  }
});

await test("a partner provider refuses cleanly rather than throwing, and says nothing was booked", async () => {
  for (const id of PARTNER_IDS) {
    const provider = PARTNER_PROVIDERS[id];
    const ctx = { location: on(id) };
    assert.deepEqual(await provider.checkAvailability(ctx, { locationId: salon.id, date: "2026-09-21" }), [], id);
    const made = await provider.createBooking(ctx, {
      date: "2026-09-21",
      startMin: 10 * 60,
      guestName: "Layla",
      guestPhone: "+971501234567",
    });
    assert.equal(made.ok, false, id);
    if (made.ok) continue;
    assert.match(made.detail, /message|team will confirm/i, `${id}: the refusal does not tell the agent what to do instead`);
    assert.ok(!/booked|confirmed your/i.test(made.detail), `${id}: the refusal sounds like a booking`);
  }
});

await test("nothing a partner cannot do is offered as a capability", () => {
  for (const id of PARTNER_IDS) {
    const facts = PARTNERS[id];
    const caps = PARTNER_PROVIDERS[id].capabilities;
    assert.equal(caps.availability, facts.api.availability, id);
    assert.equal(caps.confirms, facts.api.create, id);
    assert.equal(caps.reschedule, facts.api.reschedule, id);
    assert.equal(caps.cancel, facts.api.cancel, id);
    // The waitlist is Belline's own diary's. A slot freed in a partner's system
    // is never seen here, so nobody is ever rung about one.
    assert.equal(caps.waitlist, false, id);
  }
});

await test("a partner with no bookable API can never be usable, however the env is set", () => {
  for (const id of PARTNER_IDS) {
    if (PARTNERS[id].api.create) continue;
    const { venue, env } = fullyConnected(id);
    assert.equal(PARTNER_CONNECTORS[id].usable(venue, env), false, `${id} claims to be usable with no API to reach`);
    assert.equal(PARTNER_CONNECTORS[id].apiFor(venue, env), null, `${id} handed out an API that does not exist`);
    assert.equal(partnerLive(id, env), false, id);
  }
});

// ---------------------------------------------------------------------------
head("The website cannot be promoted by a flag");

await test("a partner flag and a key alone leave the logo on the roadmap", () => {
  for (const item of INTEGRATIONS) {
    const id = partnerOf(item);
    if (!id || !PARTNERS[id]) continue;
    const upper = id.toUpperCase();
    const env = { [`FLAG_BOOKING_PARTNER_${upper}`]: "on", [`PARTNER_${upper}_API_KEY`]: "a-key" };
    assert.equal(flag(item.flag, env), true, `${id}: the product flag should be on`);
    assert.equal(integrationState(item, env), "roadmap", `${id} was promoted to Available by its flag alone`);
  }
});

await test("a sandbox connection is not an available one", () => {
  for (const id of PARTNER_IDS) {
    const upper = id.toUpperCase();
    const env = {
      [`FLAG_BOOKING_PARTNER_${upper}`]: "on",
      [`PARTNER_${upper}_API_KEY`]: "a-key",
      [`PARTNER_${upper}_ENV`]: "sandbox",
    };
    assert.equal(partnerMode(PARTNERS[id], env), "sandbox", id);
    assert.equal(partnerLive(id, env), false, `${id} counted a sandbox as live`);
  }
});

await test("stubs never promote a logo, for a partner any more than for a calendar", () => {
  for (const item of INTEGRATIONS) {
    const id = partnerOf(item);
    if (!id || !PARTNERS[id]) continue;
    const upper = id.toUpperCase();
    assert.equal(integrationState(item, { FLAG_STUBS: "on", [`FLAG_BOOKING_PARTNER_${upper}`]: "on" }), "roadmap", id);
  }
});

await test("every partner on the strip says 'On our roadmap' with no env at all", () => {
  for (const item of INTEGRATIONS) {
    if (!partnerOf(item)) continue;
    assert.equal(integrationState(item, {}), "roadmap", item.name);
    assert.equal(item.pending, "roadmap", item.name);
  }
});

// ---------------------------------------------------------------------------
head("Credentials");

await test("a venue with no partner ids is not connected however good our key is", () => {
  for (const id of PARTNER_IDS) {
    const upper = id.toUpperCase();
    const env = { [`FLAG_BOOKING_PARTNER_${upper}`]: "on", [`PARTNER_${upper}_API_KEY`]: "a-key" };
    // The flag is on and a key exists; the salon has recorded nothing.
    assert.equal(PARTNER_CONNECTORS[id].usable(on(id), env), false, id);
    assert.equal(PARTNER_CONNECTORS[id].linked(on(id)), false, id);
  }
});

await test("a partner that stopped accepting us puts the venue back on requests", () => {
  for (const id of PARTNER_IDS) {
    const upper = id.toUpperCase();
    const env = { [`FLAG_BOOKING_PARTNER_${upper}`]: "on", [`PARTNER_${upper}_API_KEY`]: "a-key" };
    for (const withdrawn of ["expiredAt", "misconfiguredAt"] as const) {
      const venue = on(id, {
        partners: { [id]: { venueId: "site-1", sealedToken: "sealed", [withdrawn]: "2026-09-18T00:00:00.000Z" } },
      } as Partial<Loc>);
      assert.equal(PARTNER_CONNECTORS[id].usable(venue, env), false, `${id}/${withdrawn}`);
      assert.equal(takesRequestsOnly(venue), true, `${id}/${withdrawn}`);
    }
  }
});

await test("the destination's partner has to be one we have an adapter for", () => {
  const venue = on("acme-bookings" as PartnerId);
  assert.equal(partnerIdOf(venue), undefined);
  assert.equal(partnerUsable(venue), false);
  assert.equal(providerFor(venue), requestOnlyProvider);
});

await test("nothing in this run reached a real host", () => {
  assert.deepEqual(blockedFetches(), []);
});

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
console.log(`\n${failed ? "\x1b[31m" : "\x1b[32m"}✓ ${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);

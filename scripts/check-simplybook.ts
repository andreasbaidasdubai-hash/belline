/**
 * SimplyBook.me, against a fake SimplyBook.me.
 *
 * The second partner with no gatekeeper — the business enables a custom
 * feature, mints an API User Key and hands it over — which makes it, like
 * Cal.com, one where a quiet mistake reaches a real diary with nobody in
 * between. Six things are held down here rather than left in a document:
 *
 * - **The plan answer, because it is why we are building this at all.** The API
 *   is an ordinary custom feature, not a top-tier upsell, and the registry says
 *   so in words a founder can quote at a salon owner.
 * - **REST v2, not the legacy JSON-RPC API.** The old one has no reschedule on
 *   its public service and needs an md5 signature to cancel. If anybody
 *   "modernises" this onto `user-api.simplybook.me`, this check fails.
 * - **The regional host is the venue's.** Thirteen hosts exist and the wrong
 *   one answers "company does not exist", so a venue without one recorded is
 *   not connected — never defaulted to the global host.
 * - **An API User Key, never a password.** `POST /admin/auth` accepts both,
 *   which means pasting an owner's password into setup would work. Refusing
 *   the shape is the only moment anyone would notice.
 * - **Two-factor authentication is a refusal, not a retry.** The auth call
 *   succeeds with empty tokens and `require2fa`, and that must become "not
 *   connected" in words rather than a venue that looks intermittently broken.
 * - **SimplyBook decides the length.** Only start times come back, so the
 *   duration is read off the company's own service record and an unreadable
 *   one means no times at all.
 *
 * A green run is Belline's side being ready. No venue has given Belline a key,
 * `booking.partner.simplybook` is off everywhere, and SimplyBook.me is not on
 * the website's strip.
 *
 * Every outbound fetch is blocked for the whole run: nothing here reaches
 * SimplyBook.
 *
 *   npm run check:simplybook
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-simplybook-"));
process.env.CREDENTIALS_KEY = Buffer.alloc(32, 13).toString("base64");
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PARTNER_SIMPLYBOOK_") || key === "FLAG_BOOKING_PARTNER_SIMPLYBOOK" || key === "FLAG_STUBS") delete process.env[key];
}

const { installFetchGuard, blockedFetches } = await import("../src/lib/testing/stubs");
installFetchGuard();

const { seedIfEmpty } = await import("../src/lib/seed");
const { listLocations } = await import("../src/lib/store");
const { PARTNERS, partnerLive } = await import("../src/lib/integrations/partners");
const {
  simplybookConnector,
  simplybookApi,
  authorisedTransport,
  forgetSimplybookTokens,
  looksLikeApiUserKey,
  durationOf,
  minutesOf,
  stamp,
  SIMPLYBOOK_KEY_PREFIX,
} = await import("../src/lib/integrations/partners/simplybook");
const { partnerMode } = await import("../src/lib/integrations/partners/contract");
const { sandboxPartner } = await import("../src/lib/integrations/partners/sandbox");
const { partnerProvider } = await import("../src/lib/booking/partner-provider");
const { providerFor, requestOnlyProvider, localProvider } = await import("../src/lib/booking/provider");
const { takesRequestsOnly } = await import("../src/lib/booking/destination");
const { INTEGRATIONS, integrationState } = await import("./site-integrations");
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
const salon = listLocations().find((l) => l.vertical === "salon" && !l.internal)!;
const facts = PARTNERS.simplybook;

const LINK = { venueId: "belline-salon", sealedToken: "sealed", baseUrl: "https://user-api-v2.simplybook.me/" };

const venue = (link: Record<string, unknown> | null = LINK): Loc =>
  ({
    ...salon,
    onboarding: {
      ...(salon.onboarding ?? { startedAt: "2026-09-01T00:00:00.000Z", steps: [] }),
      destination: { kind: "partner", partner: "simplybook", setAt: "2026-09-01T00:00:00.000Z" },
    },
    partners: link ? { simplybook: link } : undefined,
  }) as Loc;

const withSandbox = (api: PartnerApi) => partnerProvider({ ...simplybookConnector, apiFor: () => api, usable: () => true });

// ---------------------------------------------------------------------------
// A fake SimplyBook.me: its own shapes, and nothing it would not send.
// ---------------------------------------------------------------------------

interface FakeOptions {
  slots?: { id?: string; date?: string; time?: string }[];
  /**
   * What the company says its service lasts.
   *
   * Absent from the options means "the fake uses its normal 45". To test a
   * company that said *nothing at all*, pass the key explicitly as undefined —
   * `??` would otherwise swallow the distinction, which is exactly the bug
   * this adapter must not have.
   */
  duration?: number | string;
}

function fakeSimplybook(options: FakeOptions = {}) {
  const seen: PartnerRequest[] = [];
  const duration = "duration" in options ? options.duration : 45;
  const transport = {
    async request<T>(req: PartnerRequest): Promise<T> {
      seen.push(req);
      if (req.path === "admin/services") {
        return [{ id: "10", name: "Cut and finish", duration }] as T;
      }
      if (req.path === "admin/schedule/available-slots") {
        return (options.slots ?? [
          { id: "s1", date: "2026-09-21", time: "09:00:00" },
          { id: "s2", date: "2026-09-21", time: "10:30:00" },
        ]) as T;
      }
      if (req.method === "POST" && req.path === "admin/bookings") {
        return { bookings: [{ id: 4711, code: "SB-4711" }] } as T;
      }
      return {} as T;
    },
  };
  return { transport, seen };
}

const api = (options: FakeOptions = {}) => {
  const fake = fakeSimplybook(options);
  return { ...fake, api: simplybookApi(fake.transport) };
};

// ---------------------------------------------------------------------------
head("What the research found, written down");

await test("all four operations are recorded, because REST v2 documents all four", () => {
  assert.equal(facts.api.documented, true);
  assert.equal(facts.api.availability, true);
  assert.equal(facts.api.create, true);
  assert.equal(facts.api.reschedule, true);
  assert.equal(facts.api.cancel, true);
  assert.equal(facts.model, "appointments");
});

await test("the plan answer is written down, because it is the reason to build this at all", () => {
  // The founder's question was whether the API is behind the most expensive
  // plan, as several booking products put it. It is not, and the registry has
  // to say so in words rather than leaving it to a conversation.
  const all = [facts.gate.what, ...facts.limits].join(" ");
  assert.match(all, /not gated behind the top plan/i, "the plan answer is not recorded");
  assert.match(all, /custom feature/i, "that the API is a custom feature is not recorded");
  assert.match(facts.gate.what, /High Load API/, "that only the Enterprise line item is gated is not recorded");
  // And the booking ceiling, which binds a real salon long before the API does.
  assert.ok(facts.limits.some((l) => /50 bookings a month/i.test(l)), "the Free plan's booking ceiling is not recorded");
});

await test("nothing is owed to SimplyBook: the key is the venue's, exactly as Cal.com's is", () => {
  assert.deepEqual(facts.liveNeeds, [], "a venue-keyed partner is waiting on a credential of Belline's");
  assert.match(facts.gate.what, /[Nn]othing to apply for/);
  assert.ok(facts.venueNeeds.some((n) => /API User Key/i.test(n)), "the venue's own key is not recorded as something to collect");
  assert.ok(facts.venueNeeds.some((n) => /regional API host/i.test(n)), "the regional host is not recorded");
});

await test("the honest limits are recorded, including the ones nobody would discover until a customer rang", () => {
  const has = (re: RegExp) => facts.limits.some((l) => re.test(l));
  assert.ok(has(/[Tt]hirteen regional hosts/), "the regional hosts trap is not recorded");
  assert.ok(has(/two-factor/i), "that 2FA cannot be used unattended is not recorded");
  assert.ok(has(/custom feature/i), "the custom-feature slot cost is not recorded");
  assert.ok(has(/idempotency/i), "that a retried create is a second appointment is not recorded");
  assert.ok(has(/no sandbox/i), "that there is no sandbox is not recorded");
  assert.ok(has(/UNVERIFIED/), "nothing is marked unverified");
  // Three specific unknowns, all of which would otherwise be quietly invented.
  assert.ok(has(/UNVERIFIED: the rate limits/), "the undocumented rate limits are not marked unverified");
  assert.ok(has(/UNVERIFIED: the access token's lifetime/), "the undocumented token lifetime is not marked unverified");
  assert.ok(has(/UNVERIFIED: that the API custom feature is selectable on the Free plan/), "the unconfirmed Free-plan claim is not marked unverified");
});

await test("this is REST v2, and the reasons for not using the legacy JSON-RPC API are written down", () => {
  const registry = source("src/lib/integrations/partners/registry.ts");
  const entry = registry.slice(registry.indexOf("SimplyBook.me: an open, complete API"), registry.indexOf("simplybook: {"));
  assert.match(entry, /JSON-RPC/, "the legacy API is not mentioned at all, so nobody knows it was considered");
  assert.match(entry, /swagger-admin/, "the OpenAPI document this was written against is not cited");
  const adapter = source("src/lib/integrations/partners/simplybook.ts");
  // The legacy host would be a silent downgrade: it works, and costs two of
  // the four operations.
  assert.ok(
    !/user-api\.simplybook\.me/.test(adapter.replace(/user-api\.simplybook\.me`/g, "")),
    "the adapter points at the legacy JSON-RPC host",
  );
  assert.match(adapter, /admin\/bookings/, "the v2 bookings path is gone");
});

// ---------------------------------------------------------------------------
head("The credential, and the two ways a venue is not connected");

await test("an API User Key is recognised, and an owner's password is not mistaken for one", () => {
  assert.equal(looksLikeApiUserKey(`${SIMPLYBOOK_KEY_PREFIX}abc123`), true);
  assert.equal(looksLikeApiUserKey("  api_user_key_abc123  "), true);
  // The thing this exists to catch: SimplyBook's auth call takes a real
  // password too, so a pasted password would work and would leave Belline
  // holding a salon owner's login.
  assert.equal(looksLikeApiUserKey("hunter2"), false);
  assert.equal(looksLikeApiUserKey(""), false);
});

await test("a venue that has not said which SimplyBook host it lives on is not connected", () => {
  const env = { FLAG_BOOKING_PARTNER_SIMPLYBOOK: "on", PARTNER_SIMPLYBOOK_API_KEY: "k", PARTNER_SIMPLYBOOK_ENV: "live" };
  assert.equal(
    simplybookConnector.usable(venue({ venueId: "v", sealedToken: "sealed" }), env),
    false,
    "a venue with no regional host looked connected, and would be told its company does not exist",
  );
  assert.equal(simplybookConnector.usable(venue(LINK), env), true);
});

await test("a venue whose company has issued no key is not connected, however the flags are set", () => {
  const env = { FLAG_BOOKING_PARTNER_SIMPLYBOOK: "on", PARTNER_SIMPLYBOOK_API_KEY: "k", PARTNER_SIMPLYBOOK_ENV: "live" };
  assert.equal(simplybookConnector.usable(venue({ venueId: "v", baseUrl: "https://user-api-v2.simplybook.me/" }), env), false);
  for (const withdrawn of ["expiredAt", "misconfiguredAt"] as const) {
    const loc = venue({ ...LINK, [withdrawn]: "2026-09-18T00:00:00.000Z" });
    assert.equal(simplybookConnector.usable(loc, env), false, withdrawn);
    assert.equal(takesRequestsOnly(loc), true, withdrawn);
  }
});

await test("two-factor authentication is refused in words, not retried until the venue looks broken", async () => {
  forgetSimplybookTokens();
  let mints = 0;
  const mint = async () => {
    mints++;
    // What SimplyBook actually does: a 200, `require2fa`, and no token. The
    // adapter's own token function turns that into a refusal, and this asserts
    // the sentence a person would read in the logs.
    throw new (await import("../src/lib/integrations/partners/contract")).PartnerNotConnected(
      "simplybook",
      "acme's API user has two-factor authentication on, which cannot be used unattended — the venue must issue an API User Key to a user without it",
    );
  };
  const transport = authorisedTransport("https://user-api-v2.simplybook.me/", "acme", "api_user_key_x", mint as never);
  await assert.rejects(() => transport.request({ method: "GET", path: "admin/services" }), /two-factor/i);
  assert.equal(mints, 1, "Belline retried an account that a person has to fix");
});

await test("an expired token is re-minted exactly once, and a partner that keeps refusing is not argued with", async () => {
  forgetSimplybookTokens();
  let mints = 0;
  let calls = 0;
  const mint = async () => {
    mints++;
    return `tok-${mints}`;
  };
  // A 401 on every call: the retry must not become a loop.
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("no", { status: 401 })) as typeof fetch;
  try {
    const transport = authorisedTransport("https://user-api-v2.simplybook.me/", "acme", "api_user_key_x", mint as never);
    await assert.rejects(() => transport.request({ method: "GET", path: "admin/services" }));
    calls = mints;
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(calls, 2, `the token was minted ${calls} times; exactly one retry is the contract`);
});

// ---------------------------------------------------------------------------
head("SimplyBook decides the times and the lengths");

await test("the company's own service duration is what ends an appointment", async () => {
  const { api: sb, seen } = api({ duration: 45 });
  const slots = await sb.availability({ date: "2026-09-21", serviceIds: ["10"], staffId: "p1" });
  assert.equal(seen[0].path, "admin/services", "the duration was not read off the company's own record");
  assert.equal(seen[1].query?.service_id, "10");
  assert.equal(seen[1].query?.provider_id, "p1");
  assert.deepEqual(slots.map((s) => s.startMin), [9 * 60, 10 * 60 + 30]);
  // 45 because the company said 45, not because Belline assumed anything.
  assert.deepEqual(slots.map((s) => s.endMin), [9 * 60 + 45, 10 * 60 + 30 + 45]);
});

await test("a service whose length cannot be read is quoted no times at all", async () => {
  for (const duration of [undefined, "", "unknown", 0, -30]) {
    // The key is present and the value is what the company gave, so the fake
    // reports exactly that — including "nothing at all".
    const { api: sb } = api({ duration: duration as never });
    assert.deepEqual(
      await sb.availability({ date: "2026-09-21", serviceIds: ["10"], staffId: "p1" }),
      [],
      `a duration of ${JSON.stringify(duration)} produced times Belline had invented the end of`,
    );
  }
  // …and a number that is genuinely there is genuinely used.
  assert.equal(durationOf({ duration: "45" }), 45);
  assert.equal(durationOf({ duration: 30 }), 30);
  assert.equal(durationOf({ duration: "nonsense" }), undefined);
  assert.equal(durationOf(undefined), undefined);
});

await test("no service and no provider means no question is asked, rather than a guess at the day", async () => {
  const { api: sb, seen } = api();
  assert.deepEqual(await sb.availability({ date: "2026-09-21" }), []);
  assert.deepEqual(await sb.availability({ date: "2026-09-21", serviceIds: ["10"] }), [], "a service with no provider was answered");
  assert.deepEqual(await sb.availability({ date: "2026-09-21", staffId: "p1" }), [], "a provider with no service was answered");
  assert.deepEqual(seen, [], "Belline asked SimplyBook a question it cannot answer");
});

await test("a slot filed under another day, or with an unreadable time, is not offered as this day's", async () => {
  const { api: sb } = api({
    slots: [
      { id: "s1", date: "2026-09-22", time: "09:00:00" },
      { id: "s2", date: "2026-09-21", time: "not a time" },
      { id: "s3", date: "2026-09-21", time: "11:00:00" },
    ],
  });
  const slots = await sb.availability({ date: "2026-09-21", serviceIds: ["10"], staffId: "p1" });
  assert.deepEqual(slots.map((s) => s.startMin), [11 * 60]);
  assert.ok(Number.isNaN(minutesOf("not a time")));
  assert.equal(minutesOf("09:30:00"), 9 * 60 + 30);
});

await test("times are the company's wall clock, and are never turned into an instant", () => {
  // SimplyBook resolves a naive datetime against the company's own zone, which
  // is the opposite of Cal.com. A "Z" appearing here would be a Gulf salon
  // taking bookings four hours out.
  assert.equal(stamp("2026-09-21", 9 * 60), "2026-09-21 09:00:00");
  assert.equal(stamp("2026-09-21", 14 * 60 + 5), "2026-09-21 14:05:00");
  const adapter = source("src/lib/integrations/partners/simplybook.ts");
  assert.ok(!/toISOString\(\)/.test(adapter), "the adapter converts a wall time to an instant, which SimplyBook does not want");
});

// ---------------------------------------------------------------------------
head("Bookings");

await test("a booking is SimplyBook's own shape, and the guest keeps the code they can read out", async () => {
  const { api: sb, seen } = api();
  const ref = await sb.create({
    date: "2026-09-21",
    startMin: 9 * 60,
    endMin: 9 * 60 + 45,
    guestName: "Layla",
    guestPhone: "+971501234567",
    guestEmail: "  layla@example.com  ",
    serviceIds: ["10"],
    staffId: "p1",
    idempotencyKey: "k-1",
  });
  assert.equal(ref.id, "4711");
  assert.equal(ref.ref, "SB-4711", "the code the guest reads back to the salon was dropped");
  const body = seen[0].body as { start_datetime?: string; end_datetime?: string; client?: Record<string, string> };
  assert.equal(body.start_datetime, "2026-09-21 09:00:00");
  assert.equal(body.end_datetime, "2026-09-21 09:45:00");
  assert.equal(body.client?.email, "layla@example.com", "the address was sent with the caller's stray spaces");
  assert.equal(body.client?.phone, "+971501234567");
});

await test("a caller with no email address is still booked, because SimplyBook does not insist on one", async () => {
  // The difference from Cal.com, which refuses. Getting this wrong would make
  // the agent ask for an address it does not need.
  const { api: sb, seen } = api();
  const ref = await sb.create({
    date: "2026-09-21",
    startMin: 9 * 60,
    endMin: 9 * 60 + 45,
    guestName: "Layla",
    guestPhone: "+971501234567",
    serviceIds: ["10"],
    staffId: "p1",
    idempotencyKey: "k-2",
  });
  assert.equal(ref.id, "4711");
  const body = seen[0].body as { client?: Record<string, string | undefined> };
  assert.equal(body.client?.email, undefined, "an empty address was sent as a value");
});

await test("a booking with no service or no provider is refused before anything leaves", async () => {
  const { api: sb, seen } = api();
  const base = {
    date: "2026-09-21",
    startMin: 9 * 60,
    endMin: 9 * 60 + 45,
    guestName: "Layla",
    guestPhone: "+971501234567",
    idempotencyKey: "k-3",
  };
  await assert.rejects(() => sb.create({ ...base, staffId: "p1" }), /service/i);
  await assert.rejects(() => sb.create({ ...base, serviceIds: ["10"] }), /provider/i);
  assert.deepEqual(seen, [], "Belline sent SimplyBook a booking it would have refused");
});

await test("a move is one call, and the booking keeps its id and its code", async () => {
  const { api: sb, seen } = api();
  const moved = await sb.reschedule(
    { id: "4711", ref: "SB-4711" },
    { date: "2026-09-22", startMin: 10 * 60, endMin: 10 * 60 + 45 },
  );
  assert.equal(seen[0].method, "PUT");
  assert.match(seen[0].path, /^admin\/bookings\/4711$/);
  // Zenoti's cancel-then-rebook recipe is what this deliberately is not.
  assert.equal(moved.id, "4711");
  assert.equal(moved.ref, "SB-4711");
});

await test("a cancellation is a DELETE by id, with no signature to compute", async () => {
  const { api: sb, seen } = api();
  await sb.cancel({ id: "4711" });
  assert.equal(seen[0].method, "DELETE");
  assert.match(seen[0].path, /^admin\/bookings\/4711$/);
  // The legacy API needed md5(id . hash . secret) to cancel. Its reappearance
  // here would mean somebody moved this back onto JSON-RPC — so the code is
  // checked for the hashing, not the prose, which describes it deliberately.
  const adapter = source("src/lib/integrations/partners/simplybook.ts").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/createHash|node:crypto/.test(adapter), "the adapter is computing a legacy JSON-RPC signature");
});

// ---------------------------------------------------------------------------
head("Not connected");

await test("no key, no venue: the salon takes requests", () => {
  assert.equal(partnerMode(facts, {}), "off");
  assert.equal(simplybookConnector.usable(venue(), {}), false);
  assert.equal(simplybookConnector.apiFor(venue(), {}), null);
  assert.equal(takesRequestsOnly(venue()), true);
  assert.equal(providerFor(venue()), requestOnlyProvider);
  assert.notEqual(providerFor(venue()), localProvider, "SimplyBook fell through to Belline's own diary");
  for (const channel of ["voice", "text"] as const) {
    const tools = toolsFor(venue(), channel).map((t) => t.name);
    for (const diary of BOOKING_TOOL_NAMES) assert.ok(!tools.includes(diary), `${channel} still has ${diary}`);
    assert.ok(tools.includes("take_booking_request"), channel);
  }
});

await test("SimplyBook.me is not on the website's strip at all", () => {
  assert.equal(
    INTEGRATIONS.some((i) => i.flag === "booking.partner.simplybook"),
    false,
    "SimplyBook.me was put on the landing page before anyone decided to list it",
  );
  assert.equal(partnerLive("simplybook", {}), false);
});

/**
 * The same weaker gate Cal.com and Zenoti have, said out loud rather than
 * asserted comfortably: for a partner whose credentials belong to the venue,
 * `liveNeeds` is empty, so nothing is waiting on a partner's approval and the
 * only thing between the flag and the word "Available" is a person setting
 * `PARTNER_SIMPLYBOOK_ENV=live`. Deliberate (contract.ts), documented, and the
 * one to be careful with.
 */
await test("without an explicit live deployment SimplyBook.me stays on the roadmap", () => {
  const item = { name: "SimplyBook.me", logo: "simplybook.png", flag: "booking.partner.simplybook", pending: "roadmap" } as const;
  assert.equal(integrationState(item, {}), "roadmap", "with no env at all");
  assert.equal(integrationState(item, { FLAG_BOOKING_PARTNER_SIMPLYBOOK: "on", PARTNER_SIMPLYBOOK_API_KEY: "k" }), "roadmap", "flag and key alone");
  assert.equal(
    integrationState(item, { FLAG_BOOKING_PARTNER_SIMPLYBOOK: "on", PARTNER_SIMPLYBOOK_API_KEY: "k", PARTNER_SIMPLYBOOK_ENV: "sandbox" }),
    "roadmap",
    "a sandbox connection counted as an available one",
  );
  assert.equal(integrationState(item, { FLAG_STUBS: "on", FLAG_BOOKING_PARTNER_SIMPLYBOOK: "on" }), "roadmap", "stubs promoted a logo");
  assert.equal(
    integrationState(item, { FLAG_BOOKING_PARTNER_SIMPLYBOOK: "on", PARTNER_SIMPLYBOOK_API_KEY: "k", PARTNER_SIMPLYBOOK_ENV: "live" }),
    "available",
    "the documented behaviour for a venue-keyed partner has changed; docs/integrations/partners.md says otherwise",
  );
});

// ---------------------------------------------------------------------------
head("Through the provider, as a venue would see it");

await test("everything SimplyBook can do is offered, and no waitlist", () => {
  const provider = withSandbox(sandboxPartner(facts));
  assert.equal(provider.capabilities.availability, true);
  assert.equal(provider.capabilities.confirms, true);
  assert.equal(provider.capabilities.reschedule, true);
  assert.equal(provider.capabilities.cancel, true);
  assert.equal(provider.capabilities.staffSelection, true);
  assert.equal(provider.capabilities.waitlist, false);
});

await test("a repeated booking is one booking, because SimplyBook has no idempotency key of its own", async () => {
  const fake = sandboxPartner(facts);
  const provider = withSandbox(fake);
  const input = { date: "2026-09-22", startMin: 9 * 60, guestName: "Aisha", guestPhone: "+971504444444", serviceIds: ["10"] };
  const first = await provider.createBooking({ location: venue() }, input);
  const again = await provider.createBooking({ location: venue() }, input);
  assert.ok(first.ok && again.ok);
  if (!first.ok || !again.ok) return;
  assert.equal(again.duplicate, true);
  assert.equal(fake.bookings().length, 1);
});

await test("a SimplyBook that cannot be reached quotes nothing and books nothing", async () => {
  const provider = withSandbox(sandboxPartner(facts, { down: true }));
  assert.deepEqual(await provider.checkAvailability({ location: venue() }, { locationId: salon.id, date: "2026-09-25" }), []);
  const made = await provider.createBooking(
    { location: venue() },
    { date: "2026-09-25", startMin: 9 * 60, guestName: "Yara", guestPhone: "+971501111111", serviceIds: ["10"] },
  );
  assert.equal(made.ok, false);
  if (made.ok) return;
  assert.match(made.detail, /message|team will confirm/i);
});

await test("nothing in this run reached a real host", () => {
  assert.deepEqual(blockedFetches(), []);
});

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
console.log(`\n${failed ? "\x1b[31m" : "\x1b[32m"}✓ ${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);

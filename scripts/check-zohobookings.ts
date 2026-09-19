/**
 * Zoho Bookings, against a fake Zoho.
 *
 * The partner whose failure mode the founder named before a line was written:
 * Zoho's OAuth is partitioned by data centre, and an integration built against
 * one of them looks perfectly healthy while failing for every customer outside
 * it. That is not a bug a test finds later — it is a bug a customer finds — so
 * most of this check is about the data centre and nothing else.
 *
 * Five things are held down here rather than left in a document:
 *
 * - **No region table, anywhere.** The API host is read from `api_domain` on
 *   the token response, which is Zoho's own written instruction. If a
 *   `zohoapis` hostname is ever hardcoded in the adapter, this check fails.
 * - **The refresh goes to the venue's own accounts host**, the one Zoho put on
 *   the callback. Never `.com`, never inferred from a country.
 * - **A venue with no data centre recorded is not connected** — not defaulted,
 *   which is the precise shape of the half-the-customers failure.
 * - **Zoho decides the length.** `availableslots` returns bare starts, so the
 *   duration comes off the venue's own service record and an unreadable one
 *   means no times at all.
 * - **Both time formats are read.** The same endpoint answers "14:00" for one
 *   salon and "02:00 PM" for the next, depending on a setting in *their*
 *   account. Getting this wrong quietly loses a salon half its day.
 *
 * A green run is Belline's side being ready. No venue has granted Belline
 * anything, `booking.partner.zohobookings` is off everywhere, and Zoho Bookings
 * is not on the website's strip.
 *
 * Every outbound fetch is blocked for the whole run: nothing here reaches Zoho.
 *
 *   npm run check:zohobookings
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-zoho-"));
process.env.CREDENTIALS_KEY = Buffer.alloc(32, 17).toString("base64");
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PARTNER_ZOHOBOOKINGS_") || key === "FLAG_BOOKING_PARTNER_ZOHOBOOKINGS" || key === "FLAG_STUBS") delete process.env[key];
}

const { installFetchGuard, blockedFetches } = await import("../src/lib/testing/stubs");
installFetchGuard();

const { seedIfEmpty } = await import("../src/lib/seed");
const { listLocations } = await import("../src/lib/store");
const { PARTNERS, partnerLive } = await import("../src/lib/integrations/partners");
const {
  zohobookingsConnector,
  zohoBookingsApi,
  zohoTransport,
  forgetZohoTokens,
  durationMinutes,
  minutesOf,
  zohoTime,
  zohoDate,
  ZOHO_BOOKINGS_SCOPE,
} = await import("../src/lib/integrations/partners/zohobookings");
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
const facts = PARTNERS.zohobookings;

const LINK = {
  venueId: "workspace-1",
  sealedToken: "sealed",
  accountsServer: "https://accounts.zoho.sa",
  timeZone: "Asia/Dubai",
};

const venue = (link: Record<string, unknown> | null = LINK): Loc =>
  ({
    ...salon,
    onboarding: {
      ...(salon.onboarding ?? { startedAt: "2026-09-01T00:00:00.000Z", steps: [] }),
      destination: { kind: "partner", partner: "zohobookings", setAt: "2026-09-01T00:00:00.000Z" },
    },
    partners: link ? { zohobookings: link } : undefined,
  }) as Loc;

const withSandbox = (api: PartnerApi) => partnerProvider({ ...zohobookingsConnector, apiFor: () => api, usable: () => true });

// ---------------------------------------------------------------------------
// A fake Zoho: its own envelope, and nothing it would not send.
// ---------------------------------------------------------------------------

interface FakeOptions {
  slots?: string[];
  duration?: string;
}

function fakeZoho(options: FakeOptions = {}) {
  const seen: PartnerRequest[] = [];
  const duration = "duration" in options ? options.duration : "45 mins";
  const wrap = <T>(returnvalue: T) => ({ response: { returnvalue, status: "success" } });
  const transport = {
    async request<T>(req: PartnerRequest): Promise<T> {
      seen.push(req);
      if (req.path.endsWith("services")) {
        return wrap({ data: [{ id: "svc-1", name: "Cut and finish", duration }] }) as T;
      }
      if (req.path.endsWith("availableslots")) {
        return wrap({ data: options.slots ?? ["09:00", "10:30"], time_zone: "Asia/Dubai" }) as T;
      }
      return wrap({ booking_id: "#AN-00014", status: "upcoming" }) as T;
    },
  };
  return { transport, seen };
}

const api = (options: FakeOptions = {}) => {
  const fake = fakeZoho(options);
  return { ...fake, api: zohoBookingsApi(fake.transport, { workspaceId: "workspace-1" }) };
};

// ---------------------------------------------------------------------------
head("What the research found, written down");

await test("all four operations are recorded, because Zoho documents all four", () => {
  assert.equal(facts.api.documented, true);
  assert.equal(facts.api.availability, true);
  assert.equal(facts.api.create, true);
  assert.equal(facts.api.reschedule, true);
  assert.equal(facts.api.cancel, true);
  assert.equal(facts.model, "appointments");
});

await test("the plan answer is written down, because it is the reason to build this at all", () => {
  // The founder's question: does the customer need a paid plan? They do not —
  // Zoho meters the API rather than selling it, and the numbers belong in the
  // registry where a founder can quote them.
  const all = [facts.gate.what, ...facts.limits].join(" ");
  assert.match(all, /Free, Basic and Premium/i, "that API access is on every plan is not recorded");
  assert.match(all, /250 a day on Free/i, "the per-plan call allowance is not recorded");
  assert.match(facts.gate.what, /needs no upgrade/i, "the customer-side plan answer is not in the gate");
});

await test("the one scope is recorded, including that it asks for more than Belline uses", () => {
  assert.equal(ZOHO_BOOKINGS_SCOPE, "zohobookings.data.CREATE");
  assert.match(facts.auth, /zohobookings\.data\.CREATE/);
  // There is no read-only scope, so the consent screen a customer signs is
  // wider than the job. That is a thing to say, not to bury.
  assert.ok(
    facts.limits.some((l) => /no read-only scope/i.test(l)),
    "that the only scope grants full write access is not recorded",
  );
});

await test("the honest limits are recorded, including the ones that only appear on a customer's first call", () => {
  const has = (re: RegExp) => facts.limits.some((l) => re.test(l));
  assert.ok(has(/data centre is the whole risk/i), "the data-centre risk is not recorded first");
  assert.ok(has(/accounts\.zoho\.ae/), "the undocumented UAE data centre is not recorded");
  assert.ok(has(/did not enable in the API console/i), "that a disabled data centre cannot be connected is not recorded");
  assert.ok(has(/Time Format/), "the 12-hour/24-hour slot format trap is not recorded");
  assert.ok(has(/form-data/), "that the writes are multipart is not recorded");
  assert.ok(has(/idempotency/i), "that a retried create is a second appointment is not recorded");
  assert.ok(has(/no sandbox/i), "that there is no sandbox is not recorded");
  assert.ok(has(/UNVERIFIED/), "nothing is marked unverified");
});

await test("the multi-data-centre answer the founder asked for is written down, with Zoho's own words", () => {
  const registry = source("src/lib/integrations/partners/registry.ts");
  const entry = registry.slice(registry.indexOf("Zoho Bookings: a real API on every plan"), registry.indexOf("zohobookings: {"));
  // One client id across every data centre is what makes a single Belline app
  // able to serve a UAE customer at all.
  assert.match(entry, /Client ID will be common for all DCs/, "Zoho's own multi-DC sentence is not quoted");
  assert.match(entry, /accounts-server/, "the callback parameter that identifies the data centre is not recorded");
  assert.match(entry, /Never hardcode a single region's URL/, "Zoho's own instruction is not quoted");
  assert.match(entry, /serverinfo/, "the endpoint that revealed the UAE data centre is not cited");
  // And the founder's action: enabling each DC in the console is the step that
  // is invisible until a customer in a missing one tries to connect.
  assert.match(facts.gate.what, /Use the same OAuth credentials for all data centers/);
});

// ---------------------------------------------------------------------------
head("The data centre, which is the whole risk");

await test("there is no region table in the adapter, and no zohoapis host is written down", () => {
  const adapter = source("src/lib/integrations/partners/zohobookings.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  // The single rule this adapter exists to enforce. A hardcoded host here is
  // an integration that works for one data centre and silently fails for the
  // rest, which is exactly what was asked to be avoided.
  assert.ok(!/zohoapis/.test(adapter), "a Zoho API host is hardcoded in the adapter");
  assert.ok(!/accounts\.zoho\.(com|eu|in|sa|ae)/.test(adapter), "a Zoho accounts host is hardcoded in the adapter");
});

await test("the refresh goes to the venue's own accounts host, never a default", async () => {
  forgetZohoTokens();
  const asked: string[] = [];
  const refresh = async (accountsServer: string) => {
    asked.push(accountsServer);
    return { accessToken: "tok", apiDomain: "https://www.zohoapis.sa", expiresAt: Date.now() + 3600_000 };
  };
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ response: { returnvalue: {}, status: "success" } }), { status: 200 })) as typeof fetch;
  try {
    const transport = zohoTransport("https://accounts.zoho.sa", "refresh-1", "cid", "secret", refresh as never);
    await transport.request({ method: "GET", path: "bookings/v1/json/services" });
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(asked, ["https://accounts.zoho.sa"], "the refresh went somewhere other than the venue's own data centre");
});

await test("the API host comes off the token, so two venues in two data centres reach two hosts", async () => {
  forgetZohoTokens();
  const hit: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    hit.push(String(url));
    return new Response(JSON.stringify({ response: { returnvalue: {}, status: "success" } }), { status: 200 });
  }) as typeof fetch;
  try {
    // A Saudi venue and a European one, the same code, the same client.
    for (const [accounts, apiDomain] of [
      ["https://accounts.zoho.sa", "https://www.zohoapis.sa"],
      ["https://accounts.zoho.eu", "https://api.zoho.eu"],
    ]) {
      const refresh = async () => ({ accessToken: "tok", apiDomain, expiresAt: Date.now() + 3600_000 });
      const transport = zohoTransport(accounts, "r", "cid", "secret", refresh as never);
      await transport.request({ method: "GET", path: "bookings/v1/json/services" });
    }
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(hit.length, 2);
  assert.match(hit[0], /^https:\/\/www\.zohoapis\.sa\/bookings\/v1\/json\/services/);
  // Note the second: Zoho's own examples spell api_domain both ways, so the
  // adapter must use whatever came back rather than rebuilding "www.zohoapis".
  assert.match(hit[1], /^https:\/\/api\.zoho\.eu\/bookings\/v1\/json\/services/);
});

await test("a token with no api_domain is refused, because guessing is the one forbidden thing", async () => {
  forgetZohoTokens();
  const { zohoRefresh } = await import("../src/lib/integrations/partners/zohobookings");
  const noDomain = (async () =>
    new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 })) as typeof fetch;
  await assert.rejects(
    () => zohoRefresh("https://accounts.zoho.sa", "r", "cid", "secret", noDomain),
    /api_domain|will not guess/i,
  );
});

await test("a refusal at the venue's data centre says what a person should actually check", async () => {
  forgetZohoTokens();
  const { zohoRefresh } = await import("../src/lib/integrations/partners/zohobookings");
  const refused = (async () => new Response("nope", { status: 400 })) as typeof fetch;
  await assert.rejects(
    () => zohoRefresh("https://accounts.zoho.ae", "r", "cid", "secret", refused),
    // The two real causes, and a UAE venue is the likeliest to hit the second.
    /revoked|data centre may not be enabled/i,
  );
});

await test("a venue that has not recorded its data centre is not connected, and is not defaulted", () => {
  const env = {
    FLAG_BOOKING_PARTNER_ZOHOBOOKINGS: "on",
    PARTNER_ZOHOBOOKINGS_API_KEY: "k",
    PARTNER_ZOHOBOOKINGS_ENV: "live",
    PARTNER_ZOHOBOOKINGS_CLIENT_ID: "cid",
    PARTNER_ZOHOBOOKINGS_CLIENT_SECRET: "secret",
  };
  assert.equal(
    zohobookingsConnector.usable(venue({ venueId: "workspace-1", sealedToken: "sealed" }), env),
    false,
    "a venue with no data centre looked connected — this is the failure that works for one region and not the rest",
  );
  assert.equal(zohobookingsConnector.usable(venue(LINK), env), true);
});

await test("Belline's one OAuth app is env, and the venue's grant is the venue's", () => {
  // The client id is common to every data centre (Zoho's own words), so it
  // belongs in env exactly once. The refresh token is the owner's and is
  // sealed on their location.
  assert.deepEqual(facts.liveNeeds, ["PARTNER_ZOHOBOOKINGS_CLIENT_ID", "PARTNER_ZOHOBOOKINGS_CLIENT_SECRET"]);
  assert.ok(facts.venueNeeds.some((n) => /accounts-server/.test(n)), "the venue's data centre is not recorded as something to collect");
  assert.ok(facts.venueNeeds.some((n) => /refresh token/i.test(n)), "the venue's own grant is not recorded");
});

// ---------------------------------------------------------------------------
head("Zoho decides the times and the lengths");

await test("both of Zoho's slot time formats are read, because the venue chose which one", () => {
  // 24-hour, which is what a Gulf salon on the default setting sends.
  assert.equal(minutesOf("09:00"), 9 * 60);
  assert.equal(minutesOf("14:30"), 14 * 60 + 30);
  // …and 12-hour, which is what the next one sends. Reading only the first
  // would quietly lose a salon every afternoon appointment.
  assert.equal(minutesOf("02:00 PM"), 14 * 60);
  assert.equal(minutesOf("12:00 AM"), 0);
  assert.equal(minutesOf("12:30 PM"), 12 * 60 + 30);
  assert.equal(minutesOf("09:15 am"), 9 * 60 + 15);
  // Anything else is not a time, and a NaN is dropped rather than offered.
  for (const bad of ["", "soon", "25:00", "09:70", "13:00 PM", "0:00 XM"]) {
    assert.ok(Number.isNaN(minutesOf(bad)), `"${bad}" was read as a time`);
  }
});

await test("the venue's own service duration is what ends an appointment", async () => {
  const { api: z, seen } = api({ duration: "45 mins" });
  const slots = await z.availability({ date: "2026-09-21", serviceIds: ["svc-1"], staffId: "staff-1" });
  assert.ok(seen[0].path.endsWith("services"), "the duration was not read off the venue's own record");
  assert.equal(seen[0].query?.workspace_id, "workspace-1");
  assert.equal(seen[1].query?.selected_date, "21-Sep-2026", "the date was not sent in Zoho's own format");
  assert.deepEqual(slots.map((s) => s.startMin), [9 * 60, 10 * 60 + 30]);
  assert.deepEqual(slots.map((s) => s.endMin), [9 * 60 + 45, 10 * 60 + 30 + 45]);
});

await test("Zoho's ways of wording a duration are read, and anything else means no times", () => {
  assert.equal(durationMinutes("45 mins"), 45);
  assert.equal(durationMinutes("1 hour"), 60);
  assert.equal(durationMinutes("1 hour 30 mins"), 90);
  assert.equal(durationMinutes("2 hours"), 120);
  assert.equal(durationMinutes("5 min"), 5);
  for (const bad of [undefined, "", "a while", "0 mins", "-30 mins"]) {
    assert.equal(durationMinutes(bad as never), undefined, `"${bad}" was read as a length`);
  }
});

await test("a service whose length cannot be read is quoted no times at all", async () => {
  for (const duration of [undefined, "", "a while"]) {
    const { api: z } = api({ duration: duration as never });
    assert.deepEqual(
      await z.availability({ date: "2026-09-21", serviceIds: ["svc-1"], staffId: "staff-1" }),
      [],
      `a duration of ${JSON.stringify(duration)} produced times Belline had invented the end of`,
    );
  }
});

await test("no service and no staff member means no question is asked", async () => {
  const { api: z, seen } = api();
  assert.deepEqual(await z.availability({ date: "2026-09-21" }), []);
  assert.deepEqual(await z.availability({ date: "2026-09-21", serviceIds: ["svc-1"] }), [], "a service with no staff member was answered");
  assert.deepEqual(await z.availability({ date: "2026-09-21", staffId: "staff-1" }), [], "a staff member with no service was answered");
  assert.deepEqual(seen, [], "Belline asked Zoho a question it cannot answer");
});

await test("times go to Zoho as the venue's wall clock in Zoho's own format, never an instant", () => {
  assert.equal(zohoTime("2026-09-21", 9 * 60), "21-Sep-2026 09:00:00");
  assert.equal(zohoTime("2026-01-05", 14 * 60 + 5), "05-Jan-2026 14:05:00");
  assert.equal(zohoDate("2026-12-31"), "31-Dec-2026");
  // Zoho resolves a naive time against the workspace's own zone. A "Z" here
  // would be a Gulf salon taking bookings four hours out.
  const adapter = source("src/lib/integrations/partners/zohobookings.ts");
  assert.ok(!/toISOString\(\)/.test(adapter), "the adapter converts a wall time to an instant, which Zoho does not want");
});

// ---------------------------------------------------------------------------
head("Bookings, which Zoho takes as form-data and nothing else");

await test("a booking is sent as multipart form-data, with the guest as a JSON string inside it", async () => {
  const { api: z, seen } = api();
  const ref = await z.create({
    date: "2026-09-21",
    startMin: 9 * 60,
    endMin: 9 * 60 + 45,
    guestName: "Layla",
    guestPhone: "+971501234567",
    guestEmail: "  layla@example.com  ",
    serviceIds: ["svc-1"],
    staffId: "staff-1",
    idempotencyKey: "k-1",
  });
  assert.equal(ref.id, "#AN-00014");
  assert.equal(ref.ref, "#AN-00014", "the reference a guest reads out was dropped");
  // JSON would be refused: Zoho documents form-data on every write.
  assert.equal(seen[0].body, undefined, "a JSON body was sent to an endpoint that only takes form-data");
  const form = seen[0].form!;
  assert.equal(form.service_id, "svc-1");
  assert.equal(form.staff_id, "staff-1");
  assert.equal(form.from_time, "21-Sep-2026 09:00:00");
  const customer = JSON.parse(form.customer_details!);
  assert.equal(customer.name, "Layla");
  assert.equal(customer.phone_number, "+971501234567");
  assert.equal(customer.email, "layla@example.com", "the address was sent with the caller's stray spaces");
});

await test("a caller with no email address is still booked, and no empty value is sent", async () => {
  const { api: z, seen } = api();
  await z.create({
    date: "2026-09-21",
    startMin: 9 * 60,
    endMin: 9 * 60 + 45,
    guestName: "Layla",
    guestPhone: "+971501234567",
    serviceIds: ["svc-1"],
    staffId: "staff-1",
    idempotencyKey: "k-2",
  });
  const customer = JSON.parse(seen[0].form!.customer_details!);
  assert.equal(customer.email, undefined, "an empty address was sent as a value");
});

await test("a booking with no service or no staff member is refused before anything leaves", async () => {
  const { api: z, seen } = api();
  const base = {
    date: "2026-09-21",
    startMin: 9 * 60,
    endMin: 9 * 60 + 45,
    guestName: "Layla",
    guestPhone: "+971501234567",
    idempotencyKey: "k-3",
  };
  await assert.rejects(() => z.create({ ...base, staffId: "staff-1" }), /service/i);
  await assert.rejects(() => z.create({ ...base, serviceIds: ["svc-1"] }), /staff/i);
  assert.deepEqual(seen, [], "Belline sent Zoho a booking it would have refused");
});

await test("a move is its own endpoint, and the appointment keeps its booking id", async () => {
  const { api: z, seen } = api();
  const moved = await z.reschedule(
    { id: "#AN-00014", ref: "#AN-00014" },
    { date: "2026-09-22", startMin: 10 * 60, endMin: 10 * 60 + 45, staffId: "staff-2" },
  );
  assert.ok(seen[0].path.endsWith("rescheduleappointment"));
  assert.equal(seen[0].form?.booking_id, "#AN-00014");
  assert.equal(seen[0].form?.start_time, "22-Sep-2026 10:00:00");
  assert.equal(seen[0].form?.staff_id, "staff-2");
  assert.equal(moved.id, "#AN-00014");
});

await test("a cancellation is an action on the update call, because Zoho has no cancel endpoint", async () => {
  const { api: z, seen } = api();
  await z.cancel({ id: "#AN-00014" });
  assert.ok(seen[0].path.endsWith("updateappointment"), "Belline called a cancel endpoint that does not exist");
  assert.equal(seen[0].form?.action, "cancel");
  assert.equal(seen[0].form?.booking_id, "#AN-00014");
});

// ---------------------------------------------------------------------------
head("Not connected");

await test("no credentials, no venue: the salon takes requests", () => {
  assert.equal(partnerMode(facts, {}), "off");
  assert.equal(zohobookingsConnector.usable(venue(), {}), false);
  assert.equal(zohobookingsConnector.apiFor(venue(), {}), null);
  assert.equal(takesRequestsOnly(venue()), true);
  assert.equal(providerFor(venue()), requestOnlyProvider);
  assert.notEqual(providerFor(venue()), localProvider, "Zoho fell through to Belline's own diary");
  for (const channel of ["voice", "text"] as const) {
    const tools = toolsFor(venue(), channel).map((t) => t.name);
    for (const diary of BOOKING_TOOL_NAMES) assert.ok(!tools.includes(diary), `${channel} still has ${diary}`);
    assert.ok(tools.includes("take_booking_request"), channel);
  }
});

await test("a venue whose owner has granted nothing is not connected, however the flags are set", () => {
  const env = {
    FLAG_BOOKING_PARTNER_ZOHOBOOKINGS: "on",
    PARTNER_ZOHOBOOKINGS_API_KEY: "k",
    PARTNER_ZOHOBOOKINGS_ENV: "live",
    PARTNER_ZOHOBOOKINGS_CLIENT_ID: "cid",
    PARTNER_ZOHOBOOKINGS_CLIENT_SECRET: "secret",
  };
  assert.equal(zohobookingsConnector.usable(venue({ venueId: "workspace-1", accountsServer: "https://accounts.zoho.sa" }), env), false);
  for (const withdrawn of ["expiredAt", "misconfiguredAt"] as const) {
    const loc = venue({ ...LINK, [withdrawn]: "2026-09-18T00:00:00.000Z" });
    assert.equal(zohobookingsConnector.usable(loc, env), false, withdrawn);
    assert.equal(takesRequestsOnly(loc), true, withdrawn);
  }
});

await test("Zoho Bookings is not on the website's strip at all", () => {
  assert.equal(
    INTEGRATIONS.some((i) => i.flag === "booking.partner.zohobookings"),
    false,
    "Zoho Bookings was put on the landing page before anyone decided to list it",
  );
  assert.equal(partnerLive("zohobookings", {}), false);
});

/**
 * Unlike Cal.com and SimplyBook, Zoho's gate is the stronger kind: `liveNeeds`
 * holds Belline's own OAuth client credentials, so the website cannot say
 * "Available" until those exist on the deployment. That is closer to Mindbody's
 * shape than to Cal.com's, and it is worth pinning because it is the safer one.
 */
await test("the website stays on the roadmap until Belline's own OAuth client exists", () => {
  const item = { name: "Zoho Bookings", logo: "zohobookings.png", flag: "booking.partner.zohobookings", pending: "roadmap" } as const;
  assert.equal(integrationState(item, {}), "roadmap", "with no env at all");
  assert.equal(
    integrationState(item, { FLAG_BOOKING_PARTNER_ZOHOBOOKINGS: "on", PARTNER_ZOHOBOOKINGS_API_KEY: "k", PARTNER_ZOHOBOOKINGS_ENV: "live" }),
    "roadmap",
    "a live flag with no OAuth client promoted the logo",
  );
  assert.equal(integrationState(item, { FLAG_STUBS: "on", FLAG_BOOKING_PARTNER_ZOHOBOOKINGS: "on" }), "roadmap", "stubs promoted a logo");
  assert.equal(
    integrationState(item, {
      FLAG_BOOKING_PARTNER_ZOHOBOOKINGS: "on",
      PARTNER_ZOHOBOOKINGS_API_KEY: "k",
      PARTNER_ZOHOBOOKINGS_ENV: "live",
      PARTNER_ZOHOBOOKINGS_CLIENT_ID: "cid",
      PARTNER_ZOHOBOOKINGS_CLIENT_SECRET: "secret",
    }),
    "available",
    "the documented behaviour has changed; docs/integrations/partners.md says otherwise",
  );
});

// ---------------------------------------------------------------------------
head("Through the provider, as a venue would see it");

await test("everything Zoho can do is offered, and no waitlist", () => {
  const provider = withSandbox(sandboxPartner(facts));
  assert.equal(provider.capabilities.availability, true);
  assert.equal(provider.capabilities.confirms, true);
  assert.equal(provider.capabilities.reschedule, true);
  assert.equal(provider.capabilities.cancel, true);
  assert.equal(provider.capabilities.waitlist, false);
});

await test("a repeated booking is one booking, because Zoho has no idempotency key", async () => {
  const fake = sandboxPartner(facts);
  const provider = withSandbox(fake);
  const input = { date: "2026-09-22", startMin: 9 * 60, guestName: "Aisha", guestPhone: "+971504444444", serviceIds: ["svc-1"] };
  const first = await provider.createBooking({ location: venue() }, input);
  const again = await provider.createBooking({ location: venue() }, input);
  assert.ok(first.ok && again.ok);
  if (!first.ok || !again.ok) return;
  assert.equal(again.duplicate, true);
  assert.equal(fake.bookings().length, 1);
});

await test("a Zoho that cannot be reached quotes nothing and books nothing", async () => {
  const provider = withSandbox(sandboxPartner(facts, { down: true }));
  assert.deepEqual(await provider.checkAvailability({ location: venue() }, { locationId: salon.id, date: "2026-09-25" }), []);
  const made = await provider.createBooking(
    { location: venue() },
    { date: "2026-09-25", startMin: 9 * 60, guestName: "Yara", guestPhone: "+971501111111", serviceIds: ["svc-1"] },
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

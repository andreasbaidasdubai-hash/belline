/**
 * Microsoft Bookings, against a fake Bookings calendar.
 *
 * The most capable partner adapter Belline has, and the one with the most ways
 * to become quietly dishonest. Four facts are held down here rather than left
 * in a document:
 *
 * - **Availability has no delegated permission.** Microsoft's reference says
 *   "Not supported" for delegated work-or-school *and* personal accounts, so
 *   this can never ride on the Outlook connection an owner clicks through. If
 *   somebody later tries to fold it into `MICROSOFT_SCOPES`, this check fails.
 * - **Personal Microsoft accounts are out.** The Bookings API is shared
 *   bookings only. Outlook's `common` endpoint takes personal accounts; this
 *   must not be described as though it does.
 * - **The slot arithmetic is the venue's, not Belline's.** `getStaffAvailability`
 *   returns Available/Busy intervals, and Microsoft documents the cutting as
 *   the app's job. So the increment, the lead times, the buffers and the
 *   duration must all come off the venue's own calendar on every call, and a
 *   missing one must mean "no times" rather than a Belline default.
 * - **`allowStaffSelection` off means no name is promised.** Bookings picks
 *   the person, and Belle must not tell a caller who they are seeing.
 *
 * A green run is Belline's side being ready. No tenant has granted admin
 * consent, `booking.partner.msbookings` is off everywhere, and Microsoft
 * Bookings is not on the website's strip at all.
 *
 * Every outbound fetch is blocked for the whole run: nothing here reaches
 * Microsoft.
 *
 *   npm run check:msbookings
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-msbookings-"));
process.env.CREDENTIALS_KEY = Buffer.alloc(32, 9).toString("base64");
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PARTNER_MSBOOKINGS_") || key === "FLAG_BOOKING_PARTNER_MSBOOKINGS" || key === "FLAG_STUBS") delete process.env[key];
}

const { installFetchGuard, blockedFetches } = await import("../src/lib/testing/stubs");
installFetchGuard();

const { seedIfEmpty } = await import("../src/lib/seed");
const { listLocations } = await import("../src/lib/store");
const { PARTNERS, partnerLive } = await import("../src/lib/integrations/partners");
const {
  msbookingsConnector,
  msbookingsApi,
  msbookingsAdminConsentUrl,
  MSBOOKINGS_APP_PERMISSIONS,
  isoMinutes,
  slotsFrom,
} = await import("../src/lib/integrations/partners/msbookings");
const { partnerMode } = await import("../src/lib/integrations/partners/contract");
const { sandboxPartner } = await import("../src/lib/integrations/partners/sandbox");
const { partnerProvider } = await import("../src/lib/booking/partner-provider");
const { providerFor, requestOnlyProvider, localProvider } = await import("../src/lib/booking/provider");
const { takesRequestsOnly } = await import("../src/lib/booking/destination");
const { INTEGRATIONS, integrationState } = await import("./site-integrations");
const { BOOKING_TOOL_NAMES, toolsFor } = await import("../src/lib/agent/tools");
const { MICROSOFT_SCOPES } = await import("../src/lib/integrations/microsoft-api");
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
const facts = PARTNERS.msbookings;

const venue = (link: Record<string, unknown> | null = { venueId: "contoso@contoso.onmicrosoft.com" }): Loc =>
  ({
    ...salon,
    onboarding: {
      ...(salon.onboarding ?? { startedAt: "2026-09-01T00:00:00.000Z", steps: [] }),
      destination: { kind: "partner", partner: "msbookings", setAt: "2026-09-01T00:00:00.000Z" },
    },
    partners: link ? { msbookings: link } : undefined,
  }) as Loc;

const withSandbox = (api: PartnerApi) => partnerProvider({ ...msbookingsConnector, apiFor: () => api, usable: () => true });

// ---------------------------------------------------------------------------
// A fake Bookings calendar: Graph's shapes, and nothing Graph would not send.
// ---------------------------------------------------------------------------

interface FakeOptions {
  timeSlotInterval?: string;
  minimumLeadTime?: string;
  maximumLeadTime?: string;
  allowStaffSelection?: boolean;
  defaultDuration?: string;
  preBuffer?: string;
  postBuffer?: string;
  availability?: { status: string; from: string; to: string }[];
  staff?: { id: string; displayName: string }[];
}

function fakeGraph(options: FakeOptions = {}) {
  const calls: string[] = [];
  const bodies: unknown[] = [];
  const staff = options.staff ?? [{ id: "staff-1", displayName: "Dana" }];
  const transport = {
    async request<T>(req: PartnerRequest): Promise<T> {
      calls.push(`${req.method} ${req.path.replace(/solutions\/bookingBusinesses\/[^/]+/, "…")}`);
      if (req.body !== undefined) bodies.push(req.body);
      if (req.method === "GET" && /\/services$/.test(req.path)) {
        return {
          value: [
            {
              id: "svc-1",
              displayName: "Cut and finish",
              defaultDuration: options.defaultDuration ?? "PT1H",
              preBuffer: options.preBuffer,
              postBuffer: options.postBuffer,
            },
          ],
        } as T;
      }
      if (req.method === "GET" && /\/staffMembers$/.test(req.path)) return { value: staff } as T;
      if (req.method === "GET") {
        return {
          id: "contoso@contoso.onmicrosoft.com",
          schedulingPolicy: {
            timeSlotInterval: options.timeSlotInterval ?? "PT30M",
            minimumLeadTime: options.minimumLeadTime,
            maximumLeadTime: options.maximumLeadTime,
            allowStaffSelection: options.allowStaffSelection ?? true,
          },
        } as T;
      }
      if (/getStaffAvailability$/.test(req.path)) {
        const items = options.availability ?? [{ status: "Available", from: "2026-09-21T09:00:00", to: "2026-09-21T12:00:00" }];
        return {
          staffAvailabilityItem: staff.map((s) => ({
            staffId: s.id,
            availabilityItems: items.map((i) => ({
              status: i.status,
              startDateTime: { dateTime: i.from, timeZone: "UTC" },
              endDateTime: { dateTime: i.to, timeZone: "UTC" },
            })),
          })),
        } as T;
      }
      if (/\/appointments$/.test(req.path)) return { id: "appt-1" } as T;
      return undefined as T;
    },
  };
  return { transport, calls, bodies };
}

const NOW = () => new Date("2026-09-20T00:00:00Z");
const api = (options: FakeOptions = {}) => {
  const fake = fakeGraph(options);
  return { ...fake, api: msbookingsApi(fake.transport, { businessId: "contoso@contoso.onmicrosoft.com", now: NOW }) };
};

// ---------------------------------------------------------------------------
head("What the research found, written down");

await test("all four operations are recorded, because Graph documents all four", () => {
  assert.equal(facts.api.documented, true);
  assert.equal(facts.api.availability, true);
  assert.equal(facts.api.create, true);
  assert.equal(facts.api.reschedule, true);
  assert.equal(facts.api.cancel, true);
  assert.equal(facts.api.staffSelection, true);
  assert.equal(facts.api.catalogue, true);
  assert.equal(facts.model, "appointments");
});

await test("the auth model says application permissions, and says delegated is not an option", () => {
  assert.match(facts.auth, /application permissions only/i);
  assert.match(facts.auth, /client credentials/i);
  assert.match(facts.auth, /no delegated permission/i);
  assert.ok(
    facts.limits.some((l) => /no delegated permission/i.test(l)),
    "the limit that decides the whole architecture is not recorded",
  );
});

await test("the gate names admin consent, the licence and the sandbox's real condition", () => {
  assert.match(facts.gate.what, /admin consent/i);
  assert.match(facts.gate.what, /licence|license/i);
  // The free E5 tenant is not simply self-serve any more, and a founder
  // planning around it would waste a week finding that out.
  assert.match(facts.gate.what, /Visual Studio/i);
  assert.equal(facts.sandbox, "on-request");
  assert.deepEqual(facts.liveNeeds, ["PARTNER_MSBOOKINGS_CLIENT_ID", "PARTNER_MSBOOKINGS_CLIENT_SECRET"]);
});

await test("the tenant-wide grant and the personal-account gap are recorded as limits", () => {
  assert.ok(facts.limits.some((l) => /tenant-wide/i.test(l)), "the size of the grant is not recorded");
  assert.ok(facts.limits.some((l) => /[Pp]ersonal Microsoft account/.test(l)), "personal accounts are not recorded as unsupported");
  assert.ok(facts.limits.some((l) => /idempotency/i.test(l)), "the missing idempotency key is not recorded");
  assert.ok(facts.limits.some((l) => /UNVERIFIED/.test(l)), "nothing is marked unverified, which cannot be true of this much research");
});

await test("Belline asks for the two least permissions that do the job, not Bookings.Manage.All", () => {
  assert.deepEqual([...MSBOOKINGS_APP_PERMISSIONS], ["Bookings.Read.All", "BookingsAppointment.ReadWrite.All"]);
  const code = source("src/lib/integrations/partners/msbookings.ts");
  // Manage.All would also let Belline rewrite the venue's services and policy.
  assert.ok(!/"Bookings\.Manage\.All"/.test(code), "the adapter asks for permission to rewrite the venue's own settings");
});

await test("the Outlook connection is left alone: no Bookings scope leaks into it", () => {
  for (const scope of MICROSOFT_SCOPES) {
    assert.ok(!/Bookings/i.test(scope), `the Outlook calendar connection now asks for ${scope}`);
  }
  const outlook = source("src/lib/integrations/microsoft-api.ts");
  assert.ok(!/Bookings\.(Read|ReadWrite|Manage)/.test(outlook), "a Bookings permission was added to the delegated Outlook app");
});

await test("admin consent is a URL for an administrator, and Belline never opens it", () => {
  const url = msbookingsAdminConsentUrl("tenant-abc", "client-xyz", "https://app.belline.ai/cb");
  assert.match(url, /^https:\/\/login\.microsoftonline\.com\/tenant-abc\/adminconsent\?/);
  assert.match(url, /client_id=client-xyz/);
  const code = source("src/lib/integrations/partners/msbookings.ts");
  assert.ok(!/fetch\(\s*msbookingsAdminConsentUrl|open\(/.test(code), "Belline tries to walk through the consent screen itself");
});

// ---------------------------------------------------------------------------
head("Not connected");

await test("no app registration, no consent, no tenant: the venue takes requests", () => {
  assert.equal(partnerMode(facts, {}), "off");
  assert.equal(msbookingsConnector.usable(venue(), {}), false);
  assert.equal(msbookingsConnector.apiFor(venue(), {}), null);
  assert.equal(takesRequestsOnly(venue()), true);
  assert.equal(providerFor(venue()), requestOnlyProvider);
  assert.notEqual(providerFor(venue()), localProvider, "Microsoft Bookings fell through to Belline's own diary");
  for (const channel of ["voice", "text"] as const) {
    const tools = toolsFor(venue(), channel).map((t) => t.name);
    for (const diary of BOOKING_TOOL_NAMES) assert.ok(!tools.includes(diary), `${channel} still has ${diary}`);
    assert.ok(tools.includes("take_booking_request"), channel);
  }
});

await test("a tenant that has not consented is not connected, however good our app registration is", () => {
  const env = {
    FLAG_BOOKING_PARTNER_MSBOOKINGS: "on",
    PARTNER_MSBOOKINGS_API_KEY: "k",
    PARTNER_MSBOOKINGS_CLIENT_ID: "client",
    PARTNER_MSBOOKINGS_CLIENT_SECRET: "secret",
    PARTNER_MSBOOKINGS_ENV: "live",
  };
  assert.equal(partnerMode(facts, env), "live");
  assert.equal(
    msbookingsConnector.usable(venue({ venueId: "contoso@contoso.onmicrosoft.com" }), env),
    false,
    "a tenant with no admin consent looked connected",
  );
  assert.equal(msbookingsConnector.usable(venue({ venueId: "contoso@contoso.onmicrosoft.com", sealedToken: "sealed" }), env), true);
});

await test("live needs the app registration's own credentials, not only the flag", () => {
  const partial = { FLAG_BOOKING_PARTNER_MSBOOKINGS: "on", PARTNER_MSBOOKINGS_API_KEY: "k", PARTNER_MSBOOKINGS_ENV: "live" };
  assert.equal(partnerMode(facts, partial), "sandbox");
  assert.equal(partnerLive("msbookings", partial), false);
});

await test("a tenant that withdrew consent puts the venue back on requests", () => {
  const env = { FLAG_BOOKING_PARTNER_MSBOOKINGS: "on", PARTNER_MSBOOKINGS_API_KEY: "k" };
  for (const withdrawn of ["expiredAt", "misconfiguredAt"] as const) {
    const loc = venue({ venueId: "contoso@contoso.onmicrosoft.com", sealedToken: "sealed", [withdrawn]: "2026-09-18T00:00:00.000Z" });
    assert.equal(msbookingsConnector.usable(loc, env), false, withdrawn);
    assert.equal(takesRequestsOnly(loc), true, withdrawn);
  }
});

await test("Microsoft Bookings is not on the website's strip, and could not be promoted if it were", () => {
  assert.equal(
    INTEGRATIONS.some((i) => i.flag === "booking.partner.msbookings"),
    false,
    "Microsoft Bookings was put on the landing page before anyone agreed to it",
  );
  // And if the founder adds it, the honesty gate already covers it.
  const item = { name: "Microsoft Bookings", logo: "msbookings.png", flag: "booking.partner.msbookings", pending: "roadmap" } as const;
  assert.equal(integrationState(item, {}), "roadmap");
  assert.equal(
    integrationState(item, { FLAG_BOOKING_PARTNER_MSBOOKINGS: "on", PARTNER_MSBOOKINGS_API_KEY: "k", PARTNER_MSBOOKINGS_ENV: "live" }),
    "roadmap",
    "a key and a switch promoted Microsoft Bookings with no tenant behind it",
  );
});

// ---------------------------------------------------------------------------
head("The slot arithmetic is the venue's, not Belline's");

await test("an ISO 8601 duration is read, and anything unreadable is not guessed at", () => {
  assert.equal(isoMinutes("PT1H"), 60);
  assert.equal(isoMinutes("PT30M"), 30);
  assert.equal(isoMinutes("PT1H30M"), 90);
  assert.equal(isoMinutes("P1DT2H"), 26 * 60);
  assert.equal(isoMinutes(undefined), undefined);
  assert.equal(isoMinutes(""), undefined);
  assert.equal(isoMinutes("1 hour"), undefined, "a duration Belline cannot parse became a number");
});

await test("only Available is bookable: Busy, Tentative and anything new are not", () => {
  const rules = { durationMin: 60, preBufferMin: 0, postBufferMin: 0, incrementMin: 60 };
  for (const status of ["Busy", "Tentative", "OutOfOffice", "SomethingMicrosoftAddsLater"]) {
    const out = slotsFrom(
      [{ status, startDateTime: { dateTime: "2026-09-21T09:00:00" }, endDateTime: { dateTime: "2026-09-21T17:00:00" } }],
      rules,
      "2026-09-21",
      NOW(),
    );
    assert.deepEqual(out, [], `${status} was offered as bookable`);
  }
});

await test("starts sit on the venue's increment, and the service plus its buffers must fit inside", () => {
  const items = [{ status: "Available", startDateTime: { dateTime: "2026-09-21T09:00:00" }, endDateTime: { dateTime: "2026-09-21T11:00:00" } }];
  // A 60-minute service on a 30-minute grid: 09:00, 09:30, 10:00.
  assert.deepEqual(
    slotsFrom(items, { durationMin: 60, preBufferMin: 0, postBufferMin: 0, incrementMin: 30 }, "2026-09-21", NOW()).map((s) => s.startMin),
    [9 * 60, 9 * 60 + 30, 10 * 60],
  );
  // The same service with a 15-minute buffer each side takes 90 minutes of the
  // staff member's calendar, so only two blocks fit and the guest's own time
  // starts after the pre-buffer.
  assert.deepEqual(
    slotsFrom(items, { durationMin: 60, preBufferMin: 15, postBufferMin: 15, incrementMin: 30 }, "2026-09-21", NOW()).map((s) => s.startMin),
    [9 * 60 + 15, 9 * 60 + 45],
  );
});

await test("minimum and maximum lead time are honoured, because Microsoft says the app must", () => {
  const items = [{ status: "Available", startDateTime: { dateTime: "2026-09-21T09:00:00" }, endDateTime: { dateTime: "2026-09-21T12:00:00" } }];
  const base = { durationMin: 60, preBufferMin: 0, postBufferMin: 0, incrementMin: 60 };
  // "now" is 2026-09-20T00:00Z, so 09:00 the next day is 33 hours ahead.
  const all = slotsFrom(items, base, "2026-09-21", NOW()).map((s) => s.startMin);
  assert.deepEqual(all, [9 * 60, 10 * 60, 11 * 60]);
  // A two-day minimum notice removes all of them.
  assert.deepEqual(slotsFrom(items, { ...base, minimumLeadMin: 2 * 24 * 60 }, "2026-09-21", NOW()), []);
  // A one-day maximum horizon does too, from the other end.
  assert.deepEqual(slotsFrom(items, { ...base, maximumLeadMin: 24 * 60 }, "2026-09-21", NOW()), []);
});

await test("a duration or an increment Belline cannot read means no times, never a default", () => {
  const items = [{ status: "Available", startDateTime: { dateTime: "2026-09-21T09:00:00" }, endDateTime: { dateTime: "2026-09-21T17:00:00" } }];
  assert.deepEqual(slotsFrom(items, { durationMin: 0, preBufferMin: 0, postBufferMin: 0, incrementMin: 30 }, "2026-09-21", NOW()), []);
  assert.deepEqual(slotsFrom(items, { durationMin: 60, preBufferMin: 0, postBufferMin: 0, incrementMin: 0 }, "2026-09-21", NOW()), []);
  const code = source("src/lib/integrations/partners/msbookings.ts");
  // The moment a `?? 30` appears beside the increment or the duration, Belline
  // is quoting its own opinion of the venue's diary.
  assert.ok(!/incrementMin\s*=\s*isoMinutes\([^)]*\)\s*\?\?\s*\d/.test(code), "the time slot interval has a Belline default");
  assert.ok(!/durationMin\s*=\s*isoMinutes\([^)]*\)\s*\?\?\s*\d/.test(code), "the service duration has a Belline default");
});

await test("the adapter reads the venue's settings on every question and caches none of them", async () => {
  const { api: bookings, calls } = api();
  await bookings.availability({ date: "2026-09-21", serviceIds: ["svc-1"] });
  assert.ok(calls.includes("GET …"), "the business's own scheduling policy was not read");
  assert.ok(calls.includes("GET …/services"), "the service's duration and buffers were not read");
  assert.ok(calls.includes("GET …/staffMembers"), "the venue's staff were not read");
  assert.ok(calls.includes("POST …/getStaffAvailability"), "getStaffAvailability was not the source of availability");
});

// ---------------------------------------------------------------------------
head("Against a fake Bookings calendar");

await test("a service the venue does not offer is quoted no times at all", async () => {
  const { api: bookings } = api();
  assert.deepEqual(await bookings.availability({ date: "2026-09-21", serviceIds: ["svc-nope"] }), []);
  // And no service at all is not a question Bookings can answer.
  assert.deepEqual(await bookings.availability({ date: "2026-09-21" }), []);
});

await test("the venue's own hours, increment and buffers decide what is offered", async () => {
  const { api: bookings } = api({
    timeSlotInterval: "PT30M",
    defaultDuration: "PT1H",
    availability: [{ status: "Available", from: "2026-09-21T09:00:00", to: "2026-09-21T11:00:00" }],
  });
  const slots = await bookings.availability({ date: "2026-09-21", serviceIds: ["svc-1"] });
  assert.deepEqual(slots.map((s) => s.startMin), [9 * 60, 9 * 60 + 30, 10 * 60]);
  assert.deepEqual(slots.map((s) => s.endMin), [10 * 60, 10 * 60 + 30, 11 * 60]);
  assert.deepEqual(slots.map((s) => s.staffName), ["Dana", "Dana", "Dana"]);
});

await test("where the venue turned staff selection off, no name is promised to the caller", async () => {
  const { api: bookings } = api({ allowStaffSelection: false });
  const slots = await bookings.availability({ date: "2026-09-21", serviceIds: ["svc-1"] });
  assert.ok(slots.length > 0);
  assert.deepEqual([...new Set(slots.map((s) => s.staffId))], [undefined], "Belline named a person Bookings may not give the caller");
  assert.deepEqual([...new Set(slots.map((s) => s.staffName))], [undefined]);
  // And asking for one is refused rather than answered with somebody else.
  assert.deepEqual(await bookings.availability({ date: "2026-09-21", serviceIds: ["svc-1"], staffId: "staff-1" }), []);
});

await test("a person the venue does not have is never offered", async () => {
  const { api: bookings } = api();
  assert.deepEqual(await bookings.availability({ date: "2026-09-21", serviceIds: ["svc-1"], staffId: "nobody" }), []);
  const theirs = await bookings.availability({ date: "2026-09-21", serviceIds: ["svc-1"], staffId: "staff-1" });
  assert.ok(theirs.length > 0);
});

await test("a booking is Graph's own shape, with the @odata.type the API insists on", async () => {
  const { api: bookings, bodies } = api();
  const ref = await bookings.create({
    date: "2026-09-21",
    startMin: 9 * 60,
    endMin: 10 * 60,
    guestName: "Layla",
    guestPhone: "+971501234567",
    guestEmail: "layla@example.com",
    serviceIds: ["svc-1"],
    staffId: "staff-1",
    idempotencyKey: "k-1",
  });
  assert.equal(ref.id, "appt-1");
  const body = bodies.at(-1) as Record<string, unknown>;
  assert.equal(body["@odata.type"], "#microsoft.graph.bookingAppointment");
  assert.equal(body.serviceId, "svc-1");
  const customer = (body.customers as Record<string, unknown>[])[0];
  // Graph fails the request outright without this, and it is the kind of thing
  // a later tidy-up removes.
  assert.equal(customer["@odata.type"], "#microsoft.graph.bookingCustomerInformation");
  assert.equal(customer.name, "Layla");
  assert.equal(customer.phone, "+971501234567");
  assert.deepEqual(body.staffMemberIds, ["staff-1"]);
});

await test("a booking with no service is refused before a request is made", async () => {
  const { api: bookings, calls } = api();
  await assert.rejects(
    () =>
      bookings.create({
        date: "2026-09-21",
        startMin: 9 * 60,
        endMin: 10 * 60,
        guestName: "Layla",
        guestPhone: "+971501234567",
        idempotencyKey: "k-2",
      }),
    /needs the service/,
  );
  assert.deepEqual(calls, [], "Belline asked Microsoft to book something it had not been told about");
});

await test("an appointment is moved with PATCH, and cancelled with a message a guest can read", async () => {
  const { api: bookings, calls, bodies } = api();
  const moved = await bookings.reschedule({ id: "appt-1" }, { date: "2026-09-22", startMin: 11 * 60, endMin: 12 * 60 });
  assert.equal(moved.id, "appt-1", "a moved appointment changed its Microsoft id");
  assert.ok(calls.some((c) => c.startsWith("PATCH …/appointments/")), "the move did not use PATCH");
  await bookings.cancel({ id: "appt-1" }, "  ");
  assert.ok(calls.some((c) => c.includes("/cancel")), "the cancellation did not use the cancel action");
  const message = (bodies.at(-1) as { cancellationMessage?: string }).cancellationMessage ?? "";
  // Microsoft mails this to the customer, so an empty reason must not become an
  // empty email.
  assert.ok(message.trim().length > 0, "Microsoft would have mailed the guest an empty cancellation");
  assert.ok(!/undefined|null|error/i.test(message), `the guest would have been mailed "${message}"`);
});

// ---------------------------------------------------------------------------
head("Through the provider, as a venue would see it");

await test("everything Bookings can do is offered, and the waitlist still is not", async () => {
  const provider = withSandbox(sandboxPartner(facts, { staff: [{ id: "staff-1", name: "Dana" }] }));
  assert.equal(provider.capabilities.availability, true);
  assert.equal(provider.capabilities.confirms, true);
  assert.equal(provider.capabilities.reschedule, true);
  assert.equal(provider.capabilities.cancel, true);
  assert.equal(provider.capabilities.staffSelection, true);
  // A slot freed inside Bookings is never seen here, so nobody is rung about it.
  assert.equal(provider.capabilities.waitlist, false);
});

await test("a booking is the venue's appointment, and a repeat is not a second one", async () => {
  const fake = sandboxPartner(facts, { staff: [{ id: "staff-1", name: "Dana" }] });
  const provider = withSandbox(fake);
  const input = {
    date: "2026-09-22",
    startMin: 9 * 60,
    guestName: "Aisha",
    guestPhone: "+971504444444",
    serviceIds: ["svc-1"],
    staffId: "staff-1",
  };
  const first = await provider.createBooking({ location: venue() }, input);
  const again = await provider.createBooking({ location: venue() }, input);
  assert.ok(first.ok && again.ok);
  if (!first.ok || !again.ok) return;
  assert.equal(again.duplicate, true);
  // Bookings has no idempotency key of its own, so this guard is the only one.
  assert.equal(fake.bookings().length, 1, "a retried booking became two appointments");
});

await test("a calendar that cannot be reached quotes nothing and books nothing", async () => {
  const provider = withSandbox(sandboxPartner(facts, { staff: [{ id: "staff-1", name: "Dana" }], down: true }));
  assert.deepEqual(await provider.checkAvailability({ location: venue() }, { locationId: salon.id, date: "2026-09-25" }), []);
  const made = await provider.createBooking(
    { location: venue() },
    { date: "2026-09-25", startMin: 9 * 60, guestName: "Yara", guestPhone: "+971501111111", serviceIds: ["svc-1"], staffId: "staff-1" },
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

/**
 * The staff exceptions queue.
 *
 * One open row per venue and kind however often it is raised; a resolve needs
 * a note and the minutes spent; an owner sees their own tickets and never
 * another tenant's, or the internal reason; only Belline staff reach the page
 * and the API. The team alert goes to the outbox while email is off, and
 * nothing touches the network.
 *
 *   npm run check:exceptions
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-exceptions-"));
for (const k of Object.keys(process.env)) if (k.startsWith("FLAG_") || k === "RESEND_API_KEY" || k === "EXCEPTIONS_EMAIL") delete process.env[k];

const realFetch = globalThis.fetch;
let fetches = 0;
globalThis.fetch = (async () => {
  fetches++;
  throw new Error("network is off in check:exceptions");
}) as typeof fetch;

const { seedIfEmpty } = await import("../src/lib/seed");
const { signUp } = await import("../src/lib/onboarding");
const { createUser, isBellineStaff } = await import("../src/lib/auth");
const { listTenants } = await import("../src/lib/store");
const { openException, listExceptions, updateException, exceptionsVisibleTo, ownerTickets, BELLE_KINDS, KIND_META, EXCEPTION_KINDS } = await import(
  "../src/lib/exceptions"
);
const { outboxFile } = await import("../src/lib/mailer");

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
const quiet = <T>(fn: () => T): T => {
  const original = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = original;
  }
};

seedIfEmpty();
const a = await signUp({ businessName: "Queue Salon A", email: "owner@queue-a.test", password: "Correct-Horse-Battery-9", vertical: "salon" });
const b = await signUp({ businessName: "Queue Salon B", email: "owner@queue-b.test", password: "Correct-Horse-Battery-9", vertical: "salon" });
assert.ok(a.ok && b.ok);
const venueA = a.ok ? a.location : null!;
const venueB = b.ok ? b.location : null!;
const ownerA = a.ok ? a.user : null!;

console.log("\n\x1b[1mOne row per venue and kind\x1b[0m\n");

await test("the same kind twice while open is one row with count 2", async () => {
  const first = quiet(() => openException({ tenantId: venueA.tenantId, locationId: venueA.id, kind: "pool_empty", reason: "No number", source: "system" }));
  const second = quiet(() => openException({ tenantId: venueA.tenantId, locationId: venueA.id, kind: "pool_empty", reason: "No number again", source: "system" }));
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.exception.id, first.exception.id);
  assert.equal(second.exception.count, 2);
  assert.equal(listExceptions({ locationId: venueA.id, kind: "pool_empty" }).length, 1);
  await first.notified;
});

await test("another kind, or another venue, is its own row", () => {
  quiet(() => openException({ tenantId: venueA.tenantId, locationId: venueA.id, kind: "billing_dispute", reason: "Invoice query", source: "belle" }));
  quiet(() => openException({ tenantId: venueB.tenantId, locationId: venueB.id, kind: "pool_empty", reason: "No number", source: "system" }));
  assert.equal(listExceptions({ locationId: venueA.id }).length, 2);
  assert.equal(listExceptions({ kind: "pool_empty" }).length, 2);
});

await test("two conversations asking for a person on the same line are two rows", () => {
  const one = quiet(() => openException({ tenantId: venueB.tenantId, locationId: venueB.id, kind: "handoff_requested", reason: "x", context: { conversationId: 1 }, source: "system" }));
  const two = quiet(() => openException({ tenantId: venueB.tenantId, locationId: venueB.id, kind: "handoff_requested", reason: "x", context: { conversationId: 2 }, source: "system" }));
  assert.notEqual(one.exception.id, two.exception.id);
});

await test("tickets are short, readable and unique", () => {
  const tickets = listExceptions({ status: "all" }).map((r) => r.ticket);
  assert.ok(tickets.every((t) => /^B-[2-9A-HJ-NP-Z]{4}$/.test(t)), tickets.join(","));
  assert.equal(new Set(tickets).size, tickets.length);
});

console.log("\n\x1b[1mResolving\x1b[0m\n");

const row = () => listExceptions({ locationId: venueA.id, kind: "pool_empty", status: "all" })[0];

await test("a resolve without a note is refused", () => {
  const out = updateException(row().id, { kind: "resolve", note: "  ", minutes: 5, by: "Staff" });
  assert.equal(out.ok, false);
  assert.equal(out.ok ? 0 : out.status, 422);
  assert.equal(row().status, "open");
});

await test("minutes must be a whole number in range", () => {
  for (const minutes of [-1, 2.5, "abc", NaN, 5000]) {
    const out = updateException(row().id, { kind: "resolve", note: "Assigned a number", minutes, by: "Staff" });
    assert.equal(out.ok, false, String(minutes));
  }
});

await test("waiting on the customer, then resolved with note and minutes", () => {
  assert.ok(updateException(row().id, { kind: "waiting", by: "Staff" }).ok);
  assert.equal(row().status, "waiting_customer");
  const out = updateException(row().id, { kind: "resolve", note: "Assigned +971 4 000 0000", minutes: 12, by: "Staff" });
  assert.ok(out.ok);
  assert.equal(row().status, "resolved");
  assert.equal(row().humanMinutes, 12);
  assert.equal(row().resolvedBy, "Staff");
  assert.equal(updateException(row().id, { kind: "resolve", note: "again", minutes: 1, by: "Staff" }).ok, false);
});

await test("raising it again after it was resolved opens a fresh row", () => {
  const again = quiet(() => openException({ tenantId: venueA.tenantId, locationId: venueA.id, kind: "pool_empty", reason: "Still none", source: "system" }));
  assert.equal(again.created, true);
  assert.equal(listExceptions({ locationId: venueA.id, kind: "pool_empty", status: "all" }).length, 2);
});

await test("an account recovery is one row per person, with no venue", () => {
  quiet(() => openException({ tenantId: ownerA.tenantId, kind: "account_recovery", reason: "locked out", context: { userId: ownerA.id }, source: "owner" }));
  const out = quiet(() => openException({ tenantId: ownerA.tenantId, kind: "account_recovery", reason: "locked out", context: { userId: ownerA.id }, source: "owner" }));
  assert.equal(out.exception.count, 2);
  assert.equal(out.exception.locationId, undefined);
});

console.log("\n\x1b[1mWho sees what\x1b[0m\n");

await test("an owner sees only their own tenant's rows", () => {
  const seen = exceptionsVisibleTo(ownerA, { status: "all" });
  assert.ok(seen.length > 0);
  assert.ok(seen.every((r) => r.tenantId === ownerA.tenantId));
  assert.ok(!seen.some((r) => r.locationId === venueB.id));
  assert.equal(isBellineStaff(ownerA), false);
});

await test("Belline staff see every row", () => {
  const internal = listTenants().find((t) => t.internal);
  assert.ok(internal, "no internal tenant seeded");
  const made = createUser({ email: "staff@belline.test", name: "Staff", password: "Correct-Horse-Battery-9", role: "owner", tenantId: internal!.id });
  assert.ok(made.ok);
  const staff = made.ok ? made.user : null!;
  assert.ok(isBellineStaff(staff));
  assert.equal(exceptionsVisibleTo(staff, { status: "all" }).length, listExceptions({ status: "all" }).length);
});

await test("the owner's ticket view has the number and status, never the internal reason", () => {
  const tickets = ownerTickets(venueA.id);
  assert.ok(tickets.length >= 1);
  const text = JSON.stringify(tickets);
  assert.ok(!/Invoice query|Still none|reason|context/.test(text), text);
  assert.match(tickets[0].status, /team is on it/);
});

await test("the API and the page refuse anybody but Belline staff", () => {
  const api = source("src/app/api/sales/exceptions/route.ts");
  assert.match(api, /isBellineStaff\(auth\.user\)/);
  assert.match(api, /status: 403/);
  assert.match(api, /requireApiUser/);
  assert.equal((api.match(/const who = await staff\(\)/g) ?? []).length, 2, "GET and POST both check");
  const page = source("src/app/(internal)/sales/exceptions/page.tsx");
  assert.match(page, /if \(!isBellineStaff\(user\)\) return/);
  assert.match(source("src/app/(internal)/layout.tsx"), /\/sales\/exceptions/);
});

await test("the page shows reason, next action, contact and a resolve form", () => {
  const page = source("src/app/(internal)/sales/exceptions/page.tsx");
  for (const bit of ["r.reason", "meta.next", "mailto:", "ExceptionActions", "humanMinutes"]) assert.ok(page.includes(bit), bit);
  assert.ok(EXCEPTION_KINDS.every((k) => KIND_META[k].label && KIND_META[k].next));
});

await test("the setup step shows the owner's open ticket", () => {
  const step = source("src/app/setup/[step]/page.tsx");
  assert.match(step, /ownerTickets\(venue\.id\)/);
  assert.match(step, /Ticket \{t\.ticket\}/);
});

console.log("\n\x1b[1mWhere rows come from\x1b[0m\n");

await test("Go live without a number opens pool_empty; a handoff on Belline's own line opens handoff_requested", () => {
  assert.match(source("src/app/(app)/golive/page.tsx"), /kind: "pool_empty"/);
  const respond = source("src/lib/reception/respond.ts");
  assert.match(respond, /location\.tenantId === BELLINE_TENANT_ID[\s\S]{0,200}kind: "handoff_requested"/);
});

await test("Belle may open only kinds an owner cannot fix alone", () => {
  for (const k of ["import_failed_3x", "account_recovery", "vendor_balance_low", "handoff_requested"] as const) assert.ok(!BELLE_KINDS.includes(k), k);
  for (const k of ["pool_empty", "owner_requested_human", "whatsapp_rejected"] as const) assert.ok(BELLE_KINDS.includes(k), k);
});

console.log("\n\x1b[1mThe team alert\x1b[0m\n");

await test("with email off the alert goes to the outbox, once per new row, and nothing reaches the network", async () => {
  const before = fs.existsSync(outboxFile()) ? fs.readFileSync(outboxFile(), "utf8").split("\n").filter(Boolean).length : 0;
  const opened = quiet(() => openException({ tenantId: venueB.tenantId, locationId: venueB.id, kind: "whatsapp_rejected", reason: "Meta refused", source: "system" }));
  assert.equal(await opened.notified, true);
  const repeat = quiet(() => openException({ tenantId: venueB.tenantId, locationId: venueB.id, kind: "whatsapp_rejected", reason: "Meta refused", source: "system" }));
  assert.equal(await repeat.notified, false);
  const lines = fs.readFileSync(outboxFile(), "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, before + 1);
  assert.ok(lines.at(-1)!.includes(opened.exception.ticket));
  assert.equal(fetches, 0);
});

await test("rows are written to exceptions.json in the data directory", () => {
  const file = path.join(process.env.DATA_DIR!, "exceptions.json");
  const rows = JSON.parse(fs.readFileSync(file, "utf8")) as unknown[];
  assert.equal(rows.length, listExceptions({ status: "all" }).length);
});

globalThis.fetch = realFetch;
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);

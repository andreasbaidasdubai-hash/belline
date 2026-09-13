/**
 * A guest managing their own booking from the link in their confirmation.
 *
 *   npm run check:manage
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-manage-"));
process.env.SESSION_SECRET = "test-secret-for-manage-links-000000000000";
delete process.env.RESEND_API_KEY;

const { seedIfEmpty } = await import("../src/lib/seed");
const { listLocations } = await import("../src/lib/store");
const { signBookingToken, verifyBookingToken } = await import("../src/lib/auth");
const { createBooking, cancelBooking, confirmationMessage } = await import("../src/lib/booking");
const { manageUrl, manageable, bookingEmail, bookingIcs, alternativeTimes, sendBookingEmail } = await import(
  "../src/lib/booking/manage"
);
const { addDays, todayIn } = await import("../src/lib/time");

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
const salon = listLocations().find((l) => l.vertical === "salon")!;
const service = salon.salon!.services[0];

// Find a real free slot a few days out, the way a guest would have booked it.
let booking: import("../src/lib/types").Booking | null = null;
for (let d = 3; d < 20 && !booking; d++) {
  const date = addDays(todayIn(salon.timezone), d);
  for (const startMin of [10 * 60, 11 * 60, 14 * 60, 15 * 60]) {
    const r = createBooking(salon, {
      date,
      startMin,
      guestName: "Mira",
      guestPhone: "+971509998877",
      guestEmail: "mira@example.com",
      serviceIds: [service.id],
      staffOverride: true,
    });
    if (r.ok) {
      booking = r.booking;
      break;
    }
  }
}
assert.ok(booking, "could not make a test booking");
const b = booking!;

console.log("\n\x1b[1mThe link\x1b[0m\n");

await test("the link opens the booking it was made for", () => {
  assert.equal(verifyBookingToken(signBookingToken(b.id)), b.id);
});

await test("a guessed or altered link opens nothing", () => {
  const token = signBookingToken(b.id);
  assert.equal(verifyBookingToken(`${b.id}.${"x".repeat(32)}`), null);
  assert.equal(verifyBookingToken(token.replace(b.id, "bk_someone_else")), null);
  assert.equal(verifyBookingToken(""), null);
});

await test("the confirmation text carries the link", () => {
  assert.ok(confirmationMessage(salon, b).includes(manageUrl(b)));
});

console.log("\n\x1b[1mThe email\x1b[0m\n");

await test("a confirmation names the service, the reference, and both links", () => {
  const mail = bookingEmail(salon, b, "confirmed");
  assert.match(mail.subject, /Confirmed/);
  // The plain-text part: the HTML escapes "&" in a name like "Cut & finish".
  assert.ok(mail.text.includes(service.name), `service name missing: ${service.name}`);
  assert.ok(mail.text.includes(b.ref), "reference missing");
  assert.ok(mail.text.includes(manageUrl(b)), "manage link missing from text");
  assert.ok(mail.html.includes(manageUrl(b)), "manage link missing from html");
  assert.ok(mail.html.includes("calendar.ics"), "calendar link missing");
});

await test("a cancellation email offers no link to change a booking that is gone", () => {
  const mail = bookingEmail(salon, b, "cancelled");
  assert.ok(!mail.html.includes(manageUrl(b)));
});

await test("with no email provider, nothing is sent and nothing throws", async () => {
  const r = await sendBookingEmail(salon, b, "confirmed");
  assert.equal(r.sent, false);
});

await test("the calendar file is a valid event with the reference", () => {
  const ics = bookingIcs(salon, b);
  assert.match(ics, /BEGIN:VEVENT/);
  assert.match(ics, /DTSTART:\d{8}T\d{6}Z/);
  assert.ok(ics.includes(b.ref));
});

console.log("\n\x1b[1mChanging and cancelling\x1b[0m\n");

await test("an upcoming booking can be managed", () => {
  assert.equal(manageable(salon, b).ok, true);
});

await test("other times never include the one they already have", () => {
  const times = alternativeTimes(salon, b, 7);
  assert.ok(!times.some((s) => s.date === b.date && s.startMin === b.startMin));
});

await test("a cancelled booking cannot be managed again", () => {
  const gone = cancelBooking(b, salon, "test");
  assert.equal(manageable(salon, gone).ok, false);
});

console.log(`\n${failed ? "\x1b[31m" : "\x1b[32m"}✓ ${passed} passed, ${failed} failed\x1b[0m\n`);
if (failed > 0) process.exitCode = 1;

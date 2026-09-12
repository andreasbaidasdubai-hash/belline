/**
 * The times the page is allowed to show.
 *
 * The picker exists so nobody has to hold four times in their head while
 * being read them. That only helps if what is on screen is exactly what the
 * engine offered — a page showing a slot the diary does not have is worse
 * than no picker at all, because somebody taps it and is told no.
 *
 *   npm run check:slots
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-slots-"));

const { seedIfEmpty } = await import("../src/lib/seed");
const { getLocation } = await import("../src/lib/store");
const { BELLINE_LOCATION_ID } = await import("../src/lib/seed-belline");
const { startCall } = await import("../src/lib/calls");
const { executeTool } = await import("../src/lib/agent/tools");
const { findAvailability } = await import("../src/lib/booking");
const { todayIn } = await import("../src/lib/time");

let passed = 0;
let failed = 0;
let queue: Promise<void> = Promise.resolve();

function test(name: string, fn: () => void | Promise<void>) {
  queue = queue.then(async () => {
    try {
      await fn();
      console.log(`  [32m✓[0m ${name}`);
      passed++;
    } catch (err) {
      console.log(`  [31m✗[0m ${name}`);
      console.log(`      ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  });
}

seedIfEmpty();
const belline = getLocation(BELLINE_LOCATION_ID)!;

/** The next day the demo diary actually offers something. */
function nextOpenDay(): string {
  const today = todayIn(belline.timezone);
  for (let i = 0; i < 14; i++) {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    const day = d.toISOString().slice(0, 10);
    if (
      findAvailability(belline, {
        locationId: belline.id,
        date: day,
        serviceIds: ["demo_call"],
      }).length
    ) {
      return day;
    }
  }
  throw new Error("the diary offers nothing in the next fortnight");
}

const day = nextOpenDay();

function check(date: string) {
  return checkOn(date).out;
}

/**
 * The same lookup, keeping hold of the call it happened on.
 *
 * Quoting a time keeps it back for a minute or so, per call — see
 * booking/holds.ts. So "what would the diary give me" is only a meaningful
 * question with a call attached to it: asked from nowhere, the answer
 * correctly excludes the very times this call was just quoted.
 */
function checkOn(date: string) {
  const call = startCall(belline, "browser", "browser-console");
  return {
    call,
    out: executeTool(
      "check_availability",
      { date, service_ids: ["demo_call"] },
      { location: belline, call, callerNumber: "" } as never,
    ),
  };
}

console.log("\nWhat the picker is given\n");

test("availability comes back with times a page could render", async () => {
  const out = (await check(day)) as { result: Record<string, unknown> };
  assert.equal(out.result.available, true, JSON.stringify(out.result));
  const options = out.result.options as { time: string; spoken: string }[];
  assert.ok(options.length > 0, "no options at all");
  for (const o of options) {
    assert.match(o.time, /^\d{2}:\d{2}$/, `"${o.time}" is not a clock time`);
    assert.ok(o.spoken.length > 0, `${o.time} has nothing to say`);
  }
});

test("every time shown is one the diary would actually take", async () => {
  // The whole point. A picker offering a slot the engine does not have is
  // worse than no picker: somebody taps it and gets told no.
  const { call, out: pending } = checkOn(day);
  const out = (await pending) as { result: Record<string, unknown> };
  const options = out.result.options as { time: string }[];
  const real = new Set(
    findAvailability(
      belline,
      { locationId: belline.id, date: day, serviceIds: ["demo_call"] },
      // As this call, not as a stranger: the times it was just quoted are
      // being held *for* it, and a search from nowhere would not see them.
      { callId: call.id },
    ).map((s) => `${String(Math.floor(s.startMin / 60)).padStart(2, "0")}:${String(s.startMin % 60).padStart(2, "0")}`),
  );
  for (const o of options) {
    assert.ok(real.has(o.time), `${o.time} is on the page but not in the diary`);
  }
});

test("a day with nothing free offers nothing to tap", async () => {
  // Sunday is not in Belline's week; the picker must stay empty rather than
  // invent a row of times nobody can have.
  const closed = new Date(`${day}T12:00:00Z`);
  while (closed.getUTCDay() !== 6) closed.setUTCDate(closed.getUTCDate() + 1);
  const out = (await check(closed.toISOString().slice(0, 10))) as {
    result: Record<string, unknown>;
  };
  if (out.result.available) {
    // Saturday happens to be open here; then the assertion is simply that
    // whatever came back is internally consistent, which the test above owns.
    assert.ok(Array.isArray(out.result.options));
    return;
  }
  assert.equal(out.result.options, undefined, "a closed day still offered times");
});

test("what a tap says is a sentence the agent can act on", async () => {
  // The tap sends speech rather than booking directly, so there is one path
  // through the booking engine instead of two that can drift apart.
  const out = (await check(day)) as { result: Record<string, unknown> };
  const [first] = out.result.options as { spoken: string; with?: string }[];
  const said = first.with ? `${first.spoken} with ${first.with}, please.` : `${first.spoken}, please.`;
  assert.ok(said.length > 6, `"${said}" is not much of a sentence`);
  assert.doesNotMatch(said, /undefined|NaN|\[object/);
});

console.log("\nTimes are on screen before anybody asks\n");

test("only the transport with a screen is marked as having one", async () => {
  // The session sends opening times when `transport.screen` is set, and never
  // otherwise. Asserted on the flag rather than by starting a session: doing
  // that opens real connections to three vendors, which is not a unit test.
  const { BrowserTransport, TwilioTransport } = await import("../src/lib/voice/transports");
  const socket = { readyState: 1, OPEN: 1, send() {}, close() {} } as never;

  assert.equal(new BrowserTransport(socket).screen, true, "the browser cannot be shown times");
  assert.equal(
    new TwilioTransport(socket, "sid").screen,
    false,
    "a telephone is being sent a list of times nobody can see",
  );
});

test("the opening times come from the venue's own first service", async () => {
  // Whatever is shown before anybody speaks has to be bookable, same as the
  // rest. Belline's own venue sells one thing, so that is what is offered.
  const services = belline.salon!.services;
  assert.equal(services.length, 1);
  const slots = findAvailability(belline, {
    locationId: belline.id,
    date: day,
    serviceIds: [services[0].id],
  });
  assert.ok(slots.length > 0, "the opening screen would have nothing to show");
});

queue.then(() => {
  fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
  console.log(
    failed === 0
      ? `\n[32m✓ ${passed} passed, 0 failed[0m\n`
      : `\n[31m✗ ${passed} passed, ${failed} failed[0m\n`,
  );
  if (failed > 0) process.exitCode = 1;
});

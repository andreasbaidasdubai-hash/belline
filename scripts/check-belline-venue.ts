/**
 * Belline answering its own phone.
 *
 * The bell on the website opens a real call to this venue, so a fault here is
 * a fault on the front page. Two things are tested hardest: that a demo call
 * can actually be booked, and that an email address taken by ear is checked
 * rather than trusted — an address misheard on a phone line never bounces, it
 * just means the person never hears from us.
 *
 *   npm run check:belline
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-venue-"));

const { seedIfEmpty } = await import("../src/lib/seed");
const { getLocation, listBookings } = await import("../src/lib/store");
const { BELLINE_LOCATION_ID } = await import("../src/lib/seed-belline");
const { startCall } = await import("../src/lib/calls");
const { executeTool, toolsFor } = await import("../src/lib/agent/tools");
const { findAvailability } = await import("../src/lib/booking");
const { mayStreamTo, watchLiveness, sweepLiveness } = await import("../src/lib/voice/entitlement");
const { verifyStreamToken } = await import("../src/lib/auth");
const { greetingClip, voiceParams } = await import("../src/lib/voice/session");
const { toSpoken } = await import("../src/lib/voice/spoken");
const { greetingFor } = await import("../src/lib/agent/runtime");
const { listLocations } = await import("../src/lib/store");
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

console.log("\nThe venue exists and is callable\n");

test("Belline is seeded as a venue of its own", () => {
  assert.ok(belline, "no Belline venue — the bell would open a dead call");
  assert.equal(belline.requiresEmail, true);
});

test("it sells exactly one thing: a demo call", () => {
  const services = belline.salon!.services;
  assert.equal(services.length, 1, "more than one service muddies a 20-minute demo");
  assert.equal(services[0].durationMin, 20);
  assert.equal(services[0].price, 0, "the demo call is not for sale");
});

test("there is one Zoom line, so two demos cannot share a slot", () => {
  assert.equal(belline.salon!.resources.length, 1);
});

test("it answers wider than office hours, because prospects are everywhere", () => {
  const days = Object.keys(belline.hours).length;
  assert.ok(days >= 6, `only open ${days} days`);
});

console.log("\nWhat it says about us\n");

test("it will not claim Arabic, which is not live", () => {
  const arabic = belline.agent.faqs.find((f) => /arabic/i.test(f.q))!;
  assert.ok(arabic, "no answer prepared for the Arabic question");
  assert.match(arabic.a, /not yet|will not pretend/i, `got: ${arabic.a}`);
});

test("it will not claim live call transfer, which is not live", () => {
  const transfer = belline.agent.faqs.find((f) => /transfer/i.test(f.q))!;
  assert.ok(transfer, "no answer prepared for the transfer question");
  assert.match(transfer.a, /not as a live transfer|not yet/i, `got: ${transfer.a}`);
});

test("it quotes the real prices and no others", () => {
  const price = belline.agent.faqs.find((f) => /cost/i.test(f.q))!.a;
  for (const said of ["seventy-nine", "sixty-five", "ninety-nine"]) {
    assert.ok(price.includes(said), `the price answer is missing "${said}"`);
  }
});

test("its policies forbid overstating the product", () => {
  const policies = belline.agent.policies.join(" ");
  assert.match(policies, /Never overstate/i);
  assert.match(policies, /card details|payment/i, "nothing stops it asking for a card");
});

console.log("\nThe greeting is actually warm\n");

test("the warm-up asks for the same clip the call will ask for", () => {
  // This was silently false for every call ever made through a browser. The
  // clip cache is keyed on the text and the speed; the warm-up cached the raw
  // greeting at the configured pace, while `say` asks for the toSpoken
  // rewrite at a pace derived from it. Nothing ever hit, the greeting was
  // re-rendered every time, and the boot log said "warmed" regardless.
  const greeting = greetingFor(belline);
  const warmed = greetingClip(belline, greeting, "pcm_16000");
  const asked = voiceParams(belline, toSpoken(greeting), "pcm_16000");
  assert.deepEqual(warmed, asked, "the warm-up and the call disagree about the clip");
});

test("it is warmed in the format the browser uses, not just the phone's", () => {
  // Warming only ulaw_8000 left the bell on the website — the call most
  // likely to be somebody's first impression — paying full latency.
  const greeting = greetingFor(belline);
  assert.notEqual(
    greetingClip(belline, greeting, "pcm_16000").format,
    greetingClip(belline, greeting, "ulaw_8000").format,
  );
  for (const format of ["pcm_16000", "ulaw_8000"] as const) {
    assert.equal(greetingClip(belline, greeting, format).format, format);
  }
});

test("Belline's own venue is one the warm-up walks", () => {
  // Marking it internal dropped it out of listLocations(), and with it out of
  // the boot warm-up — the one venue most likely to take the first call.
  const warmed = listLocations({ includeInternal: true }).filter((l) => l.demo?.enabled);
  assert.ok(
    warmed.some((l) => l.id === BELLINE_LOCATION_ID),
    "the venue behind the bell is never warmed",
  );
});

console.log("\nWho a signed token may call\n");

test("Belline's own line accepts a token — the bell depends on it", () => {
  // This is the bug the website shipped with: the guard demanded a *prospect*
  // venue, so the bell opened a call that answered 403 and said "connection
  // failed" with nothing in any log to explain it.
  assert.equal(mayStreamTo(getLocation(BELLINE_LOCATION_ID)), true);
});

test("a customer's venue never does, whatever the token says", () => {
  // The whole point of the guard. A leaked token must not become free calls
  // on a customer's bill, or a stranger reading their diary aloud.
  for (const id of ["loc_azure", "loc_lumiere", "loc_meridian"]) {
    const venue = getLocation(id)!;
    if (venue.demo?.enabled && !venue.prospect && !venue.internal) {
      assert.equal(mayStreamTo(venue), false, `${venue.name} is reachable by token`);
    }
  }
});

test("an uncapped venue is refused, however much it is ours", () => {
  // demo.enabled is what checkDemoGate caps on. Without it a public line
  // spends real money with three vendors for as long as anybody leaves it
  // open, so "ours" alone is not enough to let a stranger dial it.
  const belline = getLocation(BELLINE_LOCATION_ID)!;
  const { demo: _cap, ...uncapped } = belline;
  assert.equal(mayStreamTo(uncapped as never), false, "an uncapped line was dialable");
});

test("Belline's own bookings are not wiped nightly like a demo line's", () => {
  // Every other demo venue clears its bookings daily so the diary stays
  // legible. Here a booking is a sales lead with somebody's email on it.
  assert.equal(getLocation(BELLINE_LOCATION_ID)!.demo!.clearBookingsDaily, false);
});

test("a missing venue is refused rather than crashing the handshake", () => {
  assert.equal(mayStreamTo(undefined), false);
});

console.log("\nThe heartbeat keeps calls up, not down\n");

/** The parts of a websocket the heartbeat touches. */
function fakeSocket(answersPings: boolean) {
  const s = {
    isAlive: undefined as boolean | undefined,
    pings: 0,
    sent: [] as string[],
    readyState: 1,
    terminated: false,
    handlers: [] as (() => void)[],
    on(_e: "pong", fn: () => void) {
      s.handlers.push(fn);
      return s;
    },
    send(data: string) {
      s.sent.push(data);
    },
    ping() {
      s.pings++;
      // A live browser answers immediately; a sleeping laptop never does.
      if (answersPings) s.handlers.forEach((h) => h());
    },
    terminate() {
      s.terminated = true;
    },
  };
  return s;
}

test("a watched socket survives sweep after sweep", () => {
  // The regression that mattered: every call died at about fifty seconds
  // because the pong listener was registered on an event that never fires,
  // so the second sweep terminated a perfectly healthy connection.
  const ws = fakeSocket(true);
  watchLiveness(ws);
  for (let i = 0; i < 20; i++) sweepLiveness([ws]);
  assert.equal(ws.terminated, false, `terminated after ${ws.pings} pings`);
  assert.equal(ws.pings, 20, "the socket was not actually being pinged");
});

test("a socket nobody watched is killed on the second sweep", () => {
  // Exactly the bug, pinned. If watchLiveness is ever skipped at an upgrade
  // site again, this is what happens to the call.
  const ws = fakeSocket(true);
  sweepLiveness([ws]);
  assert.equal(ws.terminated, false, "killed on the very first sweep");
  sweepLiveness([ws]);
  assert.equal(ws.terminated, true);
});

test("each sweep sends an application frame, not just a protocol ping", () => {
  // Measured in production: the server pinged four times, the client answered
  // every one, and the proxy still killed the connection at 96.9s with code
  // 1006 because no *application* data had crossed since 1.7s. Control frames
  // do not reset a proxy's idle timer. This one does.
  const ws = fakeSocket(true);
  watchLiveness(ws);
  sweepLiveness([ws]);
  sweepLiveness([ws]);
  assert.equal(ws.sent.length, 2, "the line was pinged but nothing was sent");
  assert.equal(JSON.parse(ws.sent[0]).type, "keepalive");
});

test("nothing is sent to a socket that is already closing", () => {
  const ws = fakeSocket(true);
  watchLiveness(ws);
  ws.readyState = 2; // CLOSING
  sweepLiveness([ws]);
  assert.equal(ws.sent.length, 0);
});

test("a socket that stops answering is dropped", () => {
  // The other half of the point: a closed laptop must not hold a voice
  // session and three vendor connections open forever.
  const ws = fakeSocket(false);
  watchLiveness(ws);
  sweepLiveness([ws]);
  assert.equal(ws.terminated, false);
  sweepLiveness([ws]);
  assert.equal(ws.terminated, true);
});

console.log("\nBooking a demo\n");

const tools = toolsFor(belline);
const bookTool = tools.find((t) => t.name === "book")!;

test("the book tool asks for an email here, and does not on a restaurant", () => {
  const required = (bookTool.input_schema as { required: string[] }).required;
  assert.ok(required.includes("guest_email"), "email is not required on Belline's own line");

  const restaurant = getLocation("loc_azure")!;
  const theirs = toolsFor(restaurant).find((t) => t.name === "book")!;
  const theirRequired = (theirs.input_schema as { required: string[] }).required;
  assert.ok(
    !theirRequired.includes("guest_email"),
    "a restaurant is now asking diners to spell out an email",
  );
});

/**
 * The next slot the diary actually offers — from tomorrow.
 *
 * Today's first slot is offered by the diary but refused by the booking tool
 * as "past" once the morning is under way, which made this suite fail after
 * about nine o'clock Dubai time and pass before it. Tomorrow has no such hour.
 */
function nextSlot() {
  const today = todayIn(belline.timezone);
  for (let i = 1; i < 15; i++) {
    const date = new Date(`${today}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + i);
    const day = date.toISOString().slice(0, 10);
    const slots = findAvailability(belline, {
      locationId: belline.id,
      date: day,
      serviceIds: ["demo_call"],
    });
    if (slots.length > 0) return { date: day, startMin: slots[0].startMin };
  }
  throw new Error("the diary offers nothing in the next fortnight");
}

const slot = nextSlot();

function book(over: Record<string, unknown> = {}) {
  const call = startCall(belline, "browser", "browser-console");
  return executeTool(
    "book",
    {
      date: slot.date,
      time: `${String(Math.floor(slot.startMin / 60)).padStart(2, "0")}:${String(slot.startMin % 60).padStart(2, "0")}`,
      guest_name: "Andreas",
      guest_phone: "+971501234567",
      guest_email: "andreas@gmail.com",
      service_ids: ["demo_call"],
      ...over,
    },
    { location: belline, call, callerNumber: "+971501234567" } as never,
  );
}

test("a demo call can actually be booked", async () => {
  const out = (await book()) as { result: Record<string, unknown> };
  assert.equal(out.result.booked, true, JSON.stringify(out.result));
});

test("the email is stored on the booking", () => {
  const booked = listBookings({ locationId: belline.id }).find((b) => b.guestEmail);
  assert.ok(booked, "the booking kept no email — there is nowhere to send the link");
  assert.equal(booked!.guestEmail, "andreas@gmail.com");
});

test("a mistyped domain is queried rather than booked", async () => {
  const out = (await book({ guest_email: "andreas@gmial.com" })) as {
    result: Record<string, unknown>;
  };
  assert.equal(out.result.booked, false, "a typosquatted domain was accepted silently");
  assert.equal(out.result.reason, "email_uncertain");
  assert.equal(out.result.likely, "andreas@gmail.com");
});

test("and goes through once the caller confirms it", async () => {
  const out = (await book({
    guest_email: "andreas@gmial.com",
    email_confirmed: true,
    guest_name: "Andreas Two",
  })) as { result: Record<string, unknown> };
  assert.notEqual(
    out.result.reason,
    "email_uncertain",
    "confirming their own address still would not book",
  );
});

test("a mangled address asks them to say it again rather than failing", async () => {
  const out = (await book({ guest_email: "andreas at gmail" })) as {
    result: Record<string, unknown>;
  };
  assert.equal(out.result.booked, false);
  assert.equal(out.result.reason, "email_unclear");
  assert.match(String(out.result.say), /say it again|spell/i);
});

console.log("\nThe dialled number reaches the venue that owns it\n");

/**
 * Ring a number and see which venue picks up.
 *
 * Straight at the webhook, because the bug this is here for lived in the
 * lookup rather than in the engine: our own number is on an *internal* venue,
 * the webhook listed venues the way the dashboard does — which hides internal
 * ones — and so the number could never match the venue holding it. The call
 * fell through to whichever customer sorted first and was answered as their
 * restaurant. `TWILIO_AUTH_TOKEN` is unset here, so the handler takes the
 * request unsigned, as it does in development.
 */
async function dial(to: string): Promise<string | null> {
  const { POST } = await import("../src/app/api/twilio/voice/route");
  const response = await POST(
    new Request("https://app.belline.ai/api/twilio/voice", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: to, From: "+15551230000", CallSid: "CAtest" }).toString(),
    }),
  );
  const xml = await response.text();
  const token = xml.match(/name="token" value="([^"]+)"/)?.[1];
  return token ? verifyStreamToken(token) : null;
}

test("Belline's own number reaches Belline, not the first customer", async () => {
  const belline = getLocation(BELLINE_LOCATION_ID)!;
  const answered = await dial(belline.phone);
  assert.equal(
    answered,
    BELLINE_LOCATION_ID,
    "our own number was answered by somebody else's venue",
  );
});

test("a customer's own number still reaches them", async () => {
  const customer = listLocations()[0];
  assert.ok(customer, "no customer venue to test against");
  assert.equal(await dial(customer.phone), customer.id);
});

test("a number nobody owns is refused rather than given to whoever sorts first", async () => {
  const answered = await dial("+1 999 000 1234");
  assert.equal(
    answered,
    null,
    "an unrecognised number was connected to a venue, spending their minutes",
  );
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

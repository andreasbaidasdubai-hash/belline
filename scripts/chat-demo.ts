/**
 * Belline answering the chat on a venue's website, without a browser.
 *
 *   npm run chat:demo
 *
 * The pipeline is the real one: the same `acceptInbound`, the same dedup, the
 * same conversation state, the same agent, the same booking engine, the same
 * diary, the same honesty check. What is missing is only the HTTP round trip
 * and the panel it would render in.
 *
 * Worth running by hand rather than only in the test suite, because the unit
 * tests can only pin what we already know to be true. Driving the real model
 * through a real conversation is what caught Belline inventing appointment
 * times on WhatsApp — a failure no assertion would have been written for.
 *
 * Needs DATABASE_URL and ANTHROPIC_API_KEY.
 */

import { isConfigured } from "../src/lib/db/client";

if (!isConfigured()) {
  console.error("\n  DATABASE_URL is not set. Reception needs Postgres.\n");
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    "\n  ANTHROPIC_API_KEY is not set, so Belline would answer with its keyless stub.\n" +
      "  That would demonstrate the plumbing and nothing about the product.\n",
  );
  process.exit(1);
}

const { migrateReception } = await import("../src/lib/reception/migrate");
const { query, close } = await import("../src/lib/db/client");
const repo = await import("../src/lib/reception/repo");
const { acceptInbound } = await import("../src/lib/reception/inbound");
const { respondTo } = await import("../src/lib/reception/respond");
const { seedIfEmpty } = await import("../src/lib/seed");
const storeModule = await import("../src/lib/store");
const { getLocation, listBookings } = storeModule;
const { describeBooking } = await import("../src/lib/booking");
const { enableEmbed } = await import("../src/lib/embed");
const { ensureWebchatAccount, newVisitorId, visitorHandle, chatGate } = await import(
  "../src/lib/webchat"
);

await migrateReception();
seedIfEmpty();

const keep = process.argv.includes("--keep");

const VENUE = "loc_lumiere";
let venue = getLocation(VENUE);
if (!venue) {
  console.error(`\n  No venue ${VENUE}. Run the seed first.\n`);
  process.exit(1);
}

// The venue has the widget switched on, with the chat among what it offers.
// Done here rather than assumed: the demo should fail loudly if the entitlement
// stops working, not quietly answer anyway.
venue = enableEmbed(venue, ["https://lumiere.ae"], undefined, "both");

const gate = chatGate(venue);
if (!gate.allowed) {
  console.error(`\n  The chat is not open: ${gate.message ?? "no reason given"}\n`);
  process.exit(1);
}

await query("delete from message where tenant_id = $1", [venue.tenantId]);
await query("delete from conversation where tenant_id = $1", [venue.tenantId]);

const account = await ensureWebchatAccount(venue);
const visitorId = newVisitorId();
const handle = visitorHandle(visitorId);

// Somebody on a train, who will not talk out loud. The whole reason this
// channel exists.
const SCRIPT = [
  "hi, how much is a root colour?",
  "do you have anything tomorrow morning?",
  "the first one please",
  "Andreas, and I've had colour with you before so no patch test needed",
];

console.log(`\n\x1b[1m${venue.name}\x1b[0m — website chat, ${handle}\n`);
console.log(`\x1b[2m${"─".repeat(64)}\x1b[0m\n`);

let sent = 0;
let shownTools = 0;
const started = Date.now();

function conversationCall() {
  return storeModule
    .listCalls(venue!.id)
    .find((c) => c.channel === "webchat" && c.status === "active");
}

for (const [i, text] of SCRIPT.entries()) {
  console.log(`\x1b[2mVisitor\x1b[0m\n  ${text}\n`);

  const accepted = await acceptInbound(
    {
      channel: "webchat",
      provider: "webchat",
      providerMessageId: `demo_${started}_${i}`,
      fromE164: handle,
      content: { type: "text", text },
      timestamp: new Date().toISOString(),
      raw: {},
    },
    account,
  );

  if (!accepted.ok) {
    console.error(`  ✗ ${accepted.rejected.reason}: ${accepted.rejected.detail}`);
    break;
  }

  const turn = Date.now();
  const outcome = await respondTo(accepted.accepted);
  const ms = Date.now() - turn;

  const call = conversationCall();
  const fresh = call ? call.toolCalls.slice(shownTools) : [];
  shownTools += fresh.length;
  for (const t of fresh) {
    const input = JSON.stringify(t.input);
    const out =
      typeof t.output === "object" && t.output
        ? JSON.stringify(t.output).slice(0, 120)
        : String(t.output);
    console.log(
      `\x1b[2m  → ${t.name}(${input.slice(0, 90)})\n    ${t.ok ? "" : "FAILED "}${out}\x1b[0m\n`,
    );
  }

  if (outcome.sent) {
    console.log(`\x1b[33mBelline\x1b[0m \x1b[2m(${(ms / 1000).toFixed(1)}s)\x1b[0m`);
    console.log(`  ${outcome.text.replace(/\n/g, "\n  ")}\n`);
    sent++;
  } else if ("skipped" in outcome) {
    console.log(`\x1b[2m— Belline said nothing: ${outcome.skipped}\x1b[0m\n`);
  } else {
    console.log(`\x1b[31m— failed: ${outcome.failed}\x1b[0m\n`);
  }
}

// The double-click a real panel would send. It must change nothing.
const retry = await acceptInbound(
  {
    channel: "webchat",
    provider: "webchat",
    providerMessageId: `demo_${started}_0`,
    fromE164: handle,
    content: { type: "text", text: SCRIPT[0] },
    timestamp: new Date().toISOString(),
    raw: {},
  },
  account,
);

console.log(`\x1b[2m${"─".repeat(64)}\x1b[0m\n`);

const conversation = (await repo.listConversations(venue.tenantId))[0];
const messages = conversation ? await repo.listMessages(venue.tenantId, conversation.id) : [];

console.log(`  Belline replied            ${sent} times`);
console.log(`  Messages recorded          ${messages.length}`);
console.log(
  `  A resent message           ${
    retry.ok && !retry.accepted.fresh ? "\x1b[32mignored\x1b[0m" : "\x1b[31mstored again\x1b[0m"
  }`,
);
console.log(`  Conversation is            ${conversation?.status}`);
console.log(`  Channel                    ${conversation?.channel}`);

const booking = conversation?.bookingId
  ? listBookings({ locationId: venue.id }).find((b) => b.id === conversation.bookingId)
  : undefined;

if (booking) {
  console.log(`\n  \x1b[32mBooked into the real diary\x1b[0m`);
  console.log(`    ${describeBooking(venue, booking)}`);
  console.log(`    reference ${booking.ref}, source ${booking.source}`);
} else {
  console.log(`\n  \x1b[2mNo booking was made.\x1b[0m`);
}

if (conversation?.callId) {
  console.log(`\n  The venue's own record     ${conversation.callId}`);
  console.log(`    beside every telephone call, on the same dashboard.`);
}

if (keep) {
  console.log("\n  Left in place — open /inbox to see it.\n");
  await close();
  process.exit(0);
}

await query("delete from message where tenant_id = $1", [venue.tenantId]);
await query("delete from conversation where tenant_id = $1", [venue.tenantId]);
await query("delete from customer where tenant_id = $1 and phone_e164 = $2", [
  venue.tenantId,
  handle,
]);
await query("delete from event where tenant_id = $1", [venue.tenantId]);
await close();
process.exit(0);

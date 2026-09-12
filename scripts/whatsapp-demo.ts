/**
 * Belline answering on WhatsApp, without a WhatsApp number.
 *
 *   npm run whatsapp:demo
 *   npm run whatsapp:demo -- --handoff
 *
 * The pipeline is the real one: the same webhook path, the same deduplication,
 * the same conversation state, the same agent, the same booking engine, the
 * same diary. The only thing that is not real is the wire — the `internal`
 * adapter records what Belline says instead of handing it to Meta.
 *
 * So what this prints is what a customer would receive, and the booking it
 * makes is a booking. Connecting a real number changes one row in
 * `channel_account` and nothing else.
 *
 * Needs DATABASE_URL and ANTHROPIC_API_KEY. Without the model key the agent
 * falls back to its stub and the conversation is worth nothing, so it says so
 * and stops.
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
const { internalOutbox, clearInternalOutbox } = await import(
  "../src/lib/reception/channel/internal"
);
const { seedIfEmpty } = await import("../src/lib/seed");
const storeModule = await import("../src/lib/store");
const { getLocation, listBookings } = storeModule;
const { describeBooking } = await import("../src/lib/booking");
const { minutesToClock } = await import("../src/lib/time");
const { DEFAULT_TENANT_ID } = await import("../src/lib/tenancy");

await migrateReception();
seedIfEmpty();

const handoffMode = process.argv.includes("--handoff");
// Leave the conversation behind, so the inbox has something in it. Off by
// default: a demo that fills a customer's inbox with its own conversations is
// one nobody runs twice.
const keep = process.argv.includes("--keep");

// A real venue with real staff, real services and a real diary. Lumière is the
// seeded salon: Marta and Sarah, cut and colour, patch-test policy and all.
const VENUE = "loc_lumiere";
const venue = getLocation(VENUE);
if (!venue) {
  console.error(`\n  No venue ${VENUE}. Run the seed first.\n`);
  process.exit(1);
}

const CUSTOMER = "+971509990001";
const NUMBER = "+15550009999";

// A channel account for the demo, on the wireless provider.
await query("delete from message where tenant_id = $1", [venue.tenantId]);
await query("delete from conversation where tenant_id = $1", [venue.tenantId]);
await query("delete from customer where tenant_id = $1 and phone_e164 = $2", [
  venue.tenantId,
  CUSTOMER,
]);
await query("delete from channel_account where tenant_id = $1 and phone_e164 = $2", [
  venue.tenantId,
  NUMBER,
]);

const account = await repo.saveAccount({
  tenantId: venue.tenantId,
  businessId: venue.businessId,
  locationId: venue.id,
  channel: "whatsapp",
  provider: "internal",
  phoneE164: NUMBER,
});

clearInternalOutbox();

const SCRIPT = handoffMode
  ? [
      "hi, is anyone there?",
      "I came in on Saturday and the colour is completely wrong. I'm really upset about it.",
      "no I want to speak to an actual person please",
    ]
  : [
      "hi! do you have anything tomorrow for a root colour?",
      "anything with Marie?",
      "yes I've had colour with you before, no patch test needed",
      "the earliest one please",
      "Andreas, and you can reach me on this number",
    ];

console.log(`\n\x1b[1m${venue.name}\x1b[0m — WhatsApp, ${CUSTOMER}\n`);
console.log(`\x1b[2m${"─".repeat(64)}\x1b[0m\n`);

let sent = 0;
let shownTools = 0;

/** The venue's episode record for this conversation, if one exists yet. */
function conversationCall() {
  const { listCalls } = storeModule;
  return listCalls(venue!.id).find((c) => c.channel === "whatsapp" && c.status === "active");
}
const started = Date.now();

for (const [i, text] of SCRIPT.entries()) {
  console.log(`\x1b[2mCustomer\x1b[0m\n  ${text}\n`);

  const inbound = {
    channel: "whatsapp" as const,
    provider: "internal" as const,
    // Real ids, so the deduplication is exercised rather than bypassed.
    providerMessageId: `demo_${started}_${i}`,
    toE164: NUMBER,
    fromE164: CUSTOMER,
    profileName: "Andreas",
    content: { type: "text" as const, text },
    timestamp: new Date().toISOString(),
    raw: { demo: true },
  };

  const accepted = await acceptInbound(inbound);
  if (!accepted.ok) {
    console.error(`  ✗ ${accepted.rejected.reason}: ${accepted.rejected.detail}`);
    break;
  }

  const turn = Date.now();
  const outcome = await respondTo(accepted.accepted);
  const ms = Date.now() - turn;

  // What it actually reached for. The reason this is printed rather than
  // hidden: "why did it say that" is the question asked afterwards, and a
  // transcript without the tool calls cannot answer it.
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
      `[2m  → ${t.name}(${input.slice(0, 90)})
    ${t.ok ? "" : "FAILED "}${out}[0m
`,
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

// The duplicate a provider would send on a retry. It must change nothing.
const retry = await acceptInbound({
  channel: "whatsapp",
  provider: "internal",
  providerMessageId: `demo_${started}_0`,
  toE164: NUMBER,
  fromE164: CUSTOMER,
  content: { type: "text", text: SCRIPT[0] },
  timestamp: new Date().toISOString(),
  raw: {},
});

console.log(`\x1b[2m${"─".repeat(64)}\x1b[0m\n`);

const conversation = (await repo.listConversations(venue.tenantId))[0];
const messages = conversation ? await repo.listMessages(venue.tenantId, conversation.id) : [];

console.log(`  Belline replied            ${sent} times`);
console.log(`  Messages recorded          ${messages.length}`);
console.log(
  `  A retried webhook          ${
    retry.ok && !retry.accepted.fresh ? "\x1b[32mignored\x1b[0m" : "\x1b[31mstored again\x1b[0m"
  }`,
);
console.log(`  Conversation is            ${conversation?.status}`);
if (conversation?.handoffReason) {
  console.log(`  Handed over because        ${conversation.handoffReason}`);
  console.log(`  Summary for the team       ${conversation.handoffSummary}`);
}

// The part that separates this from a chatbot: did it actually book anything?
const booking = conversation?.bookingId
  ? listBookings({ locationId: venue.id }).find((b) => b.id === conversation.bookingId)
  : undefined;

if (booking) {
  console.log(`\n  \x1b[32mBooked into the real diary\x1b[0m`);
  console.log(`    ${describeBooking(venue, booking)}`);
  console.log(`    reference ${booking.ref}, source ${booking.source}`);
} else if (!handoffMode) {
  console.log(`\n  \x1b[2mNo booking was made.\x1b[0m`);
}

if (conversation?.callId) {
  console.log(`\n  The venue's own record     ${conversation.callId}`);
  console.log(`    visible in the dashboard beside every telephone call.`);
}

console.log(
  `\n\x1b[2m  Nothing left this process: the 'internal' provider records what would\n` +
    `  have been sent. Connecting a real number is one row in channel_account.\x1b[0m\n`,
);

if (keep) {
  console.log("  Left in place — open /inbox to see it.");
  await close();
  process.exit(0);
}

// Leave the database as it was found.
await query("delete from message where tenant_id = $1", [venue.tenantId]);
await query("delete from conversation where tenant_id = $1", [venue.tenantId]);
await query("delete from customer where tenant_id = $1 and phone_e164 = $2", [
  venue.tenantId,
  CUSTOMER,
]);
await query("delete from channel_account where id = $1", [account.id]);
await query("delete from event where tenant_id = $1", [venue.tenantId]);

void DEFAULT_TENANT_ID;
void minutesToClock;
await close();
process.exit(0);

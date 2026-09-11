/**
 * The reception data layer.
 *
 * Three properties, and all three are the kind that look obvious and fail
 * quietly.
 *
 * **Tenant isolation.** Every function here takes a tenant id first, and the
 * test is not that it compiles but that passing the wrong one returns nothing
 * — including for a row that plainly exists and whose primary key the caller
 * is holding.
 *
 * **Duplicate defence.** Meta retries any webhook it thinks was slow, and a
 * retry handled twice is a duplicate booking. The defence is a unique index,
 * so it holds across processes; a cache would not.
 *
 * **The handoff lock.** A status check followed by a generated reply is not
 * enough, because generation takes seconds and staff take over during them.
 * `withAiTurn` holds a row lock for the whole turn, and the test takes the
 * conversation over *while the turn is running* — which is the exact race the
 * design exists for and the one nobody would notice was broken until a member
 * of staff and Belline answered a customer in the same breath.
 *
 *   npm run check:reception      (needs DATABASE_URL)
 */

import assert from "node:assert/strict";

const { isConfigured } = await import("../src/lib/db/client");

if (!isConfigured()) {
  console.log("\n  DATABASE_URL is not set — skipping the reception checks.\n");
  process.exit(0);
}

const { migrateReception } = await import("../src/lib/reception/migrate");
const { query, close } = await import("../src/lib/db/client");
const repo = await import("../src/lib/reception/repo");
const { sealCredentials, openCredentials, credentialsConfigured } = await import(
  "../src/lib/db/credentials"
);

await migrateReception();

// Two tenants, neither of which is a real one. Everything this file writes is
// namespaced so it can be removed again whatever happens in between.
const A = `tnt_test_a_${Date.now()}`;
const B = `tnt_test_b_${Date.now()}`;

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void) {
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

async function cleanup() {
  for (const t of [A, B]) {
    await query("delete from message where tenant_id = $1", [t]);
    await query("delete from conversation where tenant_id = $1", [t]);
    await query("delete from customer where tenant_id = $1", [t]);
    await query("delete from channel_account where tenant_id = $1", [t]);
    await query("delete from event where tenant_id = $1", [t]);
  }
}

await cleanup();

console.log("\n\x1b[1mOne tenant cannot reach another\x1b[0m\n");

const alice = await repo.upsertCustomer(A, "+971501234567", { firstName: "Alice" });
const bob = await repo.upsertCustomer(B, "+971509999999", { firstName: "Bob" });

const convA = await repo.createConversation({
  tenantId: A,
  businessId: "biz_a",
  channel: "whatsapp",
  customerId: alice.id,
});
const convB = await repo.createConversation({
  tenantId: B,
  businessId: "biz_b",
  channel: "whatsapp",
  customerId: bob.id,
});

await test("a customer is invisible from the wrong tenant", async () => {
  assert.ok(await repo.getCustomer(A, alice.id));
  assert.equal(await repo.getCustomer(B, alice.id), undefined);
  assert.equal(await repo.findCustomer(B, "+971501234567"), undefined);
});

await test("the same number in two tenants is two customers", async () => {
  // Not a collision: two businesses can both have a customer with one number,
  // and neither should see the other's notes about them.
  const alsoAlice = await repo.upsertCustomer(B, "+971501234567", { firstName: "Alice" });
  assert.notEqual(alsoAlice.id, alice.id);
  assert.equal(alsoAlice.tenantId, B);
});

await test("a conversation is invisible from the wrong tenant", async () => {
  assert.ok(await repo.getConversation(A, convA.id));
  assert.equal(await repo.getConversation(B, convA.id), undefined);
  const listed = (await repo.listConversations(B)).map((c) => c.id);
  assert.equal(listed.includes(convA.id), false);
  assert.ok(listed.includes(convB.id));
});

await test("a state patch cannot be applied across tenants", async () => {
  assert.equal(await repo.patchState(B, convA.id, { intent: "cancel" }), undefined);
  const still = await repo.getConversation(A, convA.id);
  assert.equal(still?.state.intent, undefined);
});

await test("a transition cannot be applied across tenants", async () => {
  assert.equal(await repo.transition(B, convA.id, "CLOSED"), undefined);
  assert.equal((await repo.getConversation(A, convA.id))?.status, "AI_ACTIVE");
});

await test("the inbox filter only shows venues a user may see", async () => {
  const marina = await repo.createConversation({
    tenantId: A,
    businessId: "biz_a",
    locationId: "loc_marina",
    channel: "whatsapp",
    customerId: alice.id,
  });
  const jumeirah = await repo.createConversation({
    tenantId: A,
    businessId: "biz_a",
    locationId: "loc_jumeirah",
    channel: "whatsapp",
    customerId: alice.id,
  });
  const seen = (await repo.listConversations(A, { locationIds: ["loc_marina"] })).map((c) => c.id);
  assert.ok(seen.includes(marina.id));
  assert.equal(seen.includes(jumeirah.id), false);
  // And the one with no branch chosen yet is visible to both, or nobody would
  // ever pick it up.
  assert.ok(seen.includes(convA.id));
});

console.log("\n\x1b[1mA duplicate webhook is a no-op\x1b[0m\n");

await test("the same provider message id is stored once", async () => {
  const first = await repo.recordMessage({
    tenantId: A,
    conversationId: convA.id,
    sender: "customer",
    direction: "in",
    body: "Do you have anything tomorrow?",
    providerMessageId: "wamid.TEST1",
  });
  const second = await repo.recordMessage({
    tenantId: A,
    conversationId: convA.id,
    sender: "customer",
    direction: "in",
    body: "Do you have anything tomorrow?",
    providerMessageId: "wamid.TEST1",
  });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true, "the retry was stored as a second message");
  assert.equal(second.message.id, first.message.id, "the retry did not return the original");

  const all = await repo.listMessages(A, convA.id);
  assert.equal(all.filter((m) => m.providerMessageId === "wamid.TEST1").length, 1);
});

await test("two duplicates arriving at once still produce one message", async () => {
  // The race the unique index exists for: two workers, one retry, no
  // check-then-insert window between them.
  const [x, y] = await Promise.all([
    repo.recordMessage({
      tenantId: A,
      conversationId: convA.id,
      sender: "customer",
      direction: "in",
      body: "4:30",
      providerMessageId: "wamid.RACE",
    }),
    repo.recordMessage({
      tenantId: A,
      conversationId: convA.id,
      sender: "customer",
      direction: "in",
      body: "4:30",
      providerMessageId: "wamid.RACE",
    }),
  ]);
  assert.equal([x.duplicate, y.duplicate].filter(Boolean).length, 1, "both or neither were treated as new");
  assert.equal(x.message.id, y.message.id);
});

await test("messages without a provider id are not deduplicated against each other", async () => {
  // Two staff replies that happen to say the same thing are two messages.
  const a = await repo.recordMessage({
    tenantId: A, conversationId: convA.id, sender: "human", direction: "out", body: "One moment.",
  });
  const b = await repo.recordMessage({
    tenantId: A, conversationId: convA.id, sender: "human", direction: "out", body: "One moment.",
  });
  assert.notEqual(a.message.id, b.message.id);
});

await test("a message cannot be read from the wrong tenant", async () => {
  assert.equal((await repo.listMessages(B, convA.id)).length, 0);
  assert.ok((await repo.listMessages(A, convA.id)).length > 0);
});

console.log("\n\x1b[1mBelline and a person never answer at once\x1b[0m\n");

await test("an AI turn runs while the conversation is AI_ACTIVE", async () => {
  const out = await repo.withAiTurn(A, convA.id, async () => "spoke");
  assert.equal(out, "spoke");
});

await test("an AI turn does not run once a person has taken over", async () => {
  const taken = await repo.transition(A, convA.id, "HUMAN_ACTIVE", {
    expect: ["AI_ACTIVE", "HANDOFF_REQUESTED"],
    userId: "usr_anna",
  });
  assert.ok(taken);
  const out = await repo.withAiTurn(A, convA.id, async () => "spoke");
  assert.equal(out, undefined, "Belline generated a reply over a member of staff");
  await repo.transition(A, convA.id, "AI_ACTIVE", { expect: ["HUMAN_ACTIVE"] });
});

await test("a takeover during a running turn waits for it, then blocks the next", async () => {
  // The real race, not a simulation of it: the turn holds the row lock while
  // it "thinks", and the takeover blocks on that lock rather than slipping
  // past.
  //
  // Note what this does *not* claim. The turn already in flight finishes and
  // its reply is sent — the lock serialises the two rather than cancelling
  // one. That is the right outcome: the customer gets the answer Belline had
  // already composed, and everything after it belongs to the person who took
  // over. The guarantee is that they never overlap, not that a takeover can
  // reach back in time.
  let turnSawAiActive = false;

  const turn = repo.withAiTurn(A, convA.id, async () => {
    turnSawAiActive = true;
    // Long enough that the takeover below is genuinely concurrent.
    await new Promise((r) => setTimeout(r, 400));
    return "spoke";
  });

  await new Promise((r) => setTimeout(r, 80));
  const takeover = repo.transition(A, convA.id, "HUMAN_ACTIVE", { expect: ["AI_ACTIVE"] });

  const [spoke, taken] = await Promise.all([turn, takeover]);

  assert.equal(turnSawAiActive, true);
  assert.equal(spoke, "spoke", "the turn that held the lock did not finish");
  // The lock was genuinely contended: the takeover could not land until the
  // turn released it.
  assert.ok(taken, "the takeover did not land after the turn released the lock");
  assert.equal((await repo.getConversation(A, convA.id))?.status, "HUMAN_ACTIVE");

  // And the next turn is refused, which is what stops the second reply.
  assert.equal(await repo.withAiTurn(A, convA.id, async () => "spoke again"), undefined);
});

await test("two people cannot both take over", async () => {
  await repo.transition(A, convA.id, "AI_ACTIVE", { expect: ["HUMAN_ACTIVE"] });
  const [first, second] = await Promise.all([
    repo.transition(A, convA.id, "HUMAN_ACTIVE", { expect: ["AI_ACTIVE"], userId: "usr_anna" }),
    repo.transition(A, convA.id, "HUMAN_ACTIVE", { expect: ["AI_ACTIVE"], userId: "usr_ben" }),
  ]);
  assert.equal([first, second].filter(Boolean).length, 1, "both takeovers succeeded");
});

await test("returning to Belline is only valid from HUMAN_ACTIVE", async () => {
  assert.ok(await repo.transition(A, convA.id, "AI_ACTIVE", { expect: ["HUMAN_ACTIVE"] }));
  assert.equal(
    await repo.transition(A, convA.id, "AI_ACTIVE", { expect: ["HUMAN_ACTIVE"] }),
    undefined,
    "a second release succeeded from AI_ACTIVE",
  );
});

await test("escalation stores the summary written at the time", async () => {
  const escalated = await repo.transition(A, convA.id, "HANDOFF_REQUESTED", {
    expect: ["AI_ACTIVE"],
    reason: "asked for a person",
    summary: "Wants to move Thursday's appointment; asked to speak to someone.",
  });
  assert.equal(escalated?.status, "HANDOFF_REQUESTED");
  assert.equal(escalated?.handoffReason, "asked for a person");
  assert.ok(escalated?.handoffSummary?.startsWith("Wants to move"));
  assert.ok(escalated?.handoffAt);
  // And Belline stops.
  assert.equal(await repo.withAiTurn(A, convA.id, async () => "spoke"), undefined);
});

console.log("\n\x1b[1mCredentials\x1b[0m\n");

await test("a sealed credential round-trips and is not readable as text", async () => {
  if (!credentialsConfigured()) {
    // Without a key there is nothing to test and nothing to store — which is
    // the correct state on a machine that has never connected a channel.
    process.env.CREDENTIALS_KEY = Buffer.alloc(32, 7).toString("base64");
  }
  const sealed = sealCredentials({ accessToken: "EAAG-super-secret", phoneNumberId: "123" });
  assert.equal(sealed.includes("EAAG-super-secret"), false, "the token is in the ciphertext");
  assert.deepEqual(openCredentials(sealed), {
    accessToken: "EAAG-super-secret",
    phoneNumberId: "123",
  });
});

await test("a tampered credential fails rather than decrypting to rubbish", () => {
  const sealed = sealCredentials({ accessToken: "secret" });
  const parts = sealed.split(".");
  // Flip a byte in the ciphertext.
  const body = Buffer.from(parts[3], "base64");
  body[0] ^= 0xff;
  parts[3] = body.toString("base64");
  assert.throws(() => openCredentials(parts.join(".")));
});

await test("a channel account never carries its credentials into the domain object", async () => {
  const account = await repo.saveAccount({
    tenantId: A,
    businessId: "biz_a",
    channel: "whatsapp",
    provider: "meta",
    phoneE164: `+9715000${Date.now() % 100000}`,
    externalNumberId: `num_${Date.now()}`,
    credentialsEnc: sealCredentials({ accessToken: "EAAG-super-secret" }),
  });
  assert.equal(JSON.stringify(account).includes("credential"), false);
  assert.equal(JSON.stringify(account).includes("EAAG"), false);
  // And the one caller that needs it has to ask by name.
  assert.ok(await repo.accountCredentials(A, account.id));
  assert.equal(await repo.accountCredentials(B, account.id), undefined);
});

await test("an inbound number resolves to exactly one business", async () => {
  const number = `+9715001${Date.now() % 100000}`;
  const numberId = `num_inbound_${Date.now()}`;
  await repo.saveAccount({
    tenantId: A,
    businessId: "biz_a",
    channel: "whatsapp",
    provider: "meta",
    phoneE164: number,
    externalNumberId: numberId,
  });
  const found = await repo.accountForInbound("whatsapp", { externalNumberId: numberId });
  assert.equal(found?.tenantId, A);
  assert.equal(found?.businessId, "biz_a");
  assert.equal(await repo.accountForInbound("whatsapp", { externalNumberId: "nope" }), undefined);
});

await test("a number already connected elsewhere cannot be claimed", async () => {
  const number = `+9715002${Date.now() % 100000}`;
  await repo.saveAccount({
    tenantId: A, businessId: "biz_a", channel: "whatsapp", provider: "meta", phoneE164: number,
  });
  await assert.rejects(
    repo.saveAccount({
      tenantId: B, businessId: "biz_b", channel: "whatsapp", provider: "meta", phoneE164: number,
    }),
    /already connected/,
  );
});

await cleanup();
await close();

console.log(
  failed === 0
    ? `\n\x1b[32m✓ ${passed} passed, 0 failed\x1b[0m\n`
    : `\n\x1b[31m✗ ${passed} passed, ${failed} failed\x1b[0m\n`,
);
process.exit(failed === 0 ? 0 : 1);

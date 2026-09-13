/**
 * The WhatsApp channel.
 *
 * Two providers, one endpoint, and the properties that decide whether this is
 * safe to point at a real phone number.
 *
 * **Signatures.** An endpoint that accepts unsigned webhooks is an endpoint
 * anybody can post conversations into — including ones that look like a
 * customer asking to cancel somebody else's booking. Both schemes are checked
 * against real fixtures, and the unconfigured case refuses rather than passes.
 *
 * **Parsing.** Meta's envelope is deeply nested and carries several messages,
 * several statuses, and types we do not handle; Twilio's is form-encoded and
 * carries one. Both are pinned against the shapes the providers actually send,
 * because this is the layer that stops anything provider-shaped reaching the
 * rest of Belline.
 *
 * **Duplicates.** Meta retries anything slow. The defence is downstream, but
 * the pipeline has to carry the id faithfully for it to work, so the whole
 * path is exercised: two identical webhooks, one stored message.
 *
 *   npm run check:whatsapp      (the pipeline half needs DATABASE_URL)
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";

const { metaAdapter } = await import("../src/lib/reception/channel/meta");
const { twilioAdapter } = await import("../src/lib/reception/channel/twilio");
const { toE164 } = await import("../src/lib/reception/channel");
const { isConfigured } = await import("../src/lib/db/client");

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

// --- fixtures ---------------------------------------------------------------

const APP_SECRET = "test-app-secret";
const VERIFY_TOKEN = "test-verify-token";
const AUTH_TOKEN = "test-twilio-auth-token";

/** A real Meta envelope: one text message and one delivery receipt. */
const metaBody = JSON.stringify({
  object: "whatsapp_business_account",
  entry: [
    {
      id: "102290129340398",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "15550001111", phone_number_id: "106540352242922" },
            contacts: [{ profile: { name: "Andreas" }, wa_id: "971501234567" }],
            messages: [
              {
                from: "971501234567",
                id: "wamid.HBgMOTcxNTAxMjM0NTY3",
                timestamp: "1757600000",
                type: "text",
                text: { body: "Hi, can I get a haircut tomorrow afternoon?" },
              },
            ],
          },
        },
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "15550001111", phone_number_id: "106540352242922" },
            statuses: [
              {
                id: "wamid.OUTBOUND1",
                status: "delivered",
                timestamp: "1757600010",
                recipient_id: "971501234567",
              },
            ],
          },
        },
      ],
    },
  ],
});

function metaSignature(body: string, secret = APP_SECRET): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

const twilioUrl = "https://app.belline.ai/api/whatsapp/webhook";
const twilioBody = new URLSearchParams({
  SmsMessageSid: "SM1234567890abcdef",
  MessageSid: "SM1234567890abcdef",
  AccountSid: "AC0000000000000000",
  From: "whatsapp:+971501234567",
  To: "whatsapp:+14155238886",
  Body: "Anything later?",
  ProfileName: "Andreas",
  NumMedia: "0",
}).toString();

function twilioSignature(url: string, body: string, token = AUTH_TOKEN): string {
  const params = new URLSearchParams(body);
  let payload = url;
  for (const key of [...params.keys()].sort()) payload += key + (params.get(key) ?? "");
  return crypto.createHmac("sha1", token).update(payload, "utf8").digest("base64");
}

const headers = (h: Record<string, string>) => new Headers(h);

// --- numbers ----------------------------------------------------------------

console.log("\n\x1b[1mNumbers\x1b[0m\n");

await test("every provider's decoration is stripped to one E.164 form", () => {
  assert.equal(toE164("whatsapp:+971 50 123 4567"), "+971501234567");
  assert.equal(toE164("971501234567"), "+971501234567");
  assert.equal(toE164("+971501234567"), "+971501234567");
  assert.equal(toE164("+1 (415) 523-8886"), "+14155238886");
});

await test("a national number is not dressed up as an international one", () => {
  // The bug this caught: `0501234567` became `+0501234567`. No country calling
  // code starts with a zero, so that is a customer filed under a number that
  // does not exist — and failing to recognise somebody is recoverable where
  // filing them under somebody else's number is not.
  assert.equal(toE164("0501234567").startsWith("+"), false);
  assert.equal(toE164("00971501234567").startsWith("+"), false);
  assert.equal(toE164("123456").startsWith("+"), false, "too short to be E.164");
  assert.equal(toE164("1234567890123456").startsWith("+"), false, "too long to be E.164");
});

await test("something that is not a number at all never becomes one", () => {
  assert.equal(toE164("not-a-number").startsWith("+"), false);
  assert.equal(toE164("").startsWith("+"), false);
});

// --- Meta -------------------------------------------------------------------

console.log("\n\x1b[1mMeta: the handshake\x1b[0m\n");

await test("the challenge is echoed when the token matches", () => {
  process.env.WHATSAPP_VERIFY_TOKEN = VERIFY_TOKEN;
  const params = new URLSearchParams({
    "hub.mode": "subscribe",
    "hub.verify_token": VERIFY_TOKEN,
    "hub.challenge": "1158201444",
  });
  assert.equal(metaAdapter.verifyChallenge!(params), "1158201444");
});

await test("a wrong token is refused", () => {
  const params = new URLSearchParams({
    "hub.mode": "subscribe",
    "hub.verify_token": "not-the-token",
    "hub.challenge": "1158201444",
  });
  assert.equal(metaAdapter.verifyChallenge!(params), null);
});

await test("an unconfigured verify token refuses rather than echoes", () => {
  // Echoing unconditionally would let anybody point their own Meta app at
  // this endpoint and start receiving our webhooks.
  delete process.env.WHATSAPP_VERIFY_TOKEN;
  const params = new URLSearchParams({
    "hub.mode": "subscribe",
    "hub.verify_token": "anything",
    "hub.challenge": "1158201444",
  });
  assert.equal(metaAdapter.verifyChallenge!(params), null);
  process.env.WHATSAPP_VERIFY_TOKEN = VERIFY_TOKEN;
});

console.log("\n\x1b[1mMeta: signatures\x1b[0m\n");

await test("a correctly signed body is accepted", () => {
  process.env.WHATSAPP_APP_SECRET = APP_SECRET;
  assert.equal(
    metaAdapter.verifySignature(metaBody, headers({ "x-hub-signature-256": metaSignature(metaBody) }), ""),
    true,
  );
});

await test("a body signed with the wrong secret is refused", () => {
  assert.equal(
    metaAdapter.verifySignature(
      metaBody,
      headers({ "x-hub-signature-256": metaSignature(metaBody, "wrong") }),
      "",
    ),
    false,
  );
});

await test("a tampered body is refused", () => {
  const signature = metaSignature(metaBody);
  const tampered = metaBody.replace("haircut", "refund");
  assert.equal(
    metaAdapter.verifySignature(tampered, headers({ "x-hub-signature-256": signature }), ""),
    false,
  );
});

await test("a missing signature is refused", () => {
  assert.equal(metaAdapter.verifySignature(metaBody, headers({}), ""), false);
});

await test("an unconfigured app secret refuses everything", () => {
  delete process.env.WHATSAPP_APP_SECRET;
  assert.equal(
    metaAdapter.verifySignature(metaBody, headers({ "x-hub-signature-256": metaSignature(metaBody) }), ""),
    false,
  );
  process.env.WHATSAPP_APP_SECRET = APP_SECRET;
});

console.log("\n\x1b[1mMeta: parsing\x1b[0m\n");

await test("a text message comes out normalised", () => {
  const { messages } = metaAdapter.parse(metaBody);
  assert.equal(messages.length, 1);
  const m = messages[0];
  assert.equal(m.providerMessageId, "wamid.HBgMOTcxNTAxMjM0NTY3");
  assert.equal(m.fromE164, "+971501234567");
  assert.equal(m.toE164, "+15550001111");
  assert.equal(m.externalNumberId, "106540352242922");
  assert.equal(m.profileName, "Andreas");
  assert.deepEqual(m.content, { type: "text", text: "Hi, can I get a haircut tomorrow afternoon?" });
  // The timestamp is Meta's, not ours — it is seconds, and reading it as
  // milliseconds puts every conversation in 1970.
  assert.ok(m.timestamp.startsWith("2025-") || m.timestamp.startsWith("2026-"), m.timestamp);
});

await test("a delivery receipt in the same envelope comes out separately", () => {
  const { statuses } = metaAdapter.parse(metaBody);
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].providerMessageId, "wamid.OUTBOUND1");
  assert.equal(statuses[0].status, "delivered");
});

await test("a voice note is recognised as audio, with its media id", () => {
  const body = JSON.stringify({
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: "106540352242922" },
              messages: [
                {
                  from: "971501234567",
                  id: "wamid.AUDIO",
                  timestamp: "1757600000",
                  type: "audio",
                  audio: { id: "media-123", mime_type: "audio/ogg; codecs=opus", voice: true },
                },
              ],
            },
          },
        ],
      },
    ],
  });
  const { messages } = metaAdapter.parse(body);
  assert.deepEqual(messages[0].content, {
    type: "audio",
    mediaId: "media-123",
    mime: "audio/ogg; codecs=opus",
  });
});

await test("something we cannot read is recorded, not dropped", () => {
  // The customer sent something. Staff should see that they did, and Belline
  // should say it cannot read it — not answer as though nothing arrived.
  const body = JSON.stringify({
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: "106540352242922" },
              messages: [
                { from: "971501234567", id: "wamid.IMG", timestamp: "1757600000", type: "image" },
              ],
            },
          },
        ],
      },
    ],
  });
  const { messages } = metaAdapter.parse(body);
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].content, { type: "unsupported", kind: "image" });
});

await test("a body that is not JSON yields nothing rather than throwing", () => {
  // Throwing would become a 500, and a 500 makes Meta send it again forever.
  const out = metaAdapter.parse("<html>502 Bad Gateway</html>");
  assert.deepEqual(out, { messages: [], statuses: [] });
});

await test("an unknown status value is ignored rather than stored", () => {
  const body = JSON.stringify({
    entry: [{ changes: [{ value: { statuses: [{ id: "wamid.X", status: "warning" }] } }] }],
  });
  assert.equal(metaAdapter.parse(body).statuses.length, 0);
});

// --- Twilio -----------------------------------------------------------------

console.log("\n\x1b[1mTwilio\x1b[0m\n");

await test("a correctly signed form body is accepted", () => {
  process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
  assert.equal(
    twilioAdapter.verifySignature(
      twilioBody,
      headers({ "x-twilio-signature": twilioSignature(twilioUrl, twilioBody) }),
      twilioUrl,
    ),
    true,
  );
});

await test("the signature is over the public URL, not the one Node sees", () => {
  // Behind a proxy these differ, and getting it wrong fails every signature in
  // a way that looks exactly like a wrong auth token.
  assert.equal(
    twilioAdapter.verifySignature(
      twilioBody,
      headers({ "x-twilio-signature": twilioSignature(twilioUrl, twilioBody) }),
      "http://localhost:3000/api/whatsapp/webhook",
    ),
    false,
  );
});

await test("a tampered parameter is refused", () => {
  const signature = twilioSignature(twilioUrl, twilioBody);
  const tampered = twilioBody.replace("Anything+later%3F", "Cancel+my+booking");
  assert.equal(
    twilioAdapter.verifySignature(tampered, headers({ "x-twilio-signature": signature }), twilioUrl),
    false,
  );
});

await test("a text message comes out in the same normalised shape as Meta's", () => {
  const { messages } = twilioAdapter.parse(twilioBody);
  assert.equal(messages.length, 1);
  const m = messages[0];
  assert.equal(m.providerMessageId, "SM1234567890abcdef");
  assert.equal(m.fromE164, "+971501234567");
  assert.equal(m.toE164, "+14155238886");
  assert.equal(m.profileName, "Andreas");
  assert.deepEqual(m.content, { type: "text", text: "Anything later?" });
});

await test("a status callback is a status, not an empty message", () => {
  const body = new URLSearchParams({
    MessageSid: "SM1234567890abcdef",
    MessageStatus: "read",
    AccountSid: "AC0000000000000000",
  }).toString();
  const out = twilioAdapter.parse(body);
  assert.equal(out.messages.length, 0);
  assert.equal(out.statuses.length, 1);
  assert.equal(out.statuses[0].status, "read");
});

await test("undelivered is a failure, not a state of its own", () => {
  const body = new URLSearchParams({
    MessageSid: "SM1",
    MessageStatus: "undelivered",
    ErrorMessage: "Recipient has not opted in",
  }).toString();
  const { statuses } = twilioAdapter.parse(body);
  assert.equal(statuses[0].status, "failed");
  assert.ok(statuses[0].error?.includes("opted in"));
});

await test("an audio message keeps the URL it has to be fetched from", () => {
  const body = new URLSearchParams({
    MessageSid: "SM2",
    From: "whatsapp:+971501234567",
    To: "whatsapp:+14155238886",
    Body: "",
    NumMedia: "1",
    MediaContentType0: "audio/ogg",
    MediaUrl0: "https://api.twilio.com/2010-04-01/Accounts/AC0/Messages/MM0/Media/ME0",
  }).toString();
  const { messages } = twilioAdapter.parse(body);
  assert.equal(messages[0].content.type, "audio");
});

await test("media is only ever fetched from Twilio's own host", async () => {
  // The URL arrives in a webhook, and a webhook is data. Following an
  // arbitrary URL with our credentials attached turns a forged payload into a
  // credential leak.
  const out = await twilioAdapter.downloadMedia!(
    { id: 1 } as never,
    { accountSid: "AC0", authToken: "x" },
    "https://evil.example.com/collect",
  );
  assert.equal(out, null);
});

await test("an empty message is not a message", () => {
  const body = new URLSearchParams({
    MessageSid: "SM3",
    From: "whatsapp:+971501234567",
    Body: "   ",
    NumMedia: "0",
  }).toString();
  assert.equal(twilioAdapter.parse(body).messages.length, 0);
});

// --- the pipeline -----------------------------------------------------------

if (!isConfigured()) {
  console.log("\n  DATABASE_URL is not set — skipping the pipeline checks.\n");
} else {
  console.log("\n\x1b[1mThe pipeline\x1b[0m\n");

  const { migrateReception } = await import("../src/lib/reception/migrate");
  const { query, close } = await import("../src/lib/db/client");
  const repo = await import("../src/lib/reception/repo");
  const { acceptInbound } = await import("../src/lib/reception/inbound");

  await migrateReception();

  const T = `tnt_wa_${Date.now()}`;
  const numberId = `num_wa_${Date.now()}`;

  const cleanup = async () => {
    await query("delete from message where tenant_id = $1", [T]);
    await query("delete from conversation where tenant_id = $1", [T]);
    await query("delete from customer where tenant_id = $1", [T]);
    await query("delete from channel_account where tenant_id = $1", [T]);
    await query("delete from event where tenant_id = $1", [T]);
  };
  await cleanup();

  await repo.saveAccount({
    tenantId: T,
    businessId: "biz_wa",
    locationId: "loc_wa",
    channel: "whatsapp",
    provider: "meta",
    phoneE164: `+1555${Date.now() % 1000000}`,
    externalNumberId: numberId,
  });

  const inbound = () => ({
    ...metaAdapter.parse(metaBody).messages[0],
    externalNumberId: numberId,
    // The account lookup must match on the number id, not the display number.
    toE164: undefined,
  });

  await test("a message for a connected number lands in a conversation", async () => {
    const out = await acceptInbound(inbound());
    assert.ok(out.ok);
    if (!out.ok) return;
    assert.equal(out.accepted.fresh, true);
    assert.equal(out.accepted.tenantId, T);
    assert.equal(out.accepted.text, "Hi, can I get a haircut tomorrow afternoon?");
  });

  await test("the customer was created from the number, with their profile name", async () => {
    const customer = await repo.findCustomer(T, "+971501234567");
    assert.ok(customer);
    assert.equal(customer?.firstName, "Andreas");
  });

  await test("the same webhook arriving twice stores one message", async () => {
    const again = await acceptInbound(inbound());
    assert.ok(again.ok);
    if (!again.ok) return;
    assert.equal(again.accepted.fresh, false, "the retry was treated as a new message");

    const messages = await repo.listMessages(T, again.accepted.conversationId);
    const same = messages.filter((m) => m.providerMessageId === "wamid.HBgMOTcxNTAxMjM0NTY3");
    assert.equal(same.length, 1);
  });

  await test("a second message joins the same conversation", async () => {
    const next = { ...inbound(), providerMessageId: "wamid.SECOND" };
    const out = await acceptInbound(next);
    assert.ok(out.ok);
    if (!out.ok) return;
    assert.equal(out.accepted.fresh, true);
    const all = await repo.listConversations(T);
    assert.equal(all.length, 1, "a second message opened a second conversation");
  });

  await test("a message for a number nobody has connected is refused, not stored", async () => {
    const orphan = { ...inbound(), externalNumberId: "num_nobody_connected" };
    const out = await acceptInbound(orphan);
    assert.equal(out.ok, false);
    if (!out.ok) assert.equal(out.rejected.reason, "unknown_number");
  });

  await test("the conversation is stamped with the venue the number books into", async () => {
    const [conversation] = await repo.listConversations(T);
    assert.equal(conversation.businessId, "biz_wa");
    assert.equal(conversation.locationId, "loc_wa");
    assert.equal(conversation.status, "AI_ACTIVE");
  });

  await test("analytics recorded the conversation and the messages", async () => {
    const rows = await query<{ name: string; n: string }>(
      "select name, count(*) as n from event where tenant_id = $1 group by name",
      [T],
    );
    const byName = Object.fromEntries(rows.map((r) => [r.name, Number(r.n)]));
    assert.equal(byName["conversation.started"], 1);
    // Two fresh messages, and the duplicate must not have been counted.
    assert.equal(byName["message.received"], 2);
  });

  await cleanup();
  await close();
}

// ---------------------------------------------------------------------------
console.log("\nOur own number\n");

{
  const { whatsappNumber, whatsappMissing, whatsappConfigured, whatsappLink, ensureOwnWhatsAppAccount } =
    await import("../src/lib/whatsapp");
  const keep = { ...process.env };
  const clear = () => {
    for (const k of ["WHATSAPP_NUMBER", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN"]) {
      delete process.env[k];
    }
  };

  await test("with nothing set, it says what is missing and links nowhere", () => {
    clear();
    assert.equal(whatsappConfigured(), false);
    assert.equal(whatsappMissing().length, 5);
    assert.equal(whatsappLink("hi"), null);
  });

  await test("the number has to be a real E.164 number", () => {
    clear();
    process.env.WHATSAPP_NUMBER = "05 5 123";
    assert.equal(whatsappNumber(), null);
    process.env.WHATSAPP_NUMBER = "+971 55 123 4567";
    assert.equal(whatsappNumber(), "+971551234567");
  });

  await test("the link is Meta's own short link, without the plus, with the opener encoded", () => {
    clear();
    process.env.WHATSAPP_NUMBER = "+971551234567";
    assert.equal(whatsappLink("Hi Belle"), "https://wa.me/971551234567?text=Hi%20Belle");
    assert.equal(whatsappLink(), "https://wa.me/971551234567");
  });

  await test("configured means all five, and connecting without them is a skip, never a throw", async () => {
    clear();
    process.env.WHATSAPP_NUMBER = "+971551234567";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "123";
    process.env.WHATSAPP_ACCESS_TOKEN = "tok";
    process.env.WHATSAPP_APP_SECRET = "sec";
    assert.equal(whatsappConfigured(), false);
    const r = await ensureOwnWhatsAppAccount();
    assert.equal(r.state, "skipped");
    assert.match((r as { why: string }).why, /WHATSAPP_VERIFY_TOKEN/);
    process.env.WHATSAPP_VERIFY_TOKEN = "v";
    assert.equal(whatsappConfigured(), true);
  });

  await test("a venue's number is refused before it can be sealed: bad number, bad id, or ours not yet connected", async () => {
    clear();
    const { connectVenueNumber } = await import("../src/lib/whatsapp");
    const { listLocations } = await import("../src/lib/store");
    const venue = listLocations().find((l) => !l.demo?.enabled) ?? listLocations()[0];
    const bad = await connectVenueNumber({ location: venue, number: "050 123", phoneNumberId: "123456789" });
    assert.equal(bad.ok, false);
    assert.match((bad as { error: string }).error, /international form/);
    const badId = await connectVenueNumber({ location: venue, number: "+971501234567", phoneNumberId: "abc" });
    assert.equal(badId.ok, false);
    assert.match((badId as { error: string }).error, /phone number ID/);
    const oursFirst = await connectVenueNumber({ location: venue, number: "+971501234567", phoneNumberId: "123456789" });
    assert.equal(oursFirst.ok, false);
    assert.match((oursFirst as { error: string }).error, /ours comes first/);
  });

  process.env = keep;
}

console.log(
  failed === 0
    ? `\n\x1b[32m✓ ${passed} passed, 0 failed\x1b[0m\n`
    : `\n\x1b[31m✗ ${passed} passed, ${failed} failed\x1b[0m\n`,
);
process.exit(failed === 0 ? 0 : 1);

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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The self-serve states below write venues; never into the real data folder.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-whatsapp-"));

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

  await test("the Twilio sandbox is opt-in, and needs a real number and the Twilio keys", async () => {
    const { ensureTwilioSandboxAccount } = await import("../src/lib/whatsapp");
    delete process.env.TWILIO_WHATSAPP_FROM;
    assert.deepEqual(await ensureTwilioSandboxAccount(), { state: "skipped", why: "TWILIO_WHATSAPP_FROM not set" });
    process.env.TWILIO_WHATSAPP_FROM = "415 523 8886";
    assert.match((await ensureTwilioSandboxAccount() as { why: string }).why, /E\.164/);
    process.env.TWILIO_WHATSAPP_FROM = "+14155238886";
    delete process.env.TWILIO_ACCOUNT_SID;
    assert.match((await ensureTwilioSandboxAccount() as { why: string }).why, /TWILIO_ACCOUNT_SID/);
  });

  process.env = keep;
}

// ---------------------------------------------------------------------------
console.log("\nA venue's number, self-serve\n");

{
  const { splitNumber, startNumber, finishNumber, resendCode, explain, provisioningMissing } =
    await import("../src/lib/whatsapp-provision");
  type Reply = import("../src/lib/whatsapp-provision").GraphReply;

  /** A Meta that answers what it is told to, and remembers what it was asked. */
  function fakeGraph(script: Record<string, Reply | ((body: Record<string, unknown>) => Reply)>) {
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    return {
      calls,
      graph: {
        async post(path: string, body: Record<string, unknown>) {
          calls.push({ path, body });
          const key = Object.keys(script).find((k) => path.endsWith(k)) ?? "";
          const reply = script[key];
          if (!reply) return { ok: false, status: 404, body: { error: { message: `no script for ${path}` } } };
          return typeof reply === "function" ? reply(body) : reply;
        },
      },
    };
  }
  const ok = (body: Record<string, unknown> = { success: true }): Reply => ({ ok: true, status: 200, body });
  const fail = (message: string, code?: number): Reply => ({ ok: false, status: 400, body: { error: { message, code } } });

  await test("a number is split the way Meta wants it, and only from countries we serve", () => {
    assert.deepEqual(splitNumber("+971 50 123 4567"), { cc: "971", national: "501234567", e164: "+971501234567" });
    assert.deepEqual(splitNumber("+41 79 123 45 67"), { cc: "41", national: "791234567", e164: "+41791234567" });
    assert.equal(splitNumber("0501234567"), null, "no plus, no idea which country");
    assert.equal(splitNumber("+9999 1234567"), null, "not a country code we serve");
  });

  await test("step one adds the number under our account and asks for the SMS", async () => {
    const meta = fakeGraph({ "/phone_numbers": ok({ id: "1122334455" }), "/request_code": ok() });
    const r = await startNumber({ wabaId: "WABA1", number: "+971501234567", displayName: "  Marina  Hair ", graph: meta.graph });
    assert.deepEqual(r, { ok: true, phoneNumberId: "1122334455" });
    assert.equal(meta.calls[0].path, "WABA1/phone_numbers");
    assert.deepEqual(meta.calls[0].body, { cc: "971", phone_number: "501234567", verified_name: "Marina Hair" });
    assert.equal(meta.calls[1].path, "1122334455/request_code");
    assert.equal(meta.calls[1].body.code_method, "SMS");
  });

  await test("a number already on WhatsApp is refused with what to do about it", async () => {
    const meta = fakeGraph({ "/phone_numbers": fail("Phone number is already registered", 100) });
    const r = await startNumber({ wabaId: "W", number: "+971501234567", displayName: "Marina", graph: meta.graph });
    assert.ok(!r.ok && /already on WhatsApp/.test(r.error));
    assert.equal(meta.calls.length, 1, "no code was requested for a number that was not added");
  });

  await test("step two verifies the code, registers with a fresh PIN, and returns the PIN to be sealed", async () => {
    let registeredWith: Record<string, unknown> | null = null;
    const meta = fakeGraph({
      "/verify_code": (body) => (body.code === "123456" ? ok() : fail("Invalid verification code")),
      "/register": (body) => {
        registeredWith = body;
        return ok();
      },
    });
    const wrong = await finishNumber({ phoneNumberId: "11", code: "000000", graph: meta.graph });
    assert.ok(!wrong.ok && /isn't right/.test(wrong.error));
    const right = await finishNumber({ phoneNumberId: "11", code: "12 34 56", graph: meta.graph });
    assert.ok(right.ok);
    assert.match(right.ok ? right.pin : "", /^\d{6}$/);
    assert.equal((registeredWith as Record<string, unknown> | null)?.messaging_product, "whatsapp");
    assert.equal((registeredWith as Record<string, unknown> | null)?.pin, right.ok ? right.pin : null);
  });

  await test("the code can be sent again, by SMS or by a call", async () => {
    const meta = fakeGraph({ "/request_code": ok() });
    assert.deepEqual(await resendCode("11", meta.graph, "VOICE"), { ok: true });
    assert.equal(meta.calls[0].body.code_method, "VOICE");
  });

  await test("Meta's errors come out as sentences, never codes", () => {
    assert.match(explain(fail("Error validating access token", 190)), /on our side — nothing for you to do/);
    assert.ok(!/hello@|email us/i.test(explain(fail("Error validating access token", 190))));
    assert.match(explain(fail("Too many attempts", 4)), /slow down/);
    assert.match(explain(fail("Something new")), /Meta said: Something new/);
    assert.match(explain({ ok: false, status: 500, body: {} }), /didn't answer/);
  });

  await test("self-serve needs the business account id as well as the token", () => {
    const keep2 = { ...process.env };
    delete process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    assert.deepEqual(provisioningMissing(), ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_BUSINESS_ACCOUNT_ID"]);
    process.env = keep2;
  });
}

// ---------------------------------------------------------------------------
console.log("\nSelf-serve states, with a fake Meta\n");

{
  const { installFetchGuard, blockedFetches, fakeGraph } = await import("../src/lib/testing/stubs");
  installFetchGuard();
  const { seedIfEmpty } = await import("../src/lib/seed");
  const { getLocation, upsertLocation } = await import("../src/lib/store");
  const { journey } = await import("../src/lib/onboarding/journey");
  const { listExceptions } = await import("../src/lib/exceptions");
  const sf = await import("../src/lib/whatsapp-selfserve");
  const fsRead = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
  const quiet = async <T,>(fn: () => Promise<T> | T): Promise<T> => {
    const error = console.error;
    console.error = () => {};
    try {
      return await fn();
    } finally {
      console.error = error;
    }
  };

  seedIfEmpty();
  const keep = { ...process.env };
  const venue = () => getLocation("loc_lumiere")!;
  upsertLocation({ ...venue(), onboarding: { version: 1, channels: {} } });
  const none = { state: "none" } as const;

  await test("flag off: the card says Coming soon, never 'Email us', and Go live does not depend on WhatsApp", () => {
    delete process.env.FLAG_CHANNEL_WHATSAPP_SELFSERVE;
    assert.deepEqual(sf.whatsappCard(venue(), none), { state: "soon" });
    const before = journey(venue());
    const withWa = { ...venue(), onboarding: { version: 1 as const, channels: { whatsapp: { status: "rejected" as const, since: "2026-09-15T10:00:00.000Z" } } } };
    const after = journey(withWa);
    assert.equal(after.canGoLive, before.canGoLive);
    assert.deepEqual(after.blockers, before.blockers);
    // Since 2026-09-16 a connected WhatsApp counts as a channel (any one is
    // enough), so journey() reads it. It can only ever remove a blocker, never
    // add one: WhatsApp is still not something going live waits for.
    const connected = { ...venue(), onboarding: { version: 1 as const, channels: { whatsapp: { status: "live" as const, since: "2026-09-15T10:00:00.000Z", number: "+97140000077" } } } };
    const withLive = journey(connected);
    assert.ok(withLive.blockers.every((b) => before.blockers.some((x) => x.label === b.label)), "a connected WhatsApp added a blocker");
    assert.ok(!before.blockers.some((b) => /WhatsApp/i.test(b.label)), "going live waits for WhatsApp");
  });

  process.env.FLAG_CHANNEL_WHATSAPP_SELFSERVE = "on";
  process.env.WHATSAPP_ACCESS_TOKEN = "test-token";
  process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = "WABA1";
  process.env.CREDENTIALS_KEY = "test-credentials-key";

  const meta = fakeGraph();
  const connected: string[] = [];
  const p = {
    graph: meta.graph,
    wabaId: "WABA1",
    connect: async (input: { number: string }) => {
      connected.push(input.number);
      return { ok: true as const };
    },
  };

  await test("flag on: start, code, name review, then live", async () => {
    assert.deepEqual(sf.whatsappCard(venue(), none), { state: "none" });
    const started = await sf.startWhatsApp(venue(), { number: "+971501112233", displayName: "Lumière" }, p);
    assert.ok(started.ok, !started.ok ? started.error : "");
    assert.deepEqual(sf.whatsappCard(venue(), none), { state: "pending_code", number: "+971501112233" });

    const wrong = await sf.finishWhatsApp(venue(), "000000", p);
    assert.ok(!wrong.ok && /isn't right/.test(wrong.error));
    assert.equal(sf.whatsappCard(venue(), none).state, "pending_code", "a wrong code lost the pending number");

    const done = await sf.finishWhatsApp(venue(), "123456", p);
    assert.ok(done.ok);
    assert.ok(meta.posts.some((c) => c.path === "WABA1/subscribed_apps"), "the app was not subscribed to the number's webhooks");
    assert.deepEqual(connected, ["+971501112233"]);
    assert.equal(venue().whatsappPending, undefined);
    assert.equal(sf.whatsappCard(venue(), none).state, "pending_name");

    const id = venue().onboarding!.channels.whatsapp!.phoneNumberId!;
    assert.equal(await sf.checkWhatsApp(venue(), meta.graph), "unchanged");
    meta.setNameStatus(id, "APPROVED");
    const job = await sf.runWhatsAppChecks(meta.graph);
    assert.deepEqual(job, { checked: 1, moved: 1 });
    assert.deepEqual(sf.whatsappCard(venue(), none), { state: "live", number: "+971501112233" });
  });

  await test("a refused name says why and offers another try; the second refusal opens a ticket", async () => {
    const salon = () => getLocation("loc_azure")!;
    upsertLocation({ ...salon(), onboarding: { version: 1, channels: {} } });
    for (const attempt of [1, 2]) {
      await sf.startWhatsApp(salon(), { number: "+971502223344", displayName: "Azure" }, p);
      await sf.finishWhatsApp(salon(), "123456", p);
      meta.setNameStatus(salon().onboarding!.channels.whatsapp!.phoneNumberId!, "DECLINED");
      assert.equal(await quiet(() => sf.checkWhatsApp(salon(), meta.graph)), "rejected");
      const card = sf.whatsappCard(salon(), none);
      assert.equal(card.state, "rejected");
      assert.match(card.state === "rejected" ? card.reason : "", /signage/);
      assert.equal(listExceptions({ locationId: salon().id, kind: "whatsapp_rejected" }).length, attempt === 2 ? 1 : 0);
      if (attempt === 1) {
        sf.resetWhatsApp(salon());
        assert.equal(sf.whatsappCard(salon(), none).state, "none");
      }
    }
  });

  await test("Meta refusing our token (190) opens a ticket, and the owner is told it is ours to fix", async () => {
    const venueB = () => getLocation("loc_belline")!;
    upsertLocation({ ...venueB(), onboarding: { version: 1, channels: {} } });
    await sf.startWhatsApp(venueB(), { number: "+971503334455", displayName: "Belline" }, p);
    await sf.finishWhatsApp(venueB(), "123456", p);
    meta.failGets({ ok: false, status: 400, body: { error: { message: "Error validating access token", code: 190 } } });
    assert.equal(await quiet(() => sf.checkWhatsApp(venueB(), meta.graph)), "blocked");
    meta.failGets(undefined);
    assert.equal(listExceptions({ locationId: venueB().id, kind: "whatsapp_token_expired" }).length, 1);
    const card = sf.whatsappCard(venueB(), none);
    assert.deepEqual(card, { state: "blocked", message: "We're fixing this on our side — nothing for you to do." });

    const expired = fakeGraph((path) =>
      path.endsWith("/phone_numbers") ? { ok: false, status: 401, body: { error: { message: "expired", code: 190 } } } : undefined,
    );
    const venueC = () => getLocation("loc_lumiere")!;
    upsertLocation({ ...venueC(), onboarding: { version: 1, channels: {} } });
    const out = await quiet(() => sf.startWhatsApp(venueC(), { number: "+971504445566", displayName: "Lumière" }, { ...p, graph: expired.graph }));
    assert.ok(!out.ok && out.error === "We're fixing this on our side — nothing for you to do.");
    assert.equal(sf.whatsappCard(venueC(), none).state, "blocked");
  });

  await test("a failed lookup is a retry, not a dead end", () => {
    const fresh = { ...venue(), onboarding: { version: 1 as const, channels: {} } };
    assert.deepEqual(sf.whatsappCard(fresh, { state: "unavailable" }), { state: "unavailable" });
    const card = fsRead("src/app/(app)/integrations/WhatsAppCard.tsx");
    assert.match(card, /\/api\/whatsapp\/check/);
    assert.match(card, /Try again/);
    assert.match(card, /Skip — add WhatsApp later/);
    const screens = card + fsRead("src/app/(app)/integrations/page.tsx") + fsRead("src/app/api/whatsapp/number/route.ts");
    assert.ok(!/Reload this page|hello@|Email us/i.test(screens), "a dead end is still on the WhatsApp screens");
    assert.match(fsRead("src/app/api/whatsapp/number/route.ts"), /flag\("channel\.whatsapp\.selfserve"\)/);
    assert.ok(!/Not self-serve/.test(fsRead("src/lib/whatsapp.ts")));
  });

  await test("no request left for Meta or anywhere else", () => {
    assert.deepEqual(blockedFetches(), []);
  });

  process.env = keep;
}

console.log(
  failed === 0
    ? `\n\x1b[32m✓ ${passed} passed, 0 failed\x1b[0m\n`
    : `\n\x1b[31m✗ ${passed} passed, ${failed} failed\x1b[0m\n`,
);
process.exit(failed === 0 ? 0 : 1);

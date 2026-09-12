/**
 * Belline, typed, on a venue's own website.
 *
 * The third channel, and the first one that is public, unauthenticated and
 * costs money on every request. So most of what is pinned here is about who is
 * allowed to make it spend, and the tests are written for the ways each control
 * fails *open* rather than the way it works.
 *
 * Four properties in particular would be easy to lose later, and each one is
 * silent when it breaks:
 *
 *   **A venue's choice is the venue's.** `data-mode` on the script tag picks
 *   which button appears. It must never be able to switch on a channel the
 *   venue has switched off, or the entitlement lives in a customer's HTML.
 *
 *   **Unset means voice.** Every site already carrying this script asked for a
 *   bell. Shipping web chat must not add a chat bubble to their live website.
 *
 *   **A visitor id is not a guess.** It is minted server-side and signed. An
 *   unsigned or edited one must not resolve to anybody's conversation.
 *
 *   **The two website channels have separate ceilings.** A busy afternoon on
 *   the bell must not switch the chat off, and neither must switch off the
 *   telephone.
 *
 *   npm run check:webchat        (the database half needs DATABASE_URL)
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-webchat-"));
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "webchat-test-secret";

const { seedIfEmpty } = await import("../src/lib/seed");
const { signUp } = await import("../src/lib/onboarding");
const { getLocation, saveCall } = await import("../src/lib/store");
const { startCall } = await import("../src/lib/calls");
const { enableEmbed, checkEmbedGate, embedSnippet, parseMode } = await import("../src/lib/embed");
const { signVisitorToken, verifyVisitorToken } = await import("../src/lib/auth");
const { BELLINE_LOCATION_ID } = await import("../src/lib/seed-belline");
const { isConfigured } = await import("../src/lib/db/client");
const {
  modeOf,
  voiceAllowed,
  chatAllowed,
  chatGate,
  newVisitorId,
  visitorHandle,
  isPhoneHandle,
  describeHandle,
  messageCeiling,
  ceilingMessage,
  takeTurnSlot,
  releaseTurnSlot,
  clearTurnSlots,
  WEBCHAT_DEFAULTS,
} = await import("../src/lib/webchat");

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

function head(title: string) {
  console.log(`\n\x1b[1m${title}\x1b[0m\n`);
}

seedIfEmpty();

const signed = await signUp({
  businessName: "Marina Hair",
  email: "owner@marinahair.ae",
  password: "Correct-Horse-Battery-9",
  timezone: "Asia/Dubai",
  vertical: "salon",
});
if (!signed.ok) throw new Error("could not create the test venue");
let venue = getLocation(signed.location.id)!;

// ---------------------------------------------------------------------------
head("What the venue switched on");

await test("a venue with no widget offers nothing", () => {
  assert.equal(modeOf(undefined), null);
  assert.equal(voiceAllowed(undefined), false);
  assert.equal(chatAllowed(undefined), false);
});

await test("an existing widget with no mode is the bell, not both", () => {
  // The property that stops this feature changing somebody's live website. A
  // venue that switched the widget on before chat existed asked for a bell.
  const legacy = {
    key: "be_old",
    enabled: true,
    allowedOrigins: ["https://old.ae"],
    maxCallsPerDay: 40,
    maxCallSeconds: 300,
  };
  assert.equal(modeOf(legacy), "voice");
  assert.equal(voiceAllowed(legacy), true);
  assert.equal(chatAllowed(legacy), false);
});

await test("switching the widget on today offers both", () => {
  venue = enableEmbed(venue, ["https://marinahair.ae"]);
  assert.equal(venue.embed?.mode, "both");
  assert.equal(voiceAllowed(venue.embed), true);
  assert.equal(chatAllowed(venue.embed), true);
});

await test("chat only means the bell is refused, with something to read", () => {
  const chatOnly = enableEmbed(venue, ["https://marinahair.ae"], undefined, "chat");
  assert.equal(voiceAllowed(chatOnly.embed), false);
  const gate = checkEmbedGate(chatOnly);
  assert.equal(gate.allowed, false);
  assert.ok(gate.message, "a refusal a visitor cannot read is a blank frame");
  assert.equal(/mode|config|embed/i.test(gate.message!), false, "no technical words");
});

await test("voice only means the chat is refused", () => {
  const voiceOnly = enableEmbed(venue, ["https://marinahair.ae"], undefined, "voice");
  assert.equal(chatAllowed(voiceOnly.embed), false);
  assert.equal(chatGate(voiceOnly).allowed, false);
  venue = enableEmbed(voiceOnly, ["https://marinahair.ae"], undefined, "both");
});

await test("a chat-only widget does not open a voice socket", async () => {
  // The hole this found. `mayStreamTo` let anything with `embed.enabled`
  // stream, which was right when the widget could only be a bell — and one
  // mode too wide the moment it could be a chat. A venue offering the chat has
  // not agreed to strangers spending a second of speech on its account.
  const { mayStreamTo } = await import("../src/lib/voice/entitlement");
  const chatOnly = enableEmbed(getLocation(venue.id)!, ["https://marinahair.ae"], undefined, "chat");
  assert.equal(mayStreamTo(chatOnly), false, "a chat-only venue was dialable");
  const both = enableEmbed(getLocation(venue.id)!, ["https://marinahair.ae"], undefined, "both");
  assert.equal(mayStreamTo(both), true, "a venue that asked for the bell lost it");
  venue = both;
});

await test("a disabled widget offers nothing, whatever the mode says", () => {
  assert.equal(chatAllowed({ ...venue.embed!, enabled: false }), false);
  assert.equal(voiceAllowed({ ...venue.embed!, enabled: false, mode: "both" }), false);
});

await test("the snippet carries the venue's mode, so a paste is enough", () => {
  const snippet = embedSnippet(getLocation(venue.id)!);
  assert.ok(snippet.includes('data-mode="both"'));
  assert.ok(snippet.includes(venue.embed!.key));
  assert.equal(snippet.split("\n").length, 1, "the snippet must stay one line");
});

await test("an unrecognised mode leaves the venue where it was", () => {
  // Stored, it would fail every predicate and present as a widget that is
  // switched on and offers nothing — the hardest failure to diagnose from
  // outside, because the dashboard would say it was working.
  for (const junk of ["", "VOICE", "on", "true", null, undefined, 7, {}, ["both"]]) {
    assert.equal(parseMode(junk), undefined, `accepted ${JSON.stringify(junk)}`);
  }
  for (const good of ["voice", "chat", "both"] as const) {
    assert.equal(parseMode(good), good);
  }
});

await test("saving without naming a mode does not silently change one", () => {
  const chatOnly = enableEmbed(getLocation(venue.id)!, ["https://marinahair.ae"], undefined, "chat");
  // The dashboard posts origins on every save. A venue that had chosen chat
  // must not be flipped back to the default by editing its website list.
  const edited = enableEmbed(chatOnly, ["https://marinahair.ae", "https://staging.marinahair.ae"]);
  assert.equal(edited.embed!.mode, "chat");
  assert.equal(edited.embed!.allowedOrigins.length, 2);
  venue = enableEmbed(edited, ["https://marinahair.ae"], undefined, "both");
});

await test("the dashboard screen exists and is reachable", () => {
  // This feature shipped once without a screen: the endpoint was real and the
  // only way to use it was to POST by hand. A page nobody can navigate to has
  // not shipped.
  const page = path.join(process.cwd(), "src", "app", "(app)", "website", "page.tsx");
  assert.ok(fs.existsSync(page), "no /website screen");
  const nav = fs.readFileSync(
    path.join(process.cwd(), "src", "app", "(app)", "layout.tsx"),
    "utf8",
  );
  assert.ok(nav.includes('href: "/website"'), "the screen is not in the navigation");
});

// ---------------------------------------------------------------------------
head("Who the visitor is");

await test("a handle is not a phone number and never looks like one", () => {
  const id = newVisitorId();
  const handle = visitorHandle(id);
  assert.ok(handle.startsWith("web:"));
  assert.equal(isPhoneHandle(handle), false);
  assert.equal(isPhoneHandle("+971501234567"), true);
  // The shape the Postgres check constraint enforces. A handle it rejects is a
  // visitor whose first message is a 500.
  assert.match(handle, /^web:[A-Za-z0-9_-]{8,64}$/);
});

await test("two visitors are two visitors", () => {
  const seen = new Set(Array.from({ length: 200 }, () => newVisitorId()));
  assert.equal(seen.size, 200);
});

await test("staff see a person, not a database row", () => {
  assert.equal(describeHandle(visitorHandle(newVisitorId())), "Website visitor");
  assert.equal(describeHandle("+971501234567"), "+971501234567");
  assert.equal(describeHandle(undefined), "Unknown");
});

await test("a signed identity comes back as it went in", () => {
  const id = newVisitorId();
  const token = signVisitorToken(venue.id, id);
  assert.deepEqual(verifyVisitorToken(token), { locationId: venue.id, visitorId: id });
});

await test("an edited identity resolves to nobody", () => {
  const id = newVisitorId();
  const token = signVisitorToken(venue.id, id);
  const [loc, visitor, expires, mac] = token.split(".");
  // Somebody claiming a different visitor, keeping the signature.
  assert.equal(verifyVisitorToken(`${loc}.${newVisitorId()}.${expires}.${mac}`), null);
  // Somebody claiming a different venue.
  assert.equal(verifyVisitorToken(`loc_other.${visitor}.${expires}.${mac}`), null);
  // Somebody extending their own expiry.
  assert.equal(verifyVisitorToken(`${loc}.${visitor}.${Date.now() + 9e9}.${mac}`), null);
  assert.equal(verifyVisitorToken("not-a-token"), null);
  assert.equal(verifyVisitorToken(undefined), null);
});

await test("an expired identity is refused", () => {
  const token = signVisitorToken(venue.id, newVisitorId(), -1);
  assert.equal(verifyVisitorToken(token), null);
});

// ---------------------------------------------------------------------------
head("What it may spend");

await test("a fresh widget is within its ceiling", () => {
  const gate = chatGate(getLocation(venue.id)!);
  assert.equal(gate.allowed, true);
  assert.equal(gate.limit, WEBCHAT_DEFAULTS.maxChatsPerDay);
});

await test("the ceiling counts chats and stops at the limit", () => {
  const small = enableEmbed(getLocation(venue.id)!, ["https://marinahair.ae"], {
    maxChatsPerDay: 2,
  });
  for (let i = 0; i < 2; i++) saveCall(startCall(small, "webchat", "Website"));
  const gate = chatGate(getLocation(small.id)!);
  assert.equal(gate.allowed, false);
  assert.ok(gate.message, "a visitor at the ceiling must be told something useful");
  assert.ok(gate.message!.includes("ring"), "send them somewhere that works");
});

await test("a busy bell does not switch the chat off, or the other way round", () => {
  const both = enableEmbed(getLocation(venue.id)!, ["https://marinahair.ae"], {
    maxChatsPerDay: 2,
    maxCallsPerDay: 2,
  });
  // Two spoken calls through the website, on a venue whose chat is already at
  // its own ceiling from the test above.
  for (let i = 0; i < 2; i++) saveCall(startCall(both, "embed", "Website"));
  const fresh = getLocation(both.id)!;
  assert.equal(checkEmbedGate(fresh).allowed, false, "the bell reached its own cap");
  // And a third venue-wide channel, untouched by either.
  const telephone = startCall(fresh, "phone", "+971509990001");
  assert.equal(telephone.channel, "phone");
});

await test("another venue's chats do not count against this one", async () => {
  const other = await signUp({
    businessName: "Quiet Clinic",
    email: "owner@quietclinic.ae",
    password: "Correct-Horse-Battery-9",
    timezone: "Asia/Dubai",
    vertical: "clinic",
  });
  if (!other.ok) throw new Error("second venue");
  const quiet = enableEmbed(other.location, ["https://quietclinic.ae"], { maxChatsPerDay: 2 });
  assert.equal(chatGate(getLocation(quiet.id)!).allowed, true);
});

await test("one conversation cannot run forever", () => {
  const v = getLocation(venue.id)!;
  assert.equal(messageCeiling(v), WEBCHAT_DEFAULTS.maxMessagesPerChat);
  const capped = enableEmbed(v, ["https://marinahair.ae"], { maxMessagesPerChat: 5 });
  assert.equal(messageCeiling(getLocation(capped.id)!), 5);
  const said = ceilingMessage(getLocation(capped.id)!);
  assert.equal(/limit|cap|quota|exceeded/i.test(said), false, "no technical words");
  assert.ok(said.includes("ring"), "send them somewhere that works");
});

// ---------------------------------------------------------------------------
head("One turn at a time");

await test("a second press while a turn is running is refused", () => {
  clearTurnSlots();
  const id = newVisitorId();
  assert.equal(takeTurnSlot(id), true);
  assert.equal(takeTurnSlot(id), false, "the double-click ran a second turn");
});

await test("a different visitor is not blocked by somebody else's turn", () => {
  clearTurnSlots();
  assert.equal(takeTurnSlot(newVisitorId()), true);
  assert.equal(takeTurnSlot(newVisitorId()), true);
});

await test("the slot comes back when the turn finishes", async () => {
  clearTurnSlots();
  const id = newVisitorId();
  takeTurnSlot(id);
  releaseTurnSlot(id);
  assert.equal(takeTurnSlot(id), false, "an instant re-send is still a double-click");
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(takeTurnSlot(id), true, "a visitor locked out of their own conversation");
});

// ---------------------------------------------------------------------------
head("The widget on somebody else's page");

const widget = fs.readFileSync(path.join(process.cwd(), "public", "embed.js"), "utf8");

await test("the script offers all three modes", () => {
  assert.ok(widget.includes("data-mode"));
  assert.ok(widget.includes('"chat"') && widget.includes('"both"'));
});

await test("an unrecognised mode falls back to the bell, not to everything", () => {
  // The line that does it, read rather than executed: anything that is not
  // chat or both is voice.
  assert.ok(widget.includes('if (mode !== "chat" && mode !== "both") mode = "voice"'));
});

await test("only the spoken panel asks for a microphone", () => {
  assert.ok(
    widget.includes('if (kind === "voice") panel.allow = "microphone; autoplay"'),
    "a chat window asking for a microphone gets a widget removed from a site",
  );
});

await test("the chat panel opens the chat page, not the call page", () => {
  assert.ok(widget.includes('(kind === "chat" ? "/chat" : "")'));
});

await test("the widget still carries no secrets", () => {
  assert.equal(/sk_|whsec_|belline_session|SESSION_SECRET/.test(widget), false);
});

// ---------------------------------------------------------------------------
head("Our own website");

await test("Belline's own venue carries the chat and a fixed, public key", () => {
  const ours = getLocation(BELLINE_LOCATION_ID)!;
  assert.ok(ours.embed?.enabled);
  assert.equal(ours.embed!.key, "be_belline_site");
  assert.equal(chatAllowed(ours.embed), true);
  // The bell on our front page is the hero button, not a second widget.
  assert.equal(voiceAllowed(ours.embed), false);
});

await test("our own origins are named, and nobody else's", () => {
  const ours = getLocation(BELLINE_LOCATION_ID)!;
  assert.ok(ours.embed!.allowedOrigins.includes("https://belline.ai"));
  assert.ok(ours.embed!.allowedOrigins.includes("https://www.belline.ai"));
  assert.equal(ours.embed!.allowedOrigins.some((o) => o.includes("*")), false);
});

await test("the landing page's button is inert without JavaScript", () => {
  const html = fs.readFileSync(path.join(process.cwd(), "public", "landing.html"), "utf8");
  assert.ok(html.includes("data-chat="), "no chat button on the front page");
  // Hidden in the markup and revealed by the script: a button that cannot work
  // must not be on screen.
  assert.match(html, /<button class="chat-fab"[^>]*hidden/);
  const js = fs.readFileSync(path.join(process.cwd(), "public", "site.js"), "utf8");
  assert.ok(js.includes("fab.hidden = false"));
  assert.ok(js.includes('"?o=" + encodeURIComponent(location.origin)'), "no framing origin");
});

await test("the front page does not claim WhatsApp is live", () => {
  const raw = fs.readFileSync(path.join(process.cwd(), "public", "landing.html"), "utf8");
  // What a visitor reads, not what the source says. The comments explain the
  // decision to whoever edits the file next; they are not the claim.
  const html = raw.replace(/<!--[\s\S]*?-->/g, "");
  const whatsapp = html.slice(html.indexOf("WhatsApp"));
  assert.ok(
    /not connected|not yet|coming|not live/i.test(whatsapp.slice(0, 400)),
    "WhatsApp is mentioned without saying it is not connected",
  );
});

// ---------------------------------------------------------------------------
// The database half.
// ---------------------------------------------------------------------------

if (!isConfigured()) {
  console.log("\n  \x1b[2mDATABASE_URL is not set — skipping the account checks.\x1b[0m");
} else {
  head("The account, and the person on the other end");

  const { migrateReception } = await import("../src/lib/reception/migrate");
  const { query, close } = await import("../src/lib/db/client");
  const repo = await import("../src/lib/reception/repo");
  const { acceptInbound } = await import("../src/lib/reception/inbound");
  const { ensureWebchatAccount } = await import("../src/lib/webchat");

  await migrateReception();

  const live = getLocation(venue.id)!;
  await query("delete from message where tenant_id = $1", [live.tenantId]);
  await query("delete from conversation where tenant_id = $1", [live.tenantId]);
  await query("delete from customer where tenant_id = $1", [live.tenantId]);
  await query("delete from channel_account where tenant_id = $1", [live.tenantId]);

  await test("a venue's chat account is created on the first message, once", async () => {
    const first = await ensureWebchatAccount(live);
    const second = await ensureWebchatAccount(live);
    assert.equal(first.id, second.id, "a venue with two accounts loses half its visitors");
    assert.equal(first.channel, "webchat");
    assert.equal(first.provider, "webchat");
    assert.equal(first.phoneE164, undefined, "web chat has no number to claim");
    assert.equal(first.aiEnabled, true);
  });

  await test("a visitor with no phone number is a customer all the same", async () => {
    const handle = visitorHandle(newVisitorId());
    const customer = await repo.upsertCustomer(live.tenantId, handle);
    assert.equal(customer.phoneE164, handle);
    const again = await repo.findCustomer(live.tenantId, handle);
    assert.equal(again?.id, customer.id);
  });

  await test("a handle that is not one of the two shapes is refused by the database", async () => {
    // The constraint, not the comment. A column whose meaning lives only in a
    // docstring is one the next writer will fill with anything.
    await assert.rejects(
      () => repo.upsertCustomer(live.tenantId, "0501234567"),
      /customer_handle_shape|violates check constraint/,
    );
  });

  await test("a message from the website opens a conversation on the right channel", async () => {
    const account = await ensureWebchatAccount(live);
    const handle = visitorHandle(newVisitorId());
    const accepted = await acceptInbound(
      {
        channel: "webchat",
        provider: "webchat",
        providerMessageId: "web_test_1",
        fromE164: handle,
        content: { type: "text", text: "do you do balayage?" },
        timestamp: new Date().toISOString(),
        raw: {},
      },
      account,
    );
    assert.equal(accepted.ok, true);
    if (!accepted.ok) return;
    assert.equal(accepted.accepted.fresh, true);
    const conversation = await repo.getConversation(
      live.tenantId,
      accepted.accepted.conversationId,
    );
    assert.equal(conversation?.channel, "webchat");
    assert.equal(conversation?.locationId, live.id);
    assert.equal(conversation?.status, "AI_ACTIVE");
  });

  await test("a resend of the same message changes nothing", async () => {
    const account = await ensureWebchatAccount(live);
    const handle = visitorHandle(newVisitorId());
    const send = () =>
      acceptInbound(
        {
          channel: "webchat",
          provider: "webchat",
          providerMessageId: "web_test_retry",
          fromE164: handle,
          content: { type: "text", text: "are you open on Sunday?" },
          timestamp: new Date().toISOString(),
          raw: {},
        },
        account,
      );
    const first = await send();
    const second = await send();
    assert.equal(first.ok && first.accepted.fresh, true);
    assert.equal(second.ok && second.accepted.fresh, false, "a retry asked the model twice");
    if (!second.ok) return;
    const messages = await repo.listMessages(live.tenantId, second.accepted.conversationId);
    assert.equal(messages.filter((m) => m.sender === "customer").length, 1);
  });

  await test("a website visitor and a telephone caller are different people", async () => {
    const handle = visitorHandle(newVisitorId());
    const web = await repo.upsertCustomer(live.tenantId, handle);
    const phone = await repo.upsertCustomer(live.tenantId, "+971509990002");
    assert.notEqual(web.id, phone.id);
  });

  await query("delete from message where tenant_id = $1", [live.tenantId]);
  await query("delete from conversation where tenant_id = $1", [live.tenantId]);
  await query("delete from customer where tenant_id = $1", [live.tenantId]);
  await query("delete from channel_account where tenant_id = $1", [live.tenantId]);
  await query("delete from event where tenant_id = $1", [live.tenantId]);
  await close();
}

console.log(
  failed === 0
    ? `\n\x1b[32m✓ ${passed} passed, 0 failed\x1b[0m\n`
    : `\n\x1b[31m✗ ${passed} passed, ${failed} failed\x1b[0m\n`,
);
process.exit(failed === 0 ? 0 : 1);

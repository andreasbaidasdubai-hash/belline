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

await test("only the spoken panel plays sound; the chat may record a note, never on opening", () => {
  // Both frames are *permitted* the microphone — the chat needs it for the
  // voice note — but only the call gets autoplay, and the chat page asks the
  // browser only when the button is held (checked under "Voice notes").
  assert.ok(
    widget.includes('panel.allow = kind === "voice" ? "microphone; autoplay" : "microphone"'),
    "the chat frame cannot record a voice note, or the call frame cannot play",
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

await test("the public phone menu takes keyboard focus in, and Escape gives it back to the toggle", () => {
  const js = fs.readFileSync(path.join(process.cwd(), "public", "site.js"), "utf8");
  // The file's contents list at the top names the call panel too, so look for
  // the end marker after the menu's own.
  const start = js.indexOf("/* --- mobile menu");
  const menu = js.slice(start, js.indexOf("/* --- the call panel", start));
  assert.match(menu, /nav\.querySelector\("a"\)/, "opening the menu leaves focus on the page behind it");
  assert.match(menu, /e\.key === "Escape" && nav\.getAttribute\("data-open"\) === "true"/, "Escape acts even when the menu is shut");
  assert.match(menu, /toggle\.focus\(\)/, "Escape drops focus instead of returning to the toggle");
});

await test("the call and chat docks move focus to their close button when they open", () => {
  const js = fs.readFileSync(path.join(process.cwd(), "public", "site.js"), "utf8");
  const opens = js.split("document.body.appendChild(dock);").slice(1);
  assert.equal(opens.length, 2, "expected the call dock and the chat dock");
  for (const after of opens) assert.match(after.slice(0, 200), /shut\.focus\(\)/, "a dock opened without moving focus into it");
});

await test("the widget's close button says what it closes and takes focus on opening", () => {
  assert.doesNotMatch(widget, /shut\.setAttribute\("aria-label", "Close"\)/, "the close button is just 'Close'");
  const after = widget.slice(widget.indexOf("document.body.appendChild(shut);"));
  assert.match(after.slice(0, 300), /shut\.focus\(\)/, "opening the widget leaves focus on the page behind it");
});

// ---------------------------------------------------------------------------
head("Voice notes");

const { voiceNoteToText, acceptsVoiceMime, VOICE_NOTE_MAX_BYTES } = await import(
  "../src/lib/webchat-voice"
);

await test("what browsers record is accepted; everything else is not", () => {
  for (const ok of ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "AUDIO/WEBM"]) {
    assert.ok(acceptsVoiceMime(ok), `${ok} refused`);
  }
  for (const no of ["text/plain", "application/json", "video/webm", "", undefined, null]) {
    assert.equal(acceptsVoiceMime(no), false, `${String(no)} accepted`);
  }
});

await test("the words come back trimmed and capped like a typed message", async () => {
  const heard = await voiceNoteToText(
    { bytes: Buffer.from("opus"), mime: "audio/webm;codecs=opus" },
    async () => "  What time   do you close on\nSaturday?  ",
  );
  assert.deepEqual(heard, { ok: true, text: "What time do you close on Saturday?" });

  const long = await voiceNoteToText(
    { bytes: Buffer.from("opus"), mime: "audio/webm" },
    async () => "a".repeat(5000),
  );
  assert.ok(long.ok && long.text.length === 1000, "a voice note got round the 1000-character ceiling");
});

await test("silence is 'empty', not a message", async () => {
  let called = 0;
  const heard = await voiceNoteToText(
    { bytes: Buffer.from("opus"), mime: "audio/webm" },
    async () => {
      called++;
      return "   ";
    },
  );
  assert.deepEqual(heard, { ok: false, reason: "empty" });
  assert.equal(called, 1);
});

await test("a recording that is too big, or not audio, never reaches the transcriber", async () => {
  let called = 0;
  const spy = async () => {
    called++;
    return "words";
  };
  const big = await voiceNoteToText({ bytes: Buffer.alloc(VOICE_NOTE_MAX_BYTES + 1), mime: "audio/webm" }, spy);
  assert.deepEqual(big, { ok: false, reason: "too-big" });
  const none = await voiceNoteToText({ bytes: Buffer.alloc(0), mime: "audio/webm" }, spy);
  assert.deepEqual(none, { ok: false, reason: "too-big" });
  const text = await voiceNoteToText({ bytes: Buffer.from("x"), mime: "text/plain" }, spy);
  assert.deepEqual(text, { ok: false, reason: "unsupported" });
  assert.equal(called, 0, "the transcriber was paid for a request that should have been refused");
});

await test("a vendor failure is 'failed', and nothing is stored", async () => {
  const heard = await voiceNoteToText({ bytes: Buffer.from("opus"), mime: "audio/webm" }, async () => {
    throw new Error("Deepgram 503");
  });
  assert.deepEqual(heard, { ok: false, reason: "failed" });
});

await test("the chat frames may ask for the microphone — for the note, never on opening", () => {
  // The widget on a customer's site, and our own chat dock.
  assert.match(widget, /panel\.allow = kind === "voice" \? "microphone; autoplay" : "microphone"/);
  const js = fs.readFileSync(path.join(process.cwd(), "public", "site.js"), "utf8");
  assert.ok(js.includes('frame.allow = "microphone"'), "our own chat dock cannot record a note");
  // And the page never asks for it until the button is held.
  const chat = fs.readFileSync(
    path.join(process.cwd(), "src", "app", "embed", "[key]", "chat", "Chat.tsx"),
    "utf8",
  );
  const asks = chat.indexOf("getUserMedia(");
  const inStart = chat.indexOf("async function startNote");
  assert.ok(asks > inStart, "the chat asks for the microphone somewhere other than when the note starts");
});

await test("the WhatsApp refusal for voice notes still stands — only the web chat transcribes", () => {
  const respond = fs.readFileSync(
    path.join(process.cwd(), "src", "lib", "reception", "respond.ts"),
    "utf8",
  );
  assert.ok(respond.includes("I can't listen to voice notes just yet"));
});

// ---------------------------------------------------------------------------
head("Our own website, continued");

// What a visitor reads, not what the source says. The comments explain the
// decision to whoever edits the file next; they are not the claim.
const visibleHtml = (file: string) =>
  fs.readFileSync(path.join(process.cwd(), "public", file), "utf8").replace(/<!--[\s\S]*?-->/g, "");

/**
 * WhatsApp for a business is a SECOND number it registers with Belline. Its
 * existing WhatsApp is never answered, so no public sentence may say Belline
 * answers, connects or takes over "your (own/existing/current) WhatsApp", or
 * name "your WhatsApp number". "Your own WhatsApp stays as it is" is the
 * honest half and is allowed.
 */
const EXISTING_WHATSAPP_CLAIM =
  /\b(?:answers?|answering|connects?|connecting|takes? over|runs?|on|into|to) (?:your|their) (?:own |existing |current |usual )?whats\s?app\b(?! stays)|\b(?:your|their) (?:existing|current|usual) whats\s?app\b(?! stays)|\b(?:your|their) (?:own )?whats\s?app (?:number|account|line)\b/i;

await test("the pattern for an existing-WhatsApp claim catches the dishonest versions and spares the honest one", () => {
  for (const bad of [
    "Belline answers your WhatsApp.",
    "Belline answers your existing WhatsApp number.",
    "It connects to your own WhatsApp in a minute.",
    "We take over your current WhatsApp.",
    "Customers message your WhatsApp number.",
  ]) assert.match(bad, EXISTING_WHATSAPP_CLAIM, bad);
  for (const good of [
    "Belline answers a second WhatsApp number you register with it.",
    "Your own WhatsApp stays as it is.",
    "Your own WhatsApp stays exactly as it is.",
  ]) assert.doesNotMatch(good, EXISTING_WHATSAPP_CLAIM, good);
});

await test("the front page says WhatsApp is available, on a second number, and never 'coming soon'", () => {
  const html = visibleHtml("landing.html");
  const card = html.slice(html.indexOf("<h3>WhatsApp for your business</h3>"));
  const body = card.slice(0, card.indexOf("</li>"));
  assert.match(body, /state-available">Available</, "the WhatsApp channel card is not marked Available");
  assert.match(body, /second WhatsApp number you register/, "the WhatsApp card does not say it is a second number");
  assert.match(body, /own WhatsApp stays as it is/, "the WhatsApp card does not say their own WhatsApp is untouched");
  assert.doesNotMatch(html, /coming soon[^<]{0,80}whats\s?app|whats\s?app[^<]{0,120}coming soon|once Meta approves|isn.t available yet/i);
  assert.doesNotMatch(html, /state-soon[^>]*>[^<]*<\/span>\s*<\/(?:figcaption|div)>[\s\S]{0,40}whats/i);
});

/**
 * The hero leads with a calendar, but connecting a calendar is not live yet.
 * Any stretch of hero text that talks about booking into a calendar must say
 * "soon" in the same sentence; the calendar card must carry the Coming soon
 * badge; and its new entry is a request waiting for the team, never booked.
 */
const CALENDAR_CLAIM = /[^.?!<>]*\bbook(?:s|ing|ed)?\b[^.?!<>]*\bcalendar\b[^.?!<>]*/gi;
const unsoonedCalendarClaims = (text: string) =>
  [...text.matchAll(CALENDAR_CLAIM)].map((m) => m[0]).filter((s) => !/\bsoon\b/i.test(s));
const heroHtml = () => {
  const html = visibleHtml("landing.html");
  const start = html.indexOf('<section class="hero">');
  return html.slice(start, html.indexOf("</section>", start));
};

await test("the pattern for a live-calendar claim catches today-tense lines and spares 'soon'", () => {
  for (const bad of [
    "Belline books straight into your calendar.",
    "It books customers into the calendar you already use.",
    "Booking directly into your Google calendar.",
  ]) assert.ok(unsoonedCalendarClaims(bad).length > 0, bad);
  for (const good of [
    "Soon, it will also book straight into the calendar you already use.",
    "Coming soon: books into your calendar",
  ]) assert.deepEqual(unsoonedCalendarClaims(good), [], good);
});

await test("the hero's calendar is marked coming soon, and no hero text says calendar booking works today", () => {
  const hero = heroHtml();
  assert.ok(hero.length > 0, "no hero section");
  const plain = hero.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  assert.match(hero, /<span class="state state-soon[^"]*">Coming soon: books into your calendar<\/span>/, "the hero calendar has lost its Coming soon badge");
  assert.deepEqual(unsoonedCalendarClaims(plain), [], "the hero says calendar booking works today");
  assert.match(plain, /\bsoon\b[^.]*calendar/i, "the hero lead no longer says the calendar is coming soon");
  // The new entry is a request for the team, and nothing in the hero is booked or confirmed.
  const entry = hero.slice(hero.indexOf('class="cal-ev cal-ev-new"'), hero.indexOf("</li>", hero.indexOf('class="cal-ev cal-ev-new"')));
  assert.ok(entry.length > 0, "the hero calendar has no new request");
  assert.match(entry, /Waiting for your team/);
  assert.doesNotMatch(plain, /\b(?:booked|confirmed)\b/i, "something in the hero reads as booked or confirmed");
  assert.doesNotMatch(hero, /state-available/, "something in the hero is marked Available");
  // Examples are labelled, and there is at most one conversation.
  assert.match(plain, /Example calendar/);
  assert.equal((hero.match(/Example conversation/g) ?? []).length, 1, "the hero should show exactly one example conversation");
  assert.doesNotMatch(hero, /demo-card|chat-thread|WhatsApp<\/span>/, "the old chat/WhatsApp cards are back in the hero");
});

await test("the channels section still shows all four channels as Available, so the hero loses nothing", () => {
  const html = visibleHtml("landing.html");
  const start = html.indexOf('<section id="channels"');
  const section = html.slice(start, html.indexOf("</section>", start));
  for (const channel of ["Your phone", "A voice button on your website", "Chat on your website", "WhatsApp for your business"]) {
    assert.ok(section.includes(`<h3>${channel}</h3>`), `the channels section has lost "${channel}"`);
  }
  assert.equal((section.match(/state-available">Available</g) ?? []).length, 4, "not every channel is marked Available");
});

await test("no public page claims a business's existing WhatsApp is answered, or voice notes on WhatsApp", () => {
  const pages = fs.readdirSync(path.join(process.cwd(), "public")).filter((f) => f.endsWith(".html"));
  const sources = [
    ...pages.map((f) => ({ file: `public/${f}`, text: visibleHtml(f) })),
    ...["site-content.ts", "build-site.ts"].map((f) => ({
      file: `scripts/${f}`,
      text: fs.readFileSync(path.join(process.cwd(), "scripts", f), "utf8"),
    })),
  ];
  for (const { file, text } of sources) {
    const plain = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    assert.doesNotMatch(plain, EXISTING_WHATSAPP_CLAIM, `${file} claims the business's existing WhatsApp is answered`);
    assert.doesNotMatch(plain, /whats\s?app[^.]{0,120}voice notes?|voice notes?[^.]{0,120}whats\s?app/i, `${file} claims voice notes on WhatsApp`);
    assert.doesNotMatch(plain, /Twilio sandbox|Belline's own Twilio/i, `${file} mentions the Twilio sandbox`);
  }
});

/**
 * The four trade pages. They are data (scripts/site-content.ts) poured into
 * one template (verticalPage in scripts/build-site.ts), so both are read: the
 * data for what the agent says, the template's visible markup for the rest.
 * Comments are stripped — they explain decisions, they are not the claim.
 */
const verticalTemplate = () => {
  const src = fs.readFileSync(path.join(process.cwd(), "scripts", "build-site.ts"), "utf8");
  const body = src.slice(src.indexOf("function verticalPage("), src.indexOf("for (const v of VERTICALS)"));
  return body.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
};

const TRADE_FORBIDDEN: [RegExp, string][] = [
  [/\b(?:books?|booking|booked) (?:straight |directly )?(?:into|against|in) (?:your|the|their) (?:real |existing )?(?:diary|calendar|book)\b/i, "books into / against a diary or calendar"],
  [/Get Belline/, "the retired CTA 'Get Belline'"],
  [/\b24\s?\/\s?7\b/, "24/7"],
  [/inside out/i, "inside out"],
  [/Nothing you book is real/i, "Nothing you book is real"],
  [/reminder texts?/i, "reminder texts"],
  [/genuinely free|real (?:table |practitioner )?availability|first refusal/i, "availability or first-refusal claims"],
];

await test("no trade page claims booking into a diary, or uses the retired lines", async () => {
  const { VERTICALS } = await import("./site-content");
  const sources = [
    { file: "scripts/site-content.ts (data)", text: JSON.stringify(VERTICALS) },
    { file: "scripts/build-site.ts (verticalPage)", text: verticalTemplate() },
  ];
  for (const { file, text } of sources) {
    for (const [pattern, what] of TRADE_FORBIDDEN) assert.doesNotMatch(text, pattern, `${file}: ${what}`);
  }
});

await test("no trade-page scene ends 'Booked' or has the agent commit to a time", async () => {
  const { VERTICALS } = await import("./site-content");
  for (const v of VERTICALS) {
    for (const scene of v.scenes) {
      assert.doesNotMatch(`${scene.label} ${scene.outcome.tag} ${scene.outcome.what}`, /\bbook(?:ed|s)?\b/i, `${v.slug} "${scene.label}" outcome says it booked`);
      for (const [who, said] of scene.turns) {
        if (who !== "agent") continue;
        assert.doesNotMatch(said, /\b(?:I've got|I can do|There's) (?:\w+day|\d|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|quarter|half)|\b(?:Done|Booked)\.|\bI can book\b/i, `${v.slug}: the agent offers or confirms a time — "${said}"`);
      }
    }
  }
});

await test("the trade pages label the demo number as international and state the real call length", () => {
  // Whitespace collapsed: the template wraps sentences across source lines.
  const html = verticalTemplate().replace(/\s+/g, " ");
  for (const at of [...html.matchAll(/tel:\+15717785920/g)].map((m) => m.index!)) {
    assert.match(html.slice(at, at + 260), /international call from the UAE/, "the +1 number is shown without saying it is an international call");
  }
  const seed = fs.readFileSync(path.join(process.cwd(), "src", "lib", "seed-belline.ts"), "utf8");
  const seconds = Number(/demo:\s*\{[\s\S]*?maxCallSeconds:\s*(\d+)/.exec(seed)![1]);
  assert.equal(seconds, 600, "the demo cap changed — update the trade pages' call length");
  assert.match(html, /up to ten minutes/, "the trade pages do not say calls last up to ten minutes");
  assert.match(html, /Connect your business/);
});

await test("the call panel's status words say request and handover, never booked", () => {
  const js = fs.readFileSync(path.join(process.cwd(), "public", "site.js"), "utf8");
  // Every assignment to the status line, plus what doneStatus() returns.
  const done = /function doneStatus\(scene\) \{([\s\S]*?)\n  \}/.exec(js);
  assert.ok(done, "site.js no longer has doneStatus()");
  const statuses = [...js.matchAll(/statusEl\.textContent = ([^;]+);/g)].map((m) => m[1]).join(" ") + " " + done[1];
  assert.doesNotMatch(statuses, /Booked|Checking the book|Transferred/, "a status still says Booked / Checking the book / Transferred");
  assert.match(statuses, /Request taken/);
  assert.match(statuses, /Passed to the team/);
  // A scene without recordings must not leave a Listen button that throws.
  assert.match(js, /listenBtn\.disabled = !/, "Listen is not disabled for a scene without audio");
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

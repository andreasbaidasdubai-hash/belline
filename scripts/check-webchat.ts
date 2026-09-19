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
import { spawnSync } from "node:child_process";

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

await test("the dashboard screen exists and is reachable from Channels", async () => {
  // This feature shipped once without a screen: the endpoint was real and the
  // only way to use it was to POST by hand. A page nobody can navigate to has
  // not shipped.
  //
  // Since 2026-09-17 the website widget is a tab of Channels, /channels/website,
  // and the setup step renders the same section. /website redirects there.
  const page = path.join(process.cwd(), "src", "app", "(app)", "channels", "website", "page.tsx");
  assert.ok(fs.existsSync(page), "no /channels/website screen");
  assert.match(fs.readFileSync(page, "utf8"), /<WebsiteSection location=\{location\} \/>/);

  const { CHANNEL_TABS } = await import("../src/lib/nav");
  assert.ok(CHANNEL_TABS.some((t) => t.href === "/channels/website"), "the screen cannot be reached from Channels");
  assert.match(fs.readFileSync(path.join(process.cwd(), "next.config.mjs"), "utf8"), /source: "\/website", destination: "\/channels\/website"/);
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

/**
 * The three ways of reaching Belline are on screen at the first paint.
 *
 * They used to wait for the hero to scroll past, so that they did not sit on
 * its example cards — which hid the call, the chat and WhatsApp at the one
 * moment every visitor is looking at the page. The cards are kept clear by
 * leaving room for the buttons in the layout instead, and this fails if the
 * waiting ever comes back.
 */
await test("the floating buttons are visible from the first paint, and the hero leaves them room", () => {
  const js = fs.readFileSync(path.join(process.cwd(), "public", "site.js"), "utf8");
  const css = fs.readFileSync(path.join(process.cwd(), "public", "site.css"), "utf8");
  assert.doesNotMatch(js, /fabs-waiting/, "site.js hides the floating buttons again");
  assert.doesNotMatch(css, /\.fabs-waiting/, "the .fabs-waiting rules are back");
  assert.doesNotMatch(
    js,
    /IntersectionObserver[\s\S]{0,400}?\.hero\b|\.hero\b[\s\S]{0,400}?IntersectionObserver/,
    "the floating buttons are watching the hero again",
  );
  // Belle rests in the hero's own column (site review, 2026-09-17), and floats only for a call: nothing big covers the page at rest.
  assert.match(css, /\.hero-video \{/, "the hero has lost Belle's column");
  assert.match(css, /\.video-bubble\.vb-float:not\(\.is-pip\) \{\s*position: fixed;/, "Belle no longer floats for a call away from the hero");
  // She is one object that travels, not a bubble and a second launcher: the
  // corner is where the flight lands her, never a copy of her (founder, 2026-09-18).
  assert.match(css, /\.video-bubble\.vb-travel \{[\s\S]*?position: fixed;/, "Belle is no longer carried to the corner");
  assert.doesNotMatch(css, /\.video-launcher\b/, "the separate floating launcher is back");
  assert.doesNotMatch(js, /video-launcher|vl-main|vl-act/, "site.js builds a second Belle again");

  // The chat opens inside the page on a phone: a sheet over it, not a takeover.
  assert.match(css, /\.chat-dock \{[\s\S]{0,600}?animation: chat-sheet-up/, "the chat is not a sheet on a phone");
  assert.doesNotMatch(css, /\.chat-dock \{\s*inset: 0;/, "the chat takes the whole screen again");
  assert.match(css, /\.chat-veil \{[\s\S]{0,400}?animation: chat-veil-in/);
  assert.match(js, /veil\.addEventListener\("click", close\)/, "there is no outside to tap");
  assert.match(js, /grab\.addEventListener\("click", close\)/);
  assert.match(js, /e\.clientY - from > 44/, "a drag down does not put the sheet away");
  // And the footer fix, which the buttons would otherwise cover at the end.
  assert.match(css, /@media \(max-width: 1100px\) \{ footer \{ padding-bottom/, "the footer no longer leaves room for the buttons");
});

/**
 * The first painted frame is the layout the page ends in.
 *
 * On a build with video live the bubble takes the corner the three floating
 * buttons had, and the hero's heading, paragraph and "Talk to Belle" button
 * go — but only once app.belline.ai's widget config has answered and
 * embed-video.js has mounted her. Until this, the page painted the other
 * layout first and took it away again: measured at 97 ms on a fast config and
 * 1.6 s on a slow one, at 1280 and at 390, with the hero's slot jumping
 * 356→438 (desktop) and 296→340 (phone) as she landed. The founder saw it on
 * both (2026-09-19).
 *
 * So the build paints the video layout, and site.js gives it up only when it
 * knows: `body.video-pending` holds Belle's slot at the live bubble's own size
 * with everything she replaces unpainted, and it comes off either as she is
 * placed or once it is certain there will be no bubble at all. None of this is
 * words, so it is markup and CSS the flag switches rather than copy.
 */
await test("with video live the page paints Belle's place from the first frame, and gives it up only once it knows", async () => {
  const { applySiteFlags } = await import("../src/lib/site-flags");
  const VIDEO = { FLAG_VIDEO_AVATAR: "on", TAVUS_API_KEY: "x", TAVUS_FACE_ID: "x", VIDEO_LLM_SECRET: "x".repeat(40) };
  for (const page of ["landing.html", "landing.de.html"]) {
    const source = fs.readFileSync(path.join(process.cwd(), "public", page), "utf8");
    const off = applySiteFlags(page, source, {});
    assert.doesNotMatch(off, /video-pending/, `${page} holds Belle's place with video off`);
    assert.doesNotMatch(off, /hero-demo has-video-hero/, `${page} makes room for a bubble with video off`);
    const on = applySiteFlags(page, source, VIDEO);
    assert.match(on, /<body class="video-pending">/, `${page} paints the old layout first with video on`);
    assert.match(on, /<div class="wrap hero-in hero-demo has-video-hero">/, `${page} does not paint Belle's column with video on`);
  }

  const css = fs.readFileSync(path.join(process.cwd(), "public", "site.css"), "utf8");
  // Everything the bubble replaces stays unpainted while her place is held.
  assert.match(
    css,
    /body\.video-pending \.wa-fab,\s*body\.video-pending \.chat-fab,\s*body\.video-pending \.bell-fab \{ display: none; \}/,
    "the floating buttons are painted before Belle takes the corner",
  );
  assert.match(
    css,
    /body\.video-pending \.hero-video \.hv-head,\s*body\.video-pending \.hero-video \.hv-text,\s*body\.video-pending \.hero-video \.hv-cta \{ display: none; \}/,
    "the hero's heading, paragraph and button are painted before the bubble takes them away",
  );
  assert.match(css, /body\.video-pending \.hero-video \.hv-face \{ width: var\(--hv-call\); \}/, "the still face is not the bubble's size");
  assert.match(css, /body\.video-pending \.hero-video \.hv-slot::after \{/, "no room is held for her row of icons");

  // The waiting circle is the resting bubble's circle, to the pixel: the same
  // expression in both files, or she changes size as she lands.
  const embed = fs.readFileSync(path.join(process.cwd(), "public", "embed-video.js"), "utf8");
  const sizes = (text: string, name: string) =>
    [...text.matchAll(new RegExp(`--${name}:\\s*(min\\([^;}"]*?\\))`, "g"))].map((m) => m[1].replace(/\s+/g, ""));
  const held = sizes(css, "hv-call");
  const real = [...sizes(embed, "bvb-call"), ...sizes(css, "bvb-call")];
  assert.ok(held.length >= 3, "the held slot has lost a breakpoint");
  assert.deepEqual([...held].sort(), [...real].sort(), "--hv-call and --bvb-call have drifted apart: Belle changes size as she lands");

  // One giving-up, both ways, and a backstop for a config that never answers.
  const js = fs.readFileSync(path.join(process.cwd(), "public", "site.js"), "utf8");
  assert.equal((js.match(/classList\.remove\("video-pending"\)/g) ?? []).length, 1, "site.js gives Belle's place up in more than one place");
  assert.match(js, /function noBubble\(\)/, "site.js has no path back to the page without a bubble");
  assert.match(js, /deadline = window\.setTimeout\(noBubble, DECIDE_MS\)/, "a config that never answers leaves the hero without its heading for good");
  assert.match(js, /\.catch\(function \(\) \{[\s\S]{0,200}?noBubble\(\);/, "a failed config leaves the page holding Belle's place");
  assert.match(js, /s\.onerror = noBubble/, "embed-video.js failing to load leaves the page holding Belle's place");
  assert.match(js, /keptFor\("bubble"\);/, "placing Belle does not give her reserved place up");
});

/**
 * Reduced motion takes the animation away, not the product.
 *
 * She used to be cornered from the first paint under
 * `prefers-reduced-motion` — a 64px face bottom right, the hero's
 * demonstration replaced by a still portrait. Windows 11 reports that query
 * whenever "Animation effects" is off, so every desktop visitor with that
 * setting (the founder among them, in Edge, 2026-09-19) met the corner and
 * never the hero, and nothing on their screen ever moved with the scroll.
 * She rests in the hero there like everybody else now, and the trip is a
 * single step between the two places rather than a flight.
 */
await test("prefers-reduced-motion steps Belle between the hero and the corner, it does not take the hero away", () => {
  const js = fs.readFileSync(path.join(process.cwd(), "public", "site.js"), "utf8");
  const css = fs.readFileSync(path.join(process.cwd(), "public", "site.css"), "utf8");
  const cornerOnly = js.slice(js.indexOf("function cornerOnly()"), js.indexOf("}", js.indexOf("function cornerOnly()")) + 1);
  assert.ok(cornerOnly.length > 0, "site.js no longer decides whether she travels");
  assert.doesNotMatch(cornerOnly, /prefers-reduced-motion/, "reduced motion corners Belle from the first paint again");
  assert.match(js, /function stepped\(\)[\s\S]{0,200}?prefers-reduced-motion/, "reduced motion no longer steps her");
  assert.match(js, /function maybeStep\(p\)/, "the step is gone");
  // A dead band, or a scroll resting on the switching point flickers her.
  assert.match(js, /if \(p >= 0\.6\) return 1;\s*if \(p <= 0\.4\) return 0;/, "the step has no dead band");
  assert.match(js, /carry\(cornerOnly\(\) \|\| small\(\) \|\| !inHero\(\) \? 1 : maybeStep\(progressNow\(\)\)\)/, "the frame is not stepped");
  // And the step is one frame: the landing transition is off under the query.
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\) \{\s*\.video-bubble\[data-vb="corner"\],\s*\.video-bubble\[data-vb="corner"\] \.bvb-row \{ transition: none; \}/,
    "the corner still animates under reduced motion",
  );
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
  // Video has no dock: the call grows inside Belle's bubble (embed-video.js), which moves focus to its own ×.
  const bubble = fs.readFileSync(path.join(process.cwd(), "public", "embed-video.js"), "utf8");
  const openCall = bubble.slice(bubble.indexOf("function openCall("), bubble.indexOf("function markReady("));
  assert.match(openCall, /state\.shut\.focus\(\)/, "the video call opened without moving focus to its close button");
});

await test("the widget's close button says what it closes and takes focus on opening", () => {
  assert.doesNotMatch(widget, /shut\.setAttribute\("aria-label", "Close"\)/, "the close button is just 'Close'");
  const after = widget.slice(widget.indexOf("document.body.appendChild(shut);"));
  assert.match(after.slice(0, 300), /shut\.focus\(\)/, "opening the widget leaves focus on the page behind it");
});

await test("a visitor on the public call never sees a vendor's raw error, and the server logs it", () => {
  // Found live: the voice vendor ran out of credits and "Speak to Belline"
  // showed "tts_error: ElevenLabs 401 … quota_exceeded" to a stranger, while
  // the production log stayed silent.
  const consoleSrc = fs.readFileSync(path.join(process.cwd(), "src", "app", "(app)", "test", "Console.tsx"), "utf8");
  assert.match(consoleSrc, /function publicCallError\(/, "no plain-language message for a failure on the public call");
  const raw = consoleSrc.indexOf("`${msg.type}: ${msg.message}`");
  assert.ok(raw > 0, "the operator console should still show the full error");
  const before = consoleSrc.slice(Math.max(0, raw - 240), raw);
  assert.match(before, /demoToken/, "the raw vendor error is shown without checking whether this is the public call");
  const session = fs.readFileSync(path.join(process.cwd(), "src", "lib", "voice", "session.ts"), "utf8");
  assert.match(session, /console\.error\(\s*"\[voice\] text-to-speech failed/, "a text-to-speech failure never reaches the server log");
});

await test("a public voice socket never receives a vendor's raw error text; the operator's does", async () => {
  // The friendly sentence on the call page was not enough: the raw ElevenLabs
  // text still travelled over /ws/demo, where anyone can read it in devtools.
  const { BrowserTransport } = await import("../src/lib/voice/transports");
  const vendor = "ElevenLabs 401: quota_exceeded, 12 credits remaining on key sk_live_abc";
  const socketFor = () => {
    const sent: string[] = [];
    return { sent, socket: { OPEN: 1, readyState: 1, send: (d: string) => sent.push(d), close() {} } };
  };
  const pub = socketFor();
  const op = socketFor();
  const publicT = new BrowserTransport(pub.socket as never, true);
  const operatorT = new BrowserTransport(op.socket as never);
  for (const type of ["tts_error", "stt_error", "error"]) {
    publicT.sendEvent({ type, message: vendor });
    operatorT.sendEvent({ type, message: vendor });
  }
  publicT.sendEvent({ type: "transcript", role: "agent", text: "Hello" });
  assert.equal(pub.sent.length, 4);
  for (const frame of pub.sent) {
    assert.ok(!frame.includes("ElevenLabs") && !frame.includes("quota") && !frame.includes("sk_live"), `a public socket saw vendor text: ${frame}`);
  }
  assert.equal(JSON.parse(pub.sent[0]).message, "voice unavailable");
  assert.equal(JSON.parse(pub.sent[3]).text, "Hello", "ordinary events changed on the public socket");
  for (const frame of op.sent) assert.equal(JSON.parse(frame).message, vendor, "the operator console lost the full error");
  // And server.ts marks the socket public exactly when nobody is signed in.
  const server = fs.readFileSync(path.join(process.cwd(), "server.ts"), "utf8");
  assert.match(server, /new BrowserTransport\(ws, !user\)/, "server.ts no longer marks the demo socket public");
  assert.match(server, /user \? event : publicEvent\(event\)/, "a failed session start sends raw error text to a public socket");
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
/** The example conversations and calendar, in "What your team gets" (they left the hero on 2026-09-17). */
const exampleHtml = () => {
  const html = visibleHtml("landing.html");
  const start = html.indexOf('<section id="stop"');
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

await test("flag off, the example calendar is marked coming soon, its entry waits for the team, and no text says calendar booking works today", () => {
  const hero = heroHtml();
  assert.ok(hero.length > 0, "no hero section");
  const heroPlain = hero.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  assert.deepEqual(unsoonedCalendarClaims(heroPlain), [], "the hero says calendar booking works today");
  assert.match(hero, /<li class="can-cal">Takes booking requests<\/li>/, "the hero's capability row does not say booking requests");
  assert.doesNotMatch(heroPlain, /\b(?:booked|confirmed)\b/i, "something in the hero reads as booked or confirmed");
  // The one demonstration in the hero is Belle; the example conversations live in "What your team gets".
  assert.match(hero, /<figure class="hero-video[^"]*"[^>]*data-hero-video/, "the hero has lost Belle's demonstration");
  assert.doesNotMatch(hero, /class="stage"|class="demo-card /, "the example card is back in the hero beside Belle");

  const example = exampleHtml();
  const plain = example.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  assert.match(example, /<span class="state state-soon[^"]*">Coming soon: books into your calendar<\/span>/, "the example calendar has lost its Coming soon badge");
  assert.deepEqual(unsoonedCalendarClaims(plain), [], "the example says calendar booking works today");
  // The new entry is a request for the team, and nothing in the example is booked or confirmed.
  const entry = example.slice(example.indexOf('class="cal-ev cal-ev-new"'), example.indexOf("</li>", example.indexOf('class="cal-ev cal-ev-new"')));
  assert.ok(entry.length > 0, "the example calendar has no new request");
  assert.match(entry, /Waiting for your team/);
  assert.doesNotMatch(plain, /\b(?:booked|confirmed)\b/i, "something in the example reads as booked or confirmed");
  assert.doesNotMatch(example, /state-available/, "something in the example is marked Available");
  // Examples are labelled: three conversations and one calendar, each saying so.
  assert.equal((example.match(/<span class="demo-example">Example conversation<\/span>/g) ?? []).length, 3, "three labelled example conversations");
  assert.equal((example.match(/<figure class="demo-card /g) ?? []).length, 3, "every conversation card should be labelled as an example");
  assert.equal((example.match(/<span class="cal-sub">Example calendar<\/span>/g) ?? []).length, 1, "one labelled example calendar");
  assert.equal((example.match(/<figure class="cal"[ >]/g) ?? []).length, 1);
  // One card with a tab per channel (site.js builds the tabs from data-tab). The calendar is a destination, not a tab.
  assert.match(example, /<div class="stage"[^>]*\sdata-tabs="Example conversations"/, "the example card lost its tabs");
  assert.deepEqual([...example.matchAll(/<figure [^>]*\bdata-tab="([^"]+)"/g)].map((m) => m[1]), ["Chat", "Phone", "WhatsApp"]);
  // One salon customer across the three channels.
  assert.equal((plain.match(/\bLayla\b/g) ?? []).length >= 4, true, "the example is not one customer across the channels");
});

await test("the example WhatsApp card is a live example conversation, not a not-live card", () => {
  const hero = exampleHtml();
  const at = hero.indexOf('class="demo-card demo-wa"');
  assert.ok(at > 0, "the hero WhatsApp card is gone");
  const card = hero.slice(at, hero.indexOf("</figure>", at));
  assert.match(card, /<span class="demo-title">WhatsApp<\/span>/);
  assert.match(card, /<span class="demo-example">Example conversation<\/span>/);
  assert.doesNotMatch(card, /Coming soon|state-soon/);
  assert.match(card, /pass that to the team/);
  assert.doesNotMatch(card, /(?:booked|confirmed) (?:you )?for|see you (?:on|at)/i);
});

await test("What Belline does: video first while video.avatar is on, then chat and voice, WhatsApp and the phone, each marked in words", async () => {
  const { applySiteFlags } = await import("../src/lib/site-flags");
  const VIDEO = { FLAG_VIDEO_AVATAR: "on", TAVUS_API_KEY: "x", TAVUS_FACE_ID: "x", VIDEO_LLM_SECRET: "x".repeat(40) };
  const sectionOf = (html: string) => {
    const start = html.indexOf('<section id="channels"');
    return html.slice(start, html.indexOf("</section>", start));
  };
  const namesOf = (section: string) => [...section.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1]);
  const off = sectionOf(visibleHtml("landing.html"));
  assert.deepEqual(namesOf(off), ["Chat and voice on your website", "WhatsApp for your business", "Your phone"]);
  assert.equal((off.match(/state-available">Available</g) ?? []).length, 3, "not every channel is marked Available");
  assert.doesNotMatch(off, /Included in every plan|early access/i);
  // Video is in every plan (founder, 2026-09-17) once it works.
  const on = sectionOf(applySiteFlags("landing.html", visibleHtml("landing.html"), VIDEO));
  assert.deepEqual(namesOf(on), ["Video receptionist on your website", "Chat and voice on your website", "WhatsApp for your business", "Your phone"]);
  assert.equal((on.match(/state-available">Included in every plan</g) ?? []).length, 1, "video is not marked included");
  assert.equal((on.match(/state-available">Available</g) ?? []).length, 3, "not every channel is marked Available");
});

await test("trade pages link only to homepage sections that exist, and their footer speaks to any business", () => {
  const build = fs.readFileSync(path.join(process.cwd(), "scripts", "build-site.ts"), "utf8");
  const ids = new Set([...visibleHtml("landing.html").matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const anchors = [...build.matchAll(/href="\/#([^"]+)"/g)].map((m) => m[1]);
  assert.ok(anchors.length > 0, "the trade-page template no longer links to any homepage section");
  for (const id of anchors) assert.ok(ids.has(id), `a trade page links to /#${id}, which the homepage does not have`);
  assert.match(build, /AI voice and chat reception for UAE businesses that take calls, messages or bookings\./);
  assert.doesNotMatch(build, /clinics, dental practices, salons, restaurants/, "the trade-page footer still names four trades");
});

await test("the homepage speaks to any business, promotes no trade page, and keeps clinics to appointment requests", () => {
  const html = visibleHtml("landing.html");
  assert.doesNotMatch(html, /id="trade"|trade-cards/, "the old trade section is back");
  assert.doesNotMatch(html, /href="\/(?:salons|restaurants|clinics|dental)"/, "the homepage links to a trade page again");
  const start = html.indexOf('<section id="for"');
  assert.ok(start >= 0, "no audience section");
  const section = html.slice(start, html.indexOf("</section>", start));
  const list = section.slice(section.indexOf('<ul class="kinds"'), section.indexOf("</ul>", section.indexOf('<ul class="kinds"')));
  const kinds = [...list.matchAll(/<li>([^<]+)<\/li>/g)].map((m) => m[1]);
  // Three use cases lead (salons, clinics, restaurants), then "And many more".
  const uses = [...section.matchAll(/<ul class="uses">[\s\S]*?<\/ul>/g)].flatMap((m) => [...m[0].matchAll(/<h3>([^<]+)<\/h3>/g)].map((h) => h[1]));
  assert.deepEqual(uses, ["Salons &amp; spas", "Clinics", "Restaurants &amp; cafés"]);
  assert.ok(uses.length + kinds.length >= 12, `only ${uses.length + kinds.length} example kinds of business`);
  assert.doesNotMatch(list, /<a\b/, "the example kinds of business are links");
  // Clinics and dental stay toned down until the health-data question is settled.
  const plain = section.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  assert.match(plain, /appointment requests only, never medical details/);
  assert.doesNotMatch(plain, /\b(?:medical|clinical) (?:advice|records|history|questions answered)\b/i);
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
  assert.match(html, /Get started/);
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
head("The integrations strip");

/**
 * Six systems, none connected when the strip was added. Google Calendar and
 * Outlook are being built, the four booking platforms need partner agreements
 * Belline does not have. The strip may say where each stands and nothing
 * more, its tags must follow the flags at build time, and it names the
 * companies as text, never with their logo files.
 */
const {
  INTEGRATIONS,
  INTEGRATIONS_HEADING,
  STATE_LABEL,
  integrationState,
  renderIntegrations,
} = await import("./site-integrations");
const { flag: flagState } = await import("../src/lib/flags");
type StripFlag = import("../src/lib/flags").FlagName;
/** The partners with researched facts behind them (integrations/partners/registry.ts). */
const { PARTNERS: PARTNER_FACTS } = await import("../src/lib/integrations/partners");

const STRIP_NAMES = ["Google Calendar", "Outlook", "Calendly", "Fresha", "SevenRooms", "OpenTable", "Treatwell", "Zenoti", "Mindbody"];
/**
 * The partner-gated systems: everything after the three Belline builds itself.
 *
 * Calendly moved out of this group on 2026-09-18. Its API is self-serve, so the
 * adapter exists (src/lib/integrations/calendly.ts) and it follows its own
 * `booking.calendly` flag rather than a `booking.partner.*` one.
 */
const PARTNERS = STRIP_NAMES.slice(3);

const stripOf = (html: string) => {
  const start = html.indexOf('<section id="connects"');
  assert.ok(start >= 0, "the landing page has no integrations strip");
  return html.slice(start, html.indexOf("</section>", start));
};

/** Each wordmark and the tag beside it, in page order. */
const tagsIn = (strip: string) =>
  [...strip.matchAll(/<span class="connect-name">([^<]+)<\/span>\s*<span class="state [^"]+">([^<]+)<\/span>/g)].map(
    (m) => [m[1], m[2]] as [string, string],
  );

const plainText = (html: string) =>
  html.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");

/**
 * A "works with" or "integrates with" sentence naming a system that is not
 * live in this build. The phrase and the name have to share a sentence, so
 * "Works with how you already work." above an unrelated list is not a claim.
 */
const connectionClaims = (text: string, notLive: string[]) =>
  [...text.matchAll(/[^.?!]*\b(?:works|integrates) with\b[^.?!]*/gi)]
    .map((m) => m[0].trim())
    .filter((sentence) => notLive.some((name) => sentence.toLowerCase().includes(name.toLowerCase())));

/** The privacy page from the same builds, by flag state. */
const builtPrivacy = new Map<"off" | "on" | "video", string>();
/** The German pages from the same builds, keyed "off de-ch", "on de-de privacy" and so on. */
const builtGerman = new Map<string, string>();

/** Build the whole site into a throwaway folder with exactly this env on top of a scrubbed one. */
function buildLanding(extra: Record<string, string>): string {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "belline-site-"));
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) {
    // Nothing from this machine may decide a flag in the test builds. TWILIO_,
    // WHATSAPP_ and the speech keys are here because `channel.phone` and the
    // WhatsApp flags are not explicit — credentials alone switch them on, and
    // they now decide the hero's eyebrow (src/lib/site-flags.ts).
    if (/^(?:FLAG_|GOOGLE_|MICROSOFT_|PARTNER_|TWILIO_|WHATSAPP_|DEEPGRAM_|ELEVENLABS_|ANTHROPIC_|CREDENTIALS_KEY$|DATABASE_URL$)/.test(k)) delete env[k];
  }
  Object.assign(env, extra, { SITE_OUT: out });
  const run = spawnSync(process.execPath, ["--import", "tsx", path.join("scripts", "build-site.ts")], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
  });
  try {
    assert.equal(run.status, 0, `the site build failed:\n${run.stdout}\n${run.stderr}`);
    const which = extra.FLAG_BOOKING_GOOGLE === "on" ? "on" : extra.FLAG_VIDEO_AVATAR === "on" ? "video" : "off";
    builtPrivacy.set(which, fs.readFileSync(path.join(out, "privacy.html"), "utf8"));
    for (const slug of ["de-de", "de-at", "de-ch"]) {
      builtGerman.set(`${which} ${slug}`, fs.readFileSync(path.join(out, slug, "index.html"), "utf8"));
      builtGerman.set(`${which} ${slug} privacy`, fs.readFileSync(path.join(out, slug, "datenschutz.html"), "utf8"));
    }
    return fs.readFileSync(path.join(out, "index.html"), "utf8");
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}

const GOOGLE_ON = {
  GOOGLE_CLIENT_ID: "test-client-id",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  CREDENTIALS_KEY: "test-credentials-key",
  FLAG_BOOKING_GOOGLE: "on",
};

/** The video receptionist on, as staging has it (flags.ts: asked for by name, with Tavus's credentials). */
const VIDEO_ON = {
  FLAG_VIDEO_AVATAR: "on",
  TAVUS_API_KEY: "x",
  TAVUS_FACE_ID: "x",
  VIDEO_LLM_SECRET: "x".repeat(40),
};

const builds = new Map<string, string>();
const built = (which: "off" | "on" | "video") => {
  if (!builds.has(which)) builds.set(which, buildLanding(which === "on" ? GOOGLE_ON : which === "video" ? VIDEO_ON : {}));
  return builds.get(which)!;
};

await test("the strip opens the booking part of the page, with its heading and all nine names, each tagged in words", () => {
  const html = visibleHtml("landing.html");
  // Page order (site review, 2026-09-17): what the team gets, then booking and integrations.
  const stopEnd = html.indexOf("</section>", html.indexOf('<section id="stop"'));
  const next = html.indexOf("<section", stopEnd);
  assert.equal(html.indexOf('<section id="connects"'), next, "the integrations strip is not the section after what the team gets");
  assert.ok(html.indexOf('<section id="connects"') < html.indexOf('<section id="works"'), "the strip is not before 'Whatever you book with'");
  // Grouped: coming soon, then the roadmap, quieter. "Connects today" only when a flag is on.
  assert.doesNotMatch(stripOf(html), /Connects today/);
  assert.match(stripOf(html), /connects-group connects-soon[\s\S]*connects-group connects-roadmap/);
  const strip = stripOf(html);
  assert.match(strip, new RegExp(`<h2 class="connects-h" id="connects-h">${INTEGRATIONS_HEADING}</h2>`));
  assert.equal(INTEGRATIONS_HEADING, "Connecting to the tools you already use");
  assert.deepEqual(INTEGRATIONS.map((i) => i.name), STRIP_NAMES);
  assert.deepEqual(tagsIn(strip).map(([name]) => name), STRIP_NAMES, "the strip does not show the nine names in order, each with a tag");
});

await test("the committed template is the flag-off strip, generated, never hand-edited", () => {
  const raw = fs.readFileSync(path.join(process.cwd(), "public", "landing.html"), "utf8").replace(/\r\n/g, "\n");
  const block = raw.slice(raw.indexOf("<!-- integrations:start"), raw.indexOf("<!-- integrations:end -->"));
  assert.ok(block.includes(renderIntegrations({})), "public/landing.html's strip differs from what a flag-off build renders");
  assert.deepEqual(tagsIn(stripOf(visibleHtml("landing.html"))), [
    ["Google Calendar", "Coming soon"],
    ["Outlook", "Coming soon"],
    ["Calendly", "Coming soon"],
    ["Fresha", "On our roadmap"],
    ["SevenRooms", "On our roadmap"],
    ["OpenTable", "On our roadmap"],
    ["Treatwell", "On our roadmap"],
    ["Zenoti", "On our roadmap"],
    ["Mindbody", "On our roadmap"],
  ]);
});

await test("built with booking.google off, Google Calendar reads Coming soon and nothing reads Available", () => {
  const tags = tagsIn(stripOf(built("off")));
  assert.deepEqual(tags, [
    ["Google Calendar", "Coming soon"],
    ["Outlook", "Coming soon"],
    ["Calendly", "Coming soon"],
    ["Fresha", "On our roadmap"],
    ["SevenRooms", "On our roadmap"],
    ["OpenTable", "On our roadmap"],
    ["Treatwell", "On our roadmap"],
    ["Zenoti", "On our roadmap"],
    ["Mindbody", "On our roadmap"],
  ]);
  assert.doesNotMatch(stripOf(built("off")), /Available|state-available/);
});

await test("built with booking.google on, Google Calendar reads Available and nothing else changes", () => {
  assert.deepEqual(tagsIn(stripOf(built("on"))), [
    ["Google Calendar", "Available"],
    ["Outlook", "Coming soon"],
    ["Calendly", "Coming soon"],
    ["Fresha", "On our roadmap"],
    ["SevenRooms", "On our roadmap"],
    ["OpenTable", "On our roadmap"],
    ["Treatwell", "On our roadmap"],
    ["Zenoti", "On our roadmap"],
    ["Mindbody", "On our roadmap"],
  ]);
  assert.match(stripOf(built("on")), /<span class="state state-available">Available<\/span>/);
  assert.match(stripOf(built("on")), /<h3 class="connects-group-h">Connects today<\/h3>\s*<ul class="connects-list">\s*<li class="connect" data-integration="booking\.google"/);
});

/**
 * The hand-written Google Calendar lines outside the strip: the hero's lead
 * and calendar badge, "Whatever you book with", and the privacy page. Each
 * reads right in both builds (src/lib/site-flags.ts).
 */
const heroOf = (html: string) => {
  const start = html.indexOf('<section class="hero">');
  return html.slice(start, html.indexOf("</section>", start));
};
/** "What your team gets", where the example conversations and calendar are. */
const exampleOf = (html: string) => {
  const start = html.indexOf('<section id="stop"');
  return html.slice(start, html.indexOf("</section>", start));
};
/** One entry of "Whatever you book with": Google Calendar and Outlook have their own. */
const bookWithOf = (html: string, name = "Google Calendar") => {
  const at = html.indexOf(`<dt>${name}</dt>`);
  return html.slice(at, html.indexOf("</div>", at));
};

await test("built with booking.google off, the hero, the example, 'Whatever you book with' and the privacy page say Google Calendar is coming", () => {
  const html = built("off");
  const hero = heroOf(html);
  assert.match(hero, /<li class="can-cal">Takes booking requests<\/li>/);
  assert.doesNotMatch(hero, /state-available cal-soon|Books into Google Calendar/);
  const example = exampleOf(html);
  assert.match(example, /<span class="state state-soon cal-soon">Coming soon: books into your calendar<\/span>/);
  assert.match(example, /<span class="cal-new-state">Waiting for your team<\/span>/);
  assert.doesNotMatch(example, /Books into Google Calendar|Confirmed|booked you in/);
  assert.match(bookWithOf(html), /Booking straight into Google Calendar is coming soon\./);
  const privacy = builtPrivacy.get("off")!;
  assert.match(privacy, /No calendar can be connected yet/);
  assert.match(privacy, /Connecting a Google Calendar is not available yet/);
});

await test("built with booking.google on, each of those lines says it works, the example books, and nothing waits beside it", () => {
  const html = built("on");
  const hero = heroOf(html);
  assert.match(hero, /<li class="can-cal">Books into Google Calendar<\/li>/);
  assert.deepEqual(
    [...plainText(hero).matchAll(/[^.?!]*\bcalendar\b[^.?!]*/gi)].map((m) => m[0]).filter((s) => /\bsoon\b/i.test(s)),
    [],
    "a hero sentence about the calendar still says soon",
  );
  const example = exampleOf(html);
  assert.match(example, /<span class="state state-available cal-soon">Books into Google Calendar<\/span>/);
  assert.doesNotMatch(example, /Coming soon: books into your calendar/);
  // Never "Books into Google Calendar" and "Waiting for your team" together.
  assert.match(example, /<span class="cal-new-state">Confirmed<\/span>/);
  assert.doesNotMatch(plainText(example), /Waiting for your team|pass that to the team/);
  assert.equal(plainText(example).split("Saturday at 10:00 is free, so I’ve booked you in.").length, 4);
  const bookWith = plainText(bookWithOf(html));
  assert.match(bookWith, /Connect Google Calendar and Belline checks it for times already taken, then books straight into it\./);
  assert.doesNotMatch(bookWith, /soon/i);
  assert.match(plainText(bookWithOf(html, "Outlook")), /Booking straight into Outlook is coming soon\./, "Outlook is not kept honest");
  const privacy = builtPrivacy.get("on")!;
  assert.doesNotMatch(privacy, /No calendar can be connected yet|Connecting a Google Calendar is not available yet/);
  assert.match(privacy, /Connecting a Google Calendar is optional\./);
  assert.match(privacy, /including the Limited Use requirements/);
  // The legal-page rule check:billing holds the templates to still holds when it is on.
  assert.doesNotMatch(privacy.replace(/<!--[\s\S]*?-->/g, ""), /\b(?:books?|booking|booked) (?:straight |directly )?(?:into|against|in) (?:your|the|their) (?:real |existing )?(?:diary|calendar)\b/i);
});

await test("the app's server re-applies the strip and the Google lines from its own flags, whatever the image was built with", async () => {
  const { pageWithFlags } = await import("../src/lib/marketing");
  // Railway builds the image without the service's variables: the built page is the flag-off one.
  const off = Buffer.from(built("off"));
  const served = pageWithFlags("index.html", off, GOOGLE_ON).toString("utf8");
  assert.deepEqual(tagsIn(stripOf(served))[0], ["Google Calendar", "Available"]);
  assert.match(heroOf(served), /Books into Google Calendar/);
  assert.match(bookWithOf(served), /books straight into it/);
  // And back: a page built with it on, served with it off.
  const back = pageWithFlags("index.html", Buffer.from(built("on")), {}).toString("utf8");
  assert.deepEqual(tagsIn(stripOf(back))[0], ["Google Calendar", "Coming soon"]);
  assert.match(exampleOf(back), /Coming soon: books into your calendar/);
  assert.match(heroOf(back), /<li class="can-cal">Takes booking requests<\/li>/);
  assert.match(bookWithOf(back), /coming soon/);
  assert.match(pageWithFlags("privacy.html", Buffer.from(builtPrivacy.get("off")!), GOOGLE_ON).toString("utf8"), /Connecting a Google Calendar is optional\./);
  // Stubs are a test harness: never a reason to tell the public it is on.
  assert.match(exampleOf(pageWithFlags("index.html", off, { FLAG_STUBS: "on", FLAG_BOOKING_GOOGLE: "on" }).toString("utf8")), /Coming soon: books into your calendar/);
});

await test("the hero names the languages Belle answers in for the page's country, from the registry and the flags, and no longer says 'Keep your number'", async () => {
  const { applySiteFlags, heroLanguages, heroLanguagesText, GERMAN_LANGUAGE_NAMES } = await import("../src/lib/site-flags");
  const { LANGUAGE_REGISTRY } = await import("../src/config/languages");
  const { pageWithFlags } = await import("../src/lib/marketing");
  const DE_ON = { FLAG_LANGUAGE_DE: "on" };
  const langsOf = (html: string) => /<span class="hero-langs" data-langs>([^<]*)<\/span>/.exec(heroOf(html))?.[1];
  // Every language has a German name, so a new live one cannot leave the German line blank.
  for (const l of LANGUAGE_REGISTRY) assert.ok(GERMAN_LANGUAGE_NAMES[l.code], `${l.code} has no German name`);
  for (const file of ["landing.html", "landing.de.html"]) {
    const raw = fs.readFileSync(path.join(process.cwd(), "public", file), "utf8");
    assert.doesNotMatch(heroOf(raw), /Keep your number|Ihre Nummer bleibt/, `${file}: the hero still says keep your number`);
    assert.equal(applySiteFlags(file, raw, {}), raw, `${file}: the committed page is not the flag-off render`);
  }
  // The UAE page: English while Arabic is a planned slot (no guards, no customer lines), whatever flags are on.
  assert.equal(LANGUAGE_REGISTRY.find((l) => l.code === "ar")!.status, "planned");
  assert.deepEqual(heroLanguages("AE", "en", {}), ["en"]);
  assert.equal(heroLanguagesText("AE", "en", DE_ON), "Answers in English.");
  assert.equal(langsOf(visibleHtml("landing.html")), "Answers in English.");
  // The German pages: German only while language.de is on, as the server serves them, both ways and Swiss spelling included.
  assert.equal(heroLanguagesText("DE", "de", {}), "Belline antwortet derzeit auf Englisch.");
  assert.equal(heroLanguagesText("DE", "de", DE_ON), "Belline antwortet auf Deutsch und Englisch.");
  for (const slug of ["de-de", "de-at", "de-ch"]) {
    const off = builtGerman.get(`off ${slug}`)!;
    assert.equal(langsOf(off), "Belline antwortet derzeit auf Englisch.", slug);
    const on = pageWithFlags(`${slug}/index.html`, Buffer.from(off), DE_ON).toString("utf8");
    assert.equal(langsOf(on), "Belline antwortet auf Deutsch und Englisch.", slug);
    assert.equal(langsOf(pageWithFlags(`${slug}/index.html`, Buffer.from(on), {}).toString("utf8")), "Belline antwortet derzeit auf Englisch.", slug);
    // A test harness never tells the public German works.
    assert.equal(langsOf(pageWithFlags(`${slug}/index.html`, Buffer.from(off), { FLAG_STUBS: "on" }).toString("utf8")), "Belline antwortet derzeit auf Englisch.", slug);
  }
  // Arabic, the day it is live and selectable (ar-AE is its UAE variant): the line is written from the list, nobody edits the page.
  const { languagesLine } = await import("../src/lib/site-flags");
  assert.ok(LANGUAGE_REGISTRY.find((l) => l.code === "ar")!.variants.some((v) => v.tag === "ar-AE"));
  assert.equal(languagesLine(["en", "ar"], "en"), "Answers in English and Arabic.");
  assert.equal(languagesLine(["de", "en", "fr"], "de"), "Belline antwortet auf Deutsch, Englisch und Französisch.");
});

await test("video.avatar: the committed pages say nothing about video; the flag-on build and the app's server lead with it, both ways", async () => {
  const { pageWithFlags } = await import("../src/lib/marketing");
  const off = built("off");
  const on = built("video");
  const videoClaims = (html: string) => plainText(html.replace(/<script[\s\S]*?<\/script>/g, "")).match(/[^.?!]*\bvideo\b[^.?!]*/gi) ?? [];
  for (const file of ["landing.html", "landing.de.html"]) {
    const raw = fs.readFileSync(path.join(process.cwd(), "public", file), "utf8");
    assert.deepEqual(videoClaims(raw), [], `public/${file} still talks about video`);
    assert.doesNotMatch(raw, /"name": "(?:Can Belle answer our website visitors on video\?|How are video minutes counted\?|Kann Belle unsere Website-Besucher per Video empfangen\?|Wie werden Videominuten gezählt\?)"/, `${file}: the structured data keeps a video question`);
  }
  assert.deepEqual(videoClaims(off), [], "the flag-off build talks about video");
  assert.doesNotMatch(off, /allow-video|data-gen="faq-video"|data-gen="video-ratio"/);
  // With the flag on: the video-first page. The eyebrow is not part of it —
  // it names the channels, not the medium (founder, f6), and with no phone or
  // WhatsApp credentials in this build it is the website alone.
  assert.match(heroOf(on), /<p class="eyebrow rise">AI receptionist for your website<\/p>/);
  assert.match(heroOf(on), /<span class="hv-title">Belle on video<\/span>/);
  assert.match(on, /<h3>Video receptionist on your website<\/h3>/);
  assert.equal(on.split('<li class="allow-video">').length, 4, "a card has no video row");
  assert.match(on, /30 voice or 12 video minutes/);
  assert.match(on, /<summary>How are video minutes counted\?<\/summary>/);
  assert.match(on, /"name": "How are video minutes counted\?"/);
  // The app's server, from its own env, whichever way the image was built: the
  // same page as a build with that flag (the integrations strip aside, which
  // the server re-renders without the build's hashed logo names).
  const same = (html: string) => html.replace(/<!-- integrations:start[\s\S]*?<!-- integrations:end -->/, "");
  assert.equal(same(pageWithFlags("index.html", Buffer.from(off), VIDEO_ON).toString("utf8")), same(on), "serving the flag-off build with video on is not the flag-on build");
  assert.equal(same(pageWithFlags("index.html", Buffer.from(on), {}).toString("utf8")), same(off), "serving the flag-on build with video off is not the flag-off build");
  for (const slug of ["de-de", "de-at", "de-ch"]) {
    const deOff = builtGerman.get(`off ${slug}`)!;
    const deOn = builtGerman.get(`video ${slug}`)!;
    assert.deepEqual(videoClaims(deOff), [], `${slug}: the flag-off build talks about video`);
    // The eyebrow no longer turns on video (founder, f6), so the German
    // flag-on page is recognised by Belle's own caption instead.
    assert.match(deOn, /<span class="hv-title">Belle per Video<\/span>/, slug);
    assert.equal(deOn.split('<li class="allow-video">').length, 4, `${slug}: a card has no video row`);
    assert.equal(same(pageWithFlags(`${slug}/index.html`, Buffer.from(deOff), VIDEO_ON).toString("utf8")), same(deOn), `${slug}: served with video on`);
    assert.equal(same(pageWithFlags(`${slug}/index.html`, Buffer.from(deOn), {}).toString("utf8")), same(deOff), `${slug}: served with video off`);
  }
});

await test("the hero's eyebrow names only the channels that are live in this environment", async () => {
  const { heroEyebrowText, applyHeroEyebrow } = await import("../src/lib/site-flags");
  const PHONE = { TWILIO_ACCOUNT_SID: "x", TWILIO_AUTH_TOKEN: "x", TWILIO_PHONE_NUMBER: "+15717785920", ANTHROPIC_API_KEY: "x", DEEPGRAM_API_KEY: "x", ELEVENLABS_API_KEY: "x" };
  const WA = { FLAG_CHANNEL_WHATSAPP_SELFSERVE: "on", WHATSAPP_ACCESS_TOKEN: "x", WHATSAPP_BUSINESS_ACCOUNT_ID: "x", CREDENTIALS_KEY: "x".repeat(64) };

  // The website is the product; the other two are claims about a connection.
  assert.equal(heroEyebrowText("en", {}), "AI receptionist for your website");
  assert.equal(heroEyebrowText("en", PHONE), "AI receptionist for your website & telephone");
  assert.equal(heroEyebrowText("en", { ...PHONE, ...WA }), "AI receptionist for your website, telephone & WhatsApp");
  assert.equal(heroEyebrowText("en", WA), "AI receptionist for your website & WhatsApp");
  assert.equal(heroEyebrowText("de", { ...PHONE, ...WA }), "KI-Empfang für Ihre Website, Telefon & WhatsApp");

  // A harness is not a connection: stubs must never put a channel on the page.
  assert.equal(heroEyebrowText("en", { FLAG_STUBS: "on" }), "AI receptionist for your website");

  // Both ways, from either page: serving a page built with the flags on, with
  // them off, puts the honest line back.
  const page = '<html lang="en-AE"><p class="eyebrow rise">AI receptionist for your website</p></html>';
  const claiming = applyHeroEyebrow(page, { ...PHONE, ...WA });
  assert.match(claiming, /telephone & WhatsApp/);
  assert.equal(applyHeroEyebrow(claiming, {}), page);
});

await test("staging serves the site with links into staging's app; production and belline.ai hosts keep app.belline.ai", async () => {
  const { pageWithFlags, pointAtThisApp } = await import("../src/lib/marketing");
  const page = Buffer.from(built("off"));
  assert.match(page.toString("utf8"), /https:\/\/app\.belline\.ai\//, "the built page no longer links to the app at all");
  const staging = pageWithFlags("index.html", page, { PUBLIC_ORIGIN: "https://belline-staging.up.railway.app" }).toString("utf8");
  assert.doesNotMatch(staging, /https:\/\/app\.belline\.ai/, "staging still sends visitors to production");
  assert.match(staging, /data-chat="https:\/\/belline-staging\.up\.railway\.app\/embed\/[^"]+\/chat"/);
  for (const env of [{}, { PUBLIC_ORIGIN: "https://app.belline.ai" }, { PUBLIC_APP_URL: "https://belline.ai" }, { PUBLIC_ORIGIN: "http://evil.example" }, { PUBLIC_ORIGIN: "not a url" }]) {
    assert.equal(pointAtThisApp("<a href=\"https://app.belline.ai/checkout\">", env), "<a href=\"https://app.belline.ai/checkout\">", JSON.stringify(env));
  }
});

await test("Outlook and each booking platform follow their own flags, and stubs never make one Available", () => {
  const byName = (name: string) => INTEGRATIONS.find((i) => i.name === name)!;
  assert.equal(byName("Outlook").flag, "booking.outlook");
  assert.equal(integrationState(byName("Outlook"), {}), "soon");
  assert.equal(
    integrationState(byName("Outlook"), {
      MICROSOFT_CLIENT_ID: "x", MICROSOFT_CLIENT_SECRET: "x", CREDENTIALS_KEY: "x", FLAG_BOOKING_OUTLOOK: "on",
    }),
    "available",
  );
  // Calendly, like the two calendars, is built rather than partner-gated.
  assert.equal(byName("Calendly").flag, "booking.calendly");
  assert.equal(integrationState(byName("Calendly"), {}), "soon");
  assert.equal(
    integrationState(byName("Calendly"), {
      CALENDLY_CLIENT_ID: "x", CALENDLY_CLIENT_SECRET: "x", CREDENTIALS_KEY: "x", FLAG_BOOKING_CALENDLY: "on",
    }),
    "available",
  );
  assert.equal(integrationState(byName("Calendly"), { FLAG_STUBS: "on", FLAG_BOOKING_CALENDLY: "on" }), "soon");
  for (const name of PARTNERS) {
    const item = byName(name);
    assert.match(item.flag, /^booking\.partner\.[a-z0-9-]+$/);
    assert.equal(integrationState(item, {}), "roadmap");
    const id = item.flag.slice("booking.partner.".length).toUpperCase().replace(/-/g, "_");
    const switched = { [`FLAG_BOOKING_PARTNER_${id}`]: "on", [`PARTNER_${id}_API_KEY`]: "k" };
    // The product flag is on: this deployment holds a key and somebody asked
    // for it, so the adapter may try. The website is a different question, and
    // a key that has not been through a partner agreement is usually a sandbox
    // key. A researched partner therefore stays on the roadmap until it is
    // live in production — see scripts/site-integrations.ts and check:partners.
    assert.equal(flagState(item.flag as StripFlag, switched), true, name);
    const researched = PARTNER_FACTS[id.toLowerCase() as keyof typeof PARTNER_FACTS];
    assert.equal(integrationState(item, switched), researched ? "roadmap" : "available", name);
  }
  // A local stubbed run switches flags on without credentials; the public site must not believe it.
  assert.equal(integrationState(byName("Google Calendar"), { FLAG_STUBS: "on", FLAG_BOOKING_GOOGLE: "on" }), "soon");
  assert.deepEqual(STATE_LABEL, { available: "Available", soon: "Coming soon", roadmap: "On our roadmap" });
});

await test("the pattern for a 'works with' claim catches a named system and spares the unrelated heading", () => {
  assert.equal(connectionClaims("Works with Fresha and OpenTable.", STRIP_NAMES).length, 1);
  assert.equal(connectionClaims("Belline integrates with Google Calendar today.", STRIP_NAMES).length, 1);
  assert.deepEqual(connectionClaims("Works with how you already work. Fresha, SevenRooms or OpenTable: keep it.", STRIP_NAMES), []);
});

await test("no page says 'Works with' or 'Integrates with' for a system that is not live in that build", () => {
  const notLiveOff = STRIP_NAMES;
  const notLiveOn = STRIP_NAMES.filter((n) => n !== "Google Calendar");
  const pages = fs.readdirSync(path.join(process.cwd(), "public")).filter((f) => f.endsWith(".html"));
  for (const f of pages) {
    assert.deepEqual(connectionClaims(plainText(visibleHtml(f)), notLiveOff), [], `public/${f}`);
  }
  assert.deepEqual(connectionClaims(plainText(built("off")), notLiveOff), [], "the flag-off build");
  assert.deepEqual(connectionClaims(plainText(built("on")), notLiveOn), [], "the flag-on build");
  // And the strip itself never uses either phrase, whatever the flags say.
  for (const html of [visibleHtml("landing.html"), built("off"), built("on")]) {
    assert.doesNotMatch(plainText(stripOf(html)), /\b(?:works?|integrates?|integrated) with\b/i);
  }
});

await test("the strip names companies in text under self-hosted icons: no external asset, nothing from their domains", () => {
  const brandHosts = /google\.|microsoft\.|outlook\.|office\.com|live\.com|fresha\.|sevenrooms\.|opentable\.|treatwell\.|zenoti\.|mindbody|calendly\.|clearbit|logo\.dev|brandfetch|simpleicons|wikimedia/i;
  for (const html of [visibleHtml("landing.html"), built("off"), built("on")]) {
    const strip = stripOf(html);
    assert.doesNotMatch(strip, /<svg\b|<picture\b|<object\b|<use\b|srcset=|style=|url\(/i, "the strip carries an image other than its icons");
    // Icons only as decoration beside the name in text, and only from the site's own /img/logos.
    const imgs = [...strip.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
    assert.equal(imgs.length, INTEGRATIONS.length, "one icon per name");
    for (const img of imgs) {
      assert.match(img, /\bsrc="\/img\/logos\/[a-z-]+(?:\.[0-9a-f]{8})?\.png"/, `icon not self-hosted: ${img}`);
      assert.match(img, /\balt=""/, `icon is not marked decorative: ${img}`);
    }
    const hrefs = [...strip.matchAll(/\bhref="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(hrefs, ["mailto:hello@belline.ai"], "the strip links somewhere other than the site's own contact address");
    // Across the whole page: no image or stylesheet reference to a logo from outside the site.
    const refs = [...html.matchAll(/\b(?:src|href|srcset|content)="([^"]+)"|url\(\s*['"]?([^'")]+)/gi)].map((m) => m[1] ?? m[2]);
    for (const ref of refs) {
      const external = /^(?:https?:)?\/\//i.test(ref) && !/^https:\/\/(?:app\.)?belline\.ai\//i.test(ref);
      if (!external) continue;
      assert.doesNotMatch(ref, /logo|\.(?:svg|png|jpe?g|webp|gif)(?:\?|$)/i, `the page references an external image: ${ref}`);
      if (!/^https:\/\/fonts\.(?:googleapis|gstatic)\.com(?:\/|$)/.test(ref)) {
        assert.doesNotMatch(ref, brandHosts, `the page references one of the companies' sites: ${ref}`);
      }
    }
  }
  // The stylesheet's strip rules draw nothing, and the six icons in img/logos are the only assets named after one of them.
  const css = fs.readFileSync(path.join(process.cwd(), "public", "site.css"), "utf8");
  const rules = css.slice(css.indexOf("/* --- Integrations strip"));
  assert.ok(rules.length > 0 && css.includes("/* --- Integrations strip"), "site.css has lost the strip's rules");
  assert.doesNotMatch(rules, /url\(/, "the strip's styles load an image");
  const files = fs.readdirSync(path.join(process.cwd(), "public"), { recursive: true }) as string[];
  const named = files
    .map((f) => f.replace(/\\/g, "/"))
    .filter((f) => /google|outlook|microsoft|fresha|seven-?rooms|open-?table|treatwell|zenoti|mindbody|calendly/i.test(f))
    .sort();
  assert.deepEqual(named, INTEGRATIONS.map((i) => `img/logos/${i.logo}`).sort(), "public/ holds a file named after one of the companies outside img/logos");
  for (const i of INTEGRATIONS) assert.ok(fs.existsSync(path.join(process.cwd(), "public", "img", "logos", i.logo)), `missing icon ${i.logo}`);
});

await test("the line under the strip asks for the missing system through the site's existing contact address", () => {
  const html = visibleHtml("landing.html");
  const strip = stripOf(html);
  assert.match(plainText(strip), /Using a booking system we don’t list yet\? Tell us \./);
  const elsewhere = html.slice(0, html.indexOf('<section id="connects"')) + html.slice(html.indexOf("</section>", html.indexOf('<section id="connects"')));
  assert.ok(elsewhere.includes('href="mailto:hello@belline.ai"'), "the strip's contact address is not one the page already uses");
});

head("The German pages");

/**
 * /de-de, /de-at and /de-ch: one German source, three builds. Belline is not
 * open in any of the three countries and answers in English, so the pages
 * must say both; must sell nothing; must not say "funktioniert mit" or
 * "integriert mit" about a system that is not live; and must not carry the
 * English page's UAE-only statements. The strip and the calendar lines follow
 * the same flags as the English page, in German.
 */
const {
  INTEGRATIONS_HEADING_DE,
  STATE_LABEL_DE,
} = await import("./site-integrations");

/** "funktioniert mit", "integriert mit", "arbeitet mit", "kompatibel mit" in a sentence naming a system that is not live. */
const connectionClaimsDe = (text: string, notLive: string[]) =>
  [...text.matchAll(/[^.?!]*\b(?:funktioniert|funktionieren|integriert|integrieren|arbeitet|kompatibel)\s+(?:\S+\s+){0,2}?mit\b[^.?!]*/gi)]
    .map((m) => m[0].trim())
    .filter((sentence) => notLive.some((name) => sentence.toLowerCase().includes(name.toLowerCase())));

/** A German sentence about booking into a calendar that does not say "bald" or "demnächst". */
const unsoonedCalendarClaimsDe = (text: string) =>
  [...text.matchAll(/[^.?!<>]*\bbuch(?:t|en|ung)?\b[^.?!<>]*\bKalender\b[^.?!<>]*/gi)].map((m) => m[0]).filter((s) => !/\b(?:bald|demnächst)\b/i.test(s));

const germanPages = () => [
  // Raw, not visibleHtml: the generated blocks' markers are comments, and the tests below need them.
  { file: "public/landing.de.html", html: fs.readFileSync(path.join(process.cwd(), "public", "landing.de.html"), "utf8") },
  ...["de-de", "de-at", "de-ch"].flatMap((slug) => [
    { file: `/${slug} (flag off)`, html: builtGerman.get(`off ${slug}`)! },
    { file: `/${slug} (flag on)`, html: builtGerman.get(`on ${slug}`)! },
  ]),
];

await test("the German patterns catch the dishonest versions and spare the honest ones", () => {
  assert.equal(connectionClaimsDe("Belline funktioniert mit Fresha und OpenTable.", STRIP_NAMES).length, 1);
  assert.equal(connectionClaimsDe("Belline ist integriert mit Google Calendar.", STRIP_NAMES).length, 1);
  assert.equal(connectionClaimsDe("Funktioniert direkt mit Treatwell.", STRIP_NAMES).length, 1);
  assert.deepEqual(connectionClaimsDe("Passt zu Ihren Abläufen. Lässt sich Belline mit Fresha verbinden? Noch nicht.", STRIP_NAMES), []);
  assert.ok(unsoonedCalendarClaimsDe("Belline bucht direkt in Ihren Kalender.").length > 0);
  assert.deepEqual(unsoonedCalendarClaimsDe("Bald kann Belline auch direkt in den Kalender buchen, den Sie schon nutzen."), []);
});

await test("built and in the source, no German page says 'funktioniert mit' or 'integriert mit' for a system that is not live", () => {
  built("off");
  built("on");
  for (const { file, html } of germanPages()) {
    const notLive = file.includes("flag on") ? STRIP_NAMES.filter((n) => n !== "Google Calendar") : STRIP_NAMES;
    assert.deepEqual(connectionClaimsDe(plainText(html), notLive), [], file);
    assert.deepEqual(connectionClaims(plainText(html), notLive), [], `${file} (English phrasing)`);
    assert.doesNotMatch(plainText(stripOf(html)), /\b(?:funktioniert|integriert|arbeitet)\b/i, `${file}: the strip claims a connection`);
  }
});

await test("the German strip follows the flags in German: Demnächst and Geplant, and Verfügbar only when a flag is on", () => {
  assert.deepEqual(STATE_LABEL_DE, { available: "Verfügbar", soon: "Demnächst", roadmap: "Geplant" });
  const source = fs.readFileSync(path.join(process.cwd(), "public", "landing.de.html"), "utf8").replace(/\r\n/g, "\n");
  assert.ok(source.slice(source.indexOf("<!-- integrations:start"), source.indexOf("<!-- integrations:end -->")).includes(renderIntegrations({}, "de")), "public/landing.de.html's strip differs from the flag-off German render");
  const expected = (google: string) => [
    ["Google Calendar", google],
    ["Outlook", "Demnächst"],
    ["Calendly", "Demnächst"],
    ...PARTNERS.map((p) => [p, "Geplant"]),
  ];
  for (const slug of ["de-de", "de-at", "de-ch"]) {
    const off = builtGerman.get(`off ${slug}`)!;
    const on = builtGerman.get(`on ${slug}`)!;
    assert.match(off, new RegExp(`<h2 class="connects-h" id="connects-h">${INTEGRATIONS_HEADING_DE}</h2>`));
    assert.deepEqual(tagsIn(stripOf(off)), expected("Demnächst"), `${slug} flag off`);
    assert.deepEqual(tagsIn(stripOf(on)), expected("Verfügbar"), `${slug} flag on`);
    assert.doesNotMatch(stripOf(off), /Coming soon|On our roadmap|Available/, `${slug}: English tags on a German page`);
  }
});

await test("the German example keeps the calendar 'Demnächst', the request waiting, and the examples labelled as translated", () => {
  for (const { file, html } of germanPages().filter((p) => !p.file.includes("flag on"))) {
    const heroPlain = heroOf(html).replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    assert.deepEqual(unsoonedCalendarClaimsDe(heroPlain), [], `${file}: the hero says calendar booking works today`);
    assert.match(heroOf(html), /<li class="can-cal">Nimmt Buchungsanfragen auf<\/li>/, `${file}: the capability row`);
    const example = exampleOf(html);
    const plain = example.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    assert.match(example, /<span class="state state-soon cal-soon">Demnächst: bucht in Ihren Kalender<\/span>/, `${file}: no Demnächst badge`);
    assert.deepEqual(unsoonedCalendarClaimsDe(plain), [], `${file}: the example says calendar booking works today`);
    assert.match(example, /Wartet auf Ihr Team/);
    assert.doesNotMatch(plain, /\b(?:gebucht|fest gebucht|reserviert|ist bestätigt|Bestätigt|eingetragen)\b/i, `${file}: something in the example reads as booked`);
    assert.doesNotMatch(example, /state-available/);
    assert.equal((example.match(/<span class="demo-example">Beispiel, übersetzt<\/span>/g) ?? []).length, 3, `${file}: examples not labelled as translated`);
  }
  for (const slug of ["de-de", "de-ch"]) {
    const html = builtGerman.get(`on ${slug}`)!;
    assert.match(heroOf(html), /Bucht in Google Calendar/, `${slug}: the flag-on capability is missing`);
    assert.match(exampleOf(html), /Bucht in Google Calendar/, `${slug}: the flag-on badge is missing`);
    assert.doesNotMatch(exampleOf(html), /Demnächst: bucht|Wartet auf Ihr Team/, `${slug}: flag on still says Demnächst or waiting`);
  }
});

await test("the German pages say Belline answers in English and is not available in DACH yet, and sell nothing", () => {
  for (const { file, html } of germanPages()) {
    const visible = html.replace(/<!--[\s\S]*?-->/g, "");
    const plain = plainText(visible);
    assert.match(plain, /Belline antwortet derzeit auf Englisch/, `${file}: the hero does not say English`);
    assert.match(plain, /Noch nicht verfügbar in Deutschland, Österreich und der Schweiz/, `${file}: the hero does not say not available`);
    assert.match(plain, /Spricht Belline Deutsch\? Noch nicht\. Belline antwortet auf Englisch/, `${file}: the FAQ does not say English`);
    assert.doesNotMatch(visible, /app\.belline\.ai\/checkout|Get started|Connect your business|Unternehmen verbinden|Start free|Kostenlos starten/, `${file}: a way to buy`);
    for (const cta of visible.matchAll(/<a class="(?:btn|nav-cta)[^"]*" href="([^"]+)"[^>]*>([^<]+)<\/a>/g)) {
      const [, href, label] = cta;
      assert.ok(href === "#warteliste" || /call\?start=1/.test(href), `${file}: "${label}" goes to ${href}`);
      if (href === "#warteliste") assert.equal(label.trim(), "Auf die Warteliste");
    }
    assert.match(visible, /id="warteliste"/, `${file}: no waitlist form to go to`);
  }
});

await test("the German pages carry none of the English page's UAE-only statements", () => {
  for (const { file, html } of germanPages()) {
    const outsidePicker = html.replace(/<!-- locale:start[\s\S]*?<!-- locale:end -->/, "");
    const plain = plainText(outsidePicker);
    assert.doesNotMatch(plain, /\bAED\b|\bUAE\b|VAE-Unternehmen|Unternehmen in den VAE|\+971|from the UAE|aus den VAE/, `${file}: a UAE-only statement`);
    // Channels are available in the UAE, not here: the tag says where.
    const channels = outsidePicker.slice(outsidePicker.indexOf('<section id="channels"'), outsidePicker.indexOf("</section>", outsidePicker.indexOf('<section id="channels"')));
    assert.doesNotMatch(channels, /state-available">Verfügbar</, `${file}: a channel is "Verfügbar" with no country`);
    // The demo line is a US number; the page says so wherever it is shown.
    for (const at of [...plain.matchAll(/\+1 571 778 5920/g)].map((m) => m.index!)) {
      assert.match(plain.slice(at, at + 160), /in die USA/, `${file}: the +1 number without saying it is a call to the USA`);
    }
  }
  const ch = builtGerman.get("off de-ch")!;
  assert.doesNotMatch(ch, /ß/, "/de-ch still writes ß");
  assert.match(ch, /<html lang="de-CH">/);
  assert.doesNotMatch(renderIntegrations({}, "de") + builtGerman.get("off de-de")!.slice(0, 0), /ß/);
});

await test("the app's server re-applies the German strip and calendar lines, Swiss spelling included", async () => {
  const { pageWithFlags } = await import("../src/lib/marketing");
  for (const slug of ["de-de", "de-ch"]) {
    const served = pageWithFlags(`${slug}/index.html`, Buffer.from(builtGerman.get(`off ${slug}`)!), GOOGLE_ON).toString("utf8");
    assert.deepEqual(tagsIn(stripOf(served))[0], ["Google Calendar", "Verfügbar"], slug);
    assert.match(heroOf(served), /Bucht in Google Calendar/, slug);
    assert.match(served, /Verbinden Sie Google Calendar, und Belline prüft dort/, slug);
    const back = pageWithFlags(`${slug}/index.html`, Buffer.from(builtGerman.get(`on ${slug}`)!), {}).toString("utf8");
    assert.match(exampleOf(back), /Demnächst: bucht in Ihren Kalender/, slug);
    const privacy = pageWithFlags(`${slug}/datenschutz.html`, Buffer.from(builtGerman.get(`off ${slug} privacy`)!), GOOGLE_ON).toString("utf8");
    assert.match(privacy, /Die Verbindung eines Google Kalenders ist optional\./, `${slug} privacy`);
  }
  // Austria too: the path decides the source, not only /de-de and /de-ch.
  const at = pageWithFlags("de-at/index.html", Buffer.from(builtGerman.get("off de-at")!), GOOGLE_ON).toString("utf8");
  assert.match(heroOf(at), /Bucht in Google Calendar/);
});

await test("the picker is on all four landing pages, before the main button, and works without JavaScript", async () => {
  const { COUNTRY_PAGES } = await import("./site-locale");
  const pages = [
    { code: "AE", html: built("off") },
    { code: "DE", html: builtGerman.get("off de-de")! },
    { code: "AT", html: builtGerman.get("off de-at")! },
    { code: "CH", html: builtGerman.get("off de-ch")! },
  ];
  for (const { code, html } of pages) {
    const nav = html.slice(html.indexOf('<nav id="site-nav"'), html.indexOf("</nav>"));
    const picker = nav.slice(nav.indexOf('<details class="locale"'), nav.indexOf("</details>"));
    assert.ok(picker.length > 0, `${code}: no picker`);
    assert.ok(nav.indexOf('<details class="locale"') < nav.indexOf('class="nav-cta"'), `${code}: the picker is not before the main button`);
    assert.match(picker, new RegExp(`<span class="locale-now">${code} · ${code === "AE" ? "English" : "Deutsch"}</span>`));
    // Every country is a real link to its page, with its currency; the current one is marked.
    for (const page of COUNTRY_PAGES) {
      assert.match(picker, new RegExp(`<a href="${page.path}" hreflang="[^"]+"[^>]*><span class="locale-code" aria-hidden="true">${page.code}</span><span class="locale-name">[^<]+</span><span class="locale-money">${page.currency}</span></a>`), `${code}: ${page.code} is not a link`);
    }
    assert.equal((picker.match(/aria-current="page"/g) ?? []).length, 2, `${code}: not exactly the current country and language marked`);
    // Only languages that exist are links; the rest are greyed, not links.
    const languages = picker.slice(picker.indexOf('id="locale-h-language"'));
    assert.equal((languages.match(/<a /g) ?? []).length, 1, `${code}: a language that does not exist is a link`);
    assert.match(languages, code === "AE" ? /<span class="locale-off"><span class="locale-name" lang="ar" dir="rtl">العربية<\/span><em>later<\/em>/ : /<span class="locale-off"><span class="locale-name" lang="en">English<\/span><em>später<\/em>/);
  }
  // The hreflang alternates name all four pages on each.
  for (const { html } of pages) {
    for (const [lang, href] of [["en", "https://belline.ai/"], ["de-DE", "https://belline.ai/de-de"], ["de-AT", "https://belline.ai/de-at"], ["de-CH", "https://belline.ai/de-ch"], ["x-default", "https://belline.ai/"]]) {
      assert.ok(html.includes(`<link rel="alternate" hreflang="${lang}" href="${href}">`), `missing hreflang ${lang}`);
    }
  }
  // site.js turns it into a real button, and closes it on Escape and outside clicks.
  const js = fs.readFileSync(path.join(process.cwd(), "public", "site.js"), "utf8");
  const block = js.slice(js.indexOf("/* --- country and language"), js.indexOf("/* --- the waitlist"));
  assert.match(block, /button\.setAttribute\("aria-expanded", "false"\)/);
  assert.match(block, /button\.setAttribute\("aria-controls", panel\.id\)/);
  assert.match(block, /e\.key !== "Escape"/);
  assert.match(block, /!wrap\.contains\(e\.target\)/);
  const templates = [visibleHtml("landing.html"), visibleHtml("landing.de.html")];
  // The sources keep every country; a build filters them by language.de.
  const { renderLocalePicker } = await import("./site-locale");
  const raw = (f: string) => fs.readFileSync(path.join(process.cwd(), "public", f), "utf8").replace(/\r\n/g, "\n");
  assert.ok(raw("landing.html").includes(renderLocalePicker("AE", COUNTRY_PAGES)), "public/landing.html's picker is not the generated one");
  assert.ok(raw("landing.de.html").includes(renderLocalePicker("DE", COUNTRY_PAGES)), "public/landing.de.html's picker is not the generated one");
  assert.ok(templates.every((t) => t.includes('<details class="locale"')));
});

head("The chat link: a channel with no website");

{
  const { upsertLocation } = await import("../src/lib/store");
  const link = await import("../src/lib/chat-link");
  const { channelStatuses, journey, answersRealCustomers } = await import("../src/lib/onboarding/journey");
  const src = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), "utf8");

  const made = await signUp({
    businessName: "Link Only Lashes",
    email: "owner@linkonlylashes.ae",
    password: "Correct-Horse-Battery-9",
    timezone: "Asia/Dubai",
    vertical: "salon",
  });
  if (!made.ok) throw new Error("could not create the link venue");
  const id = made.location.id;
  const fresh = () => getLocation(id)!;
  upsertLocation({ ...fresh(), businessPhone: "+97145550123" });

  await test("making the link is idempotent, uses its own key, and resolves as a link — never as the widget", () => {
    const first = link.ensureChatLink(fresh(), "usr_owner");
    const again = link.ensureChatLink(fresh(), "usr_owner");
    assert.ok(first.chatLink?.key.startsWith("bc_"));
    assert.equal(again.chatLink!.key, first.chatLink!.key, "a second press made a second link");
    assert.notEqual(first.chatLink!.key, fresh().embed?.key);
    assert.deepEqual(link.findChatVenue(first.chatLink!.key)?.via, "link");
    assert.equal(link.findChatVenue(first.chatLink!.key)?.location.id, id);
    assert.equal(link.findChatVenue("bc_nothing"), null);
    assert.equal(link.chatLinkUrl(fresh(), "https://app.belline.ai"), `https://app.belline.ai/c/${first.chatLink!.key}`);
    // The page 404s a widget key: the widget only opens inside the sites it names.
    assert.match(src("src", "app", "c", "[key]", "page.tsx"), /if \(!found \|\| found\.via !== "link"\) notFound\(\);/);
  });

  await test("before the venue is live it does not answer, and says nothing about the venue", () => {
    assert.equal(answersRealCustomers(fresh()), false);
    const page = link.linkPageState(fresh(), false);
    assert.equal(page.kind, "refused");
    const said = page.kind === "refused" ? page.message : "";
    assert.equal(said, link.LINK_NOT_LIVE);
    for (const leak of [fresh().name, "Link Only", fresh().agent.displayName, fresh().businessPhone, "4555", "salon", "Dubai"]) {
      assert.ok(!said.toLowerCase().includes(String(leak).toLowerCase()), `the not-live page leaked "${leak}"`);
    }
    // The page's title and robots name nothing either, and the page only opens through the same gate as the widget.
    const pageSrc = src("src", "app", "c", "[key]", "page.tsx");
    assert.match(pageSrc, /title: "Chat",\s*robots: \{ index: false, follow: false \}/);
    assert.match(pageSrc, /linkPageState\(location, await widgetOpenFor\(location\)\)/);
    // Every turn goes through the web chat's own resolver, which refuses a venue that is not open.
    const turn = src("src", "lib", "webchat-turn.ts");
    assert.match(turn, /const found = findChatVenue\(key\);/);
    assert.match(turn, /if \(!\(await open\(location\)\)\) \{\s*return NextResponse\.json\(\{ error: "Chat is not available here\." \}, \{ status: 404 \}\);/);
    assert.match(turn, /chatGate\(location, \{ via \}\)/);
  });

  await test("it counts as a channel for going live, and is waiting, not live, until Go live", () => {
    const j = journey(fresh());
    assert.ok(j.steps.find((s) => s.id === "phone")!.done, "the chat link did not count as a channel");
    // One way in is enough: the website step is optional, and neither blocks Go live.
    assert.ok(j.steps.find((s) => s.id === "website")!.optional);
    assert.ok(!j.blockers.some((b) => b.step === "website" || b.step === "phone"));
    assert.equal(channelStatuses(fresh()).find((c) => c.id === "link")!.state, "waiting");
    const o = fresh().onboarding!;
    upsertLocation({ ...fresh(), onboarding: { ...o, activatedAt: "2026-09-16T09:00:00.000Z" } });
    assert.equal(channelStatuses(fresh()).find((c) => c.id === "link")!.state, "live");
    assert.equal(link.linkPageState(fresh(), true).kind, "chat");
  });

  await test("once live, the venue's daily conversation ceiling applies, shared with the widget", () => {
    upsertLocation({ ...fresh(), embed: { enabled: false, key: "be_link_only", mode: "chat", allowedOrigins: [], maxChatsPerDay: 3 } as never });
    assert.equal(chatGate(fresh(), { via: "link" }).allowed, true);
    for (let i = 0; i < 3; i++) {
      const c = startCall(fresh(), "webchat", "Website");
      saveCall({ ...c, transcript: [] });
    }
    const gate = chatGate(fresh(), { via: "link" });
    assert.equal(gate.allowed, false, "the link went past the day's ceiling");
    const page = link.linkPageState(fresh(), true);
    assert.equal(page.kind, "refused");
    // The widget, switched off here, is not a way in, and the link is not a way round its ceiling.
    assert.equal(chatGate(fresh()).allowed, false);
  });

  await test("once live, the trial's text conversations stop it like the widget, and the visitor hears nothing about money", async () => {
    const other = await signUp({ businessName: "Link Trial Nails", email: "owner@linktrial.ae", password: "Correct-Horse-Battery-9", timezone: "Asia/Dubai", vertical: "salon" });
    if (!other.ok) throw new Error("could not create the trial venue");
    const v = () => getLocation(other.location.id)!;
    const o = v().onboarding!;
    upsertLocation({ ...link.ensureChatLink(v()), onboarding: { ...o, activatedAt: "2026-09-16T09:00:00.000Z" }, embed: { enabled: false, key: "be_link_trial", mode: "chat", allowedOrigins: [], maxChatsPerDay: 1000 } as never });
    const allowance = v().subscription!.trial!.conversations ?? 50;
    for (let i = 0; i < allowance; i++) {
      const c = startCall(v(), "webchat", "Website");
      const at = new Date(Date.now() - 60_000).toISOString();
      saveCall({ ...c, transcript: [{ role: "caller", text: "Hi", at } as never, { role: "agent", text: "Hello", at } as never] });
    }
    const gate = chatGate(v(), { via: "link" });
    assert.equal(gate.allowed, false, "the trial's conversations did not stop the link");
    assert.doesNotMatch(gate.message ?? "", /trial|plan|pay|subscri|charge|AED/i);
    assert.equal(link.linkPageState(v(), true).kind, "refused");
  });

  await test("the channels step and the Channels screen show it with a copy button, behind a signed-in owner's route", () => {
    const step = src("src", "app", "setup", "[step]", "page.tsx");
    // Both render the same section, which holds the card.
    const screen = src("src", "app", "(app)", "channels", "sections.tsx");
    const card = src("src", "app", "(app)", "channels", "ChatLinkCard.tsx");
    assert.match(step, /<LinkSection location=\{venue\}/);
    assert.match(src("src", "app", "(app)", "channels", "link", "page.tsx"), /<LinkSection location=\{location\}/);
    assert.match(screen, /<ChatLinkCard locationId=\{location\.id\} url=\{chatLinkUrl\(location\)\}/);
    assert.match(card, /navigator\.clipboard\.writeText\(url\)/);
    assert.match(card, /Copy link/);
    const route = src("src", "app", "api", "chat-link", "route.ts");
    assert.match(route, /requireApiUser\(\)/);
    assert.match(route, /canEditAgent\(user, location\.id\)/);
    // The same conversation code as the widget: the page is the widget's Chat, posting to the web chat routes.
    assert.match(src("src", "app", "c", "[key]", "page.tsx"), /import Chat from "@\/app\/embed\/\[key\]\/chat\/Chat";/);
    assert.match(src("src", "app", "embed", "[key]", "chat", "Chat.tsx"), /fetch\(`\/api\/webchat\/\$\{encodeURIComponent\(embedKey\)\}`/);
  });
}

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

// ---------------------------------------------------------------------------
head("Belle's chat on belline.ai: who she is, and what to ask");

{
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  (globalThis as { React?: unknown }).React = React;
  const { default: Chat } = await import("../src/app/embed/[key]/chat/Chat");
  const { starterPromptsFor, connectedWhatsAppLink, widgetConfig } = await import("../src/lib/embed");
  const { bellineVenue } = await import("../src/lib/seed-belline");
  const render = (props: Record<string, unknown>) =>
    renderToStaticMarkup(
      React.createElement(Chat, { embedKey: "k", freshToken: "t", venueName: "Belline", agentName: "Belle", ...props } as never),
    );

  await test("Belline's venue has an opener that says who Belle is, and exactly three starter prompts", () => {
    assert.deepEqual(bellineVenue.agent.starterPrompts, [
      "What does Belline cost?",
      "How does setup work?",
      "Show me how you'd answer a salon customer",
    ]);
    const opener = bellineVenue.agent.chatGreeting ?? "";
    assert.match(opener, /Belle/);
    assert.match(opener, /AI receptionist/);
    assert.doesNotMatch(opener, /book/i, "the belline.ai opener still asks what the visitor would like to book");
  });

  await test("starter prompts are a generic per-venue feature: none unless seeded, three at most, cleaned", () => {
    assert.deepEqual(starterPromptsFor({}), []);
    assert.deepEqual(starterPromptsFor({ starterPrompts: "nope" }), []);
    assert.deepEqual(starterPromptsFor({ starterPrompts: [" a ", "", "a", 4, "b", "c", "d"] }), ["a", "b", "c"]);
    assert.deepEqual(starterPromptsFor({ starterPrompts: ["x".repeat(81)] }), []);
    const seeded = fs.readFileSync(path.join(process.cwd(), "src", "lib", "seed.ts"), "utf8");
    assert.equal((seeded.match(/starterPrompts:/g) ?? []).length, 1, "a venue other than Belline's is seeded with starter prompts");
    const page = fs.readFileSync(path.join(process.cwd(), "src", "app", "embed", "[key]", "chat", "page.tsx"), "utf8");
    // Belle on Belline's own app pages shows that page's questions instead
    // (belle/knowledge.ts PAGE_STARTERS); every widget still reads the venue's.
    assert.match(page, /starterPrompts=\{hint \? PAGE_STARTERS\[hint\.page\] : starterPromptsFor\(location\.agent\)\}/);
  });

  await test("the chips show until the first message, and a tapped chip sends its own words", () => {
    const withChips = render({ starterPrompts: starterPromptsFor(bellineVenue.agent), opener: bellineVenue.agent.chatGreeting });
    const chips = [...withChips.matchAll(/<button type="button" class="bl-starter">([^<]+)<\/button>/g)].map((m) => m[1].replace(/&#x27;/g, "'"));
    assert.deepEqual(chips, bellineVenue.agent.starterPrompts);
    assert.ok(withChips.includes("Belline&#x27;s AI receptionist"), "the venue's own opener is not shown");
    assert.doesNotMatch(withChips, /tell me what you(&#x27;|&rsquo;|’)d\s+like to book/);
    // A venue without prompts: no chips, and the generic opener as before.
    const plain = render({});
    assert.doesNotMatch(plain, /class="bl-starter"/);
    assert.match(plain, /like to book/);
    const src = fs.readFileSync(path.join(process.cwd(), "src", "app", "embed", "[key]", "chat", "Chat.tsx"), "utf8");
    assert.match(src, /starterPrompts\.length > 0 && lines\.length === 0 && !busy/, "the chips do not hide after the first message");
    assert.match(src, /onClick=\{\(\) => void send\(prompt\)\}/, "a chip does not send its prompt");
    assert.match(src, /const text = \(said \?\? draft\)\.trim\(\)/);
  });

  await test("asked to show a salon customer, Belle frames a role-play, and the booking guards still hold", () => {
    const policies = bellineVenue.agent.policies.join("\n");
    assert.match(policies, /role-play example with a made-up business/);
    assert.match(policies, /never offer or name a time or date/);
    assert.match(policies, /You do not book anything on this line, and you never offer, suggest or name a time or date/);
  });

  await test("Belle says live transfer is on Growth and Scale, as the catalogue does", async () => {
    const { PRODUCTS } = await import("../src/lib/billing/plans");
    const has = (id: string) => PRODUCTS.find((p) => p.id === id)!.features.some((f) => /urgent calls through/.test(f.text));
    assert.equal(has("v2_starter"), false);
    assert.equal(has("v2_growth") && has("v2_scale"), true);
    const transfer = bellineVenue.agent.faqs.find((f) => /transfer a call/.test(f.q))!;
    assert.match(transfer.a, /Growth and Scale/);
    assert.match(bellineVenue.agent.policies.join("\n"), /urgent calls through to the team live on the Growth and Scale plans/);
    const setup = fs.readFileSync(path.join(process.cwd(), "src", "app", "setup", "StepActions.tsx"), "utf8");
    assert.match(setup, /On the Growth and Scale plans, Belline puts urgent calls through/);
  });

  await test("/call with the microphone refused or missing: guidance, Retry, and Chat with Belle instead", async () => {
    const src = fs.readFileSync(path.join(process.cwd(), "src", "app", "(app)", "test", "Console.tsx"), "utf8");
    assert.match(src, /setMicProblem\(micProblemOf\(err\)\)/, "a refused microphone is not recorded as a problem to explain");
    assert.match(src, /name === "NotAllowedError" \|\| name === "SecurityError"/);
    const block = src.slice(src.indexOf('className="callbar-mic"'), src.indexOf("</div>\n        ) : (", src.indexOf('className="callbar-mic"')));
    assert.match(block, /call\.mic_blocked_help/);
    assert.match(block, /call\.mic_missing_help/);
    assert.match(block, /onClick=\{retryMicrophone\}/);
    assert.match(block, /call\.chat_instead/);
    const { CALL_KEYS, copyTable } = await import("../src/lib/customer-copy");
    for (const key of ["call.mic_blocked", "call.mic_blocked_help", "call.mic_missing", "call.mic_missing_help", "call.retry", "call.chat_instead"]) {
      assert.ok((CALL_KEYS as readonly string[]).includes(key), `${key} is not handed to the call button`);
    }
    assert.equal(copyTable("en", CALL_KEYS)["call.chat_instead"].replace("{name}", "Belle"), "Chat with Belle instead");
    assert.match(copyTable("en", CALL_KEYS)["call.mic_blocked_help"], /allow the microphone/);
    const page = fs.readFileSync(path.join(process.cwd(), "src", "app", "call", "page.tsx"), "utf8");
    assert.match(page, /chatInsteadHref=\{`\$\{siteOrigin\(\)\}\/\?chat=1`\}/);
  });

  head("The WhatsApp link only for a connected number");

  await test("no connected number, no link — whatever WHATSAPP_NUMBER says", () => {
    const had = process.env.WHATSAPP_NUMBER;
    process.env.WHATSAPP_NUMBER = "+971500000000";
    try {
      assert.equal(connectedWhatsAppLink(null), null);
      assert.equal(connectedWhatsAppLink(undefined), null);
      assert.equal(connectedWhatsAppLink({ phoneE164: "+971501234567", status: "paused", channel: "whatsapp" }), null);
      assert.equal(connectedWhatsAppLink({ phoneE164: "+971501234567", status: "active", channel: "sms" }), null);
      assert.equal(connectedWhatsAppLink({ phoneE164: "", status: "active", channel: "whatsapp" }), null);
      assert.equal(connectedWhatsAppLink({ phoneE164: "+971501234567", status: "active", channel: "whatsapp" }), "https://wa.me/971501234567");
      const cfg = widgetConfig({ key: "k", enabled: true, allowedOrigins: [] } as never, connectedWhatsAppLink(null));
      assert.equal(cfg.whatsappLink, null);
    } finally {
      if (had === undefined) delete process.env.WHATSAPP_NUMBER;
      else process.env.WHATSAPP_NUMBER = had;
    }
  });

  await test("the config route for belline.ai reports null WhatsApp without a connection, even with the number in the environment", async () => {
    const had = process.env.WHATSAPP_NUMBER;
    process.env.WHATSAPP_NUMBER = "+971500000000";
    try {
      const { GET } = await import("../src/app/api/embed/[key]/config/route");
      const res = await GET(new Request("http://localhost/api/embed/be_belline_site/config"), { params: Promise.resolve({ key: "be_belline_site" }) });
      const body = (await res.json()) as { live?: boolean; whatsappLink?: string | null };
      assert.notEqual(body.live, false, "Belline's own widget is not live, so this proves nothing");
      assert.equal(body.whatsappLink, null, "the WhatsApp icon would show with no connected number");
      const src = fs.readFileSync(path.join(process.cwd(), "src", "app", "api", "embed", "[key]", "config", "route.ts"), "utf8");
      assert.match(src, /const link = venueWhatsAppLink\(location, account\);/);
      assert.doesNotMatch(src, /[^e]WhatsAppLink\(|whatsappLink\(/, "the route still falls back to the environment's number");
    } finally {
      if (had === undefined) delete process.env.WHATSAPP_NUMBER;
      else process.env.WHATSAPP_NUMBER = had;
    }
  });

  await test("SITE_WHATSAPP_NUMBER links belline.ai's own WhatsApp without a local connection, and no customer venue's", async () => {
    const { venueWhatsAppLink } = await import("../src/lib/embed");
    const site = { id: "loc_belline", embed: { key: "be_belline_site" } };
    const env = { SITE_WHATSAPP_NUMBER: "+971 50 123 4567" };
    const connected = { phoneE164: "+971509999999", status: "active", channel: "whatsapp" };
    assert.equal(venueWhatsAppLink(site, null, env), "https://wa.me/971501234567");
    assert.equal(venueWhatsAppLink(site, connected, env), "https://wa.me/971509999999", "a connected number comes first");
    assert.equal(venueWhatsAppLink(site, null, {}), null);
    assert.equal(venueWhatsAppLink(site, null, { SITE_WHATSAPP_NUMBER: "0501234567" }), null, "not E.164");
    // Customers still need their own connected, active number.
    assert.equal(venueWhatsAppLink({ id: "loc_salon", embed: { key: "be_salon" } }, null, env), null);
    assert.equal(venueWhatsAppLink({ id: "loc_salon", embed: { key: "be_belline_site" } }, null, env), null);
    assert.equal(venueWhatsAppLink({ id: "loc_belline", embed: { key: "be_other" } }, null, env), null);
    assert.equal(venueWhatsAppLink({ id: "loc_salon", embed: { key: "be_salon" } }, { ...connected, status: "paused" }, env), null);
    // Through the route belline.ai's widget fetches.
    const had = process.env.SITE_WHATSAPP_NUMBER;
    process.env.SITE_WHATSAPP_NUMBER = "+971501234567";
    try {
      const { GET } = await import("../src/app/api/embed/[key]/config/route");
      const res = await GET(new Request("http://localhost/api/embed/be_belline_site/config"), { params: Promise.resolve({ key: "be_belline_site" }) });
      const body = (await res.json()) as { whatsappLink?: string | null };
      assert.equal(body.whatsappLink, "https://wa.me/971501234567");
      const page = fs.readFileSync(path.join(process.cwd(), "src", "app", "whatsapp", "page.tsx"), "utf8");
      assert.match(page, /venueWhatsAppLink\(venue, account\)/, "/whatsapp and the widget config disagree");
    } finally {
      if (had === undefined) delete process.env.SITE_WHATSAPP_NUMBER;
      else process.env.SITE_WHATSAPP_NUMBER = had;
    }
  });

  await test("a sandbox or test WhatsApp connection is never the public button, and a Meta number is preferred over one", async () => {
    const { venueWhatsAppLink, connectedWhatsAppLink } = await import("../src/lib/embed");
    const { isSandboxWhatsApp, TWILIO_WHATSAPP_SANDBOX } = await import("../src/lib/whatsapp");
    const site = { id: "loc_belline", embed: { key: "be_belline_site" } };
    const salon = { id: "loc_salon", embed: { key: "be_salon" } };

    // Twilio's shared sandbox: active, connected, and still not publishable.
    const sandbox = { phoneE164: TWILIO_WHATSAPP_SANDBOX, status: "active", channel: "whatsapp", provider: "twilio" };
    assert.equal(isSandboxWhatsApp(sandbox, {}), true);
    assert.equal(connectedWhatsAppLink(sandbox, {}), null, "the Twilio sandbox became the public button");
    assert.equal(venueWhatsAppLink(site, sandbox, {}), null, "belline.ai published the sandbox — this is what happened");
    assert.equal(venueWhatsAppLink(salon, sandbox, {}), null);

    // A test number this server was given, whatever it is: TWILIO_WHATSAPP_FROM
    // is the only variable here that ever connects an unverified number.
    const tested = { phoneE164: "+14155550123", status: "active", channel: "whatsapp", provider: "twilio" };
    const env = { TWILIO_WHATSAPP_FROM: "+1 415 555 0123" };
    assert.equal(isSandboxWhatsApp(tested, env), true);
    assert.equal(connectedWhatsAppLink(tested, env), null);
    assert.equal(connectedWhatsAppLink(tested, {}), "https://wa.me/14155550123", "not a test number on a server that names none");

    // Nor from the environment: SITE_WHATSAPP_NUMBER cannot smuggle it in either.
    assert.equal(venueWhatsAppLink(site, null, { SITE_WHATSAPP_NUMBER: TWILIO_WHATSAPP_SANDBOX }), null);

    // A real Meta number is untouched.
    const meta = { phoneE164: "+971509999999", status: "active", channel: "whatsapp", provider: "meta" };
    assert.equal(isSandboxWhatsApp(meta, env), false);
    assert.equal(connectedWhatsAppLink(meta, env), "https://wa.me/971509999999");

    // And the pick itself: a venue with both rows active hands over the Meta one.
    const whats = fs.readFileSync(path.join(process.cwd(), "src", "lib", "whatsapp.ts"), "utf8");
    const pick = whats.slice(
      whats.indexOf("export async function venueWhatsApp("),
      whats.indexOf("export const TWILIO_WHATSAPP_SANDBOX"),
    );
    assert.match(pick, /active\.find\(\(a\) => a\.provider === "meta"\)/, "the venue's number is whichever row sorts first again");
    assert.match(pick, /active\.find\(\(a\) => !isSandboxWhatsApp\(a\)\)/);
  });

  await test("/whatsapp without a connection explains and offers the chat and getting started, not a dead end", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "src", "app", "whatsapp", "page.tsx"), "utf8");
    assert.match(src, /venueWhatsAppLink\(venue, account\)/, "the page decides on something other than a real connection");
    assert.doesNotMatch(src, /whatsappConfigured\(/);
    assert.match(src, /\$\{site\}\/\?chat=1/);
    assert.match(src, /href="\/checkout"/);
    assert.match(src, /Chat with Belle on the website/);
    assert.match(src, /Get started/);
    const plain = src.replace(/&rsquo;/g, "’").replace(/\s+/g, " ");
    assert.match(plain, /second number you register with it/);
    assert.doesNotMatch(plain, EXISTING_WHATSAPP_CLAIM);
    assert.doesNotMatch(plain, /Not on WhatsApp yet/);
  });
}

console.log(
  failed === 0
    ? `\n\x1b[32m✓ ${passed} passed, 0 failed\x1b[0m\n`
    : `\n\x1b[31m✗ ${passed} passed, ${failed} failed\x1b[0m\n`,
);
process.exit(failed === 0 ? 0 : 1);

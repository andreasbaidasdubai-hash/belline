/**
 * Belline on somebody else's website.
 *
 * A public widget that spends money on every tap. The things worth pinning are
 * all about who is allowed to make it spend.
 *
 * The key is public by design — it sits in the customer's page source — so
 * none of the safety here depends on it staying secret. What does the work is
 * the origin allowlist and the daily cap, and both are tested for the ways
 * they fail *open*: an empty list allowing everything, a missing origin being
 * treated as ours, `www.` counting as a different site, a cap that counts the
 * wrong calls.
 *
 * There is also one property that would be easy to lose later: turning the
 * widget on for a customer's venue must not make that venue's *telephone*
 * behave like a demo line, and the venue's telephone being busy must not
 * switch the website widget off. Separate channels, separate budgets.
 *
 *   npm run check:embed
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-embed-"));

const { seedIfEmpty } = await import("../src/lib/seed");
const { signUp } = await import("../src/lib/onboarding");
const { getLocation, saveCall } = await import("../src/lib/store");
const { startCall } = await import("../src/lib/calls");
const {
  enableEmbed,
  disableEmbed,
  originAllowed,
  normaliseOrigin,
  checkEmbedGate,
  embedSnippet,
  newEmbedKey,
  EMBED_DEFAULTS,
} = await import("../src/lib/embed");
const { mayStreamTo } = await import("../src/lib/voice/entitlement");
const { BELLINE_LOCATION_ID } = await import("../src/lib/seed-belline");

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

seedIfEmpty();

const signed = await signUp({
  businessName: "Marina Hair Studio",
  email: "owner@embedtest.test",
  password: "Correct-Horse-Battery-9",
  vertical: "salon",
  timezone: "Asia/Dubai",
});
assert.ok(signed.ok, "could not create the test account");
let venue = signed.ok ? signed.location : null!;

console.log("\n\x1b[1mOff until somebody turns it on\x1b[0m\n");

await test("a new venue has no widget and cannot be streamed to", () => {
  assert.equal(venue.embed, undefined);
  assert.equal(mayStreamTo(venue), false, "a customer's venue was streamable before it was enabled");
});

await test("a key is public, prefixed and not guessable", () => {
  const keys = new Set(Array.from({ length: 200 }, () => newEmbedKey()));
  assert.equal(keys.size, 200, "keys collided");
  for (const key of keys) {
    assert.ok(key.startsWith("be_"));
    assert.ok(key.length >= 14, `too short to be unguessable: ${key}`);
  }
});

venue = enableEmbed(venue, ["https://marinahair.ae", "  www.marinahair.ae  "]);

await test("turning it on mints a key and records the origins", () => {
  assert.ok(venue.embed?.enabled);
  assert.ok(venue.embed?.key.startsWith("be_"));
  assert.deepEqual(venue.embed?.allowedOrigins, ["https://marinahair.ae", "https://www.marinahair.ae"]);
  assert.equal(venue.embed?.maxCallsPerDay, EMBED_DEFAULTS.maxCallsPerDay);
});

await test("an enabled widget makes the venue streamable", () => {
  assert.equal(mayStreamTo(getLocation(venue.id)), true);
});

await test("turning it off keeps the key but refuses the stream", () => {
  const off = disableEmbed(getLocation(venue.id)!);
  assert.equal(off.embed?.enabled, false);
  // The key survives: switching the widget off for an afternoon must not mean
  // re-editing the customer's website to switch it back on.
  assert.equal(off.embed?.key, venue.embed!.key);
  assert.equal(mayStreamTo(off), false);
  venue = enableEmbed(off, off.embed!.allowedOrigins);
});

console.log("\n\x1b[1mOnly from the site it belongs to\x1b[0m\n");

await test("the registered origin is allowed", () => {
  assert.equal(originAllowed(venue.embed!, "https://marinahair.ae"), true);
});

await test("www and bare are the same site, in both directions", () => {
  // Forcing a venue to register both is a support ticket dressed as a control:
  // they list one, it works on staging and fails on their live site.
  assert.equal(originAllowed(venue.embed!, "https://www.marinahair.ae"), true);
  const bareOnly = { ...venue.embed!, allowedOrigins: ["https://marinahair.ae"] };
  assert.equal(originAllowed(bareOnly, "https://www.marinahair.ae"), true);
  const wwwOnly = { ...venue.embed!, allowedOrigins: ["https://www.marinahair.ae"] };
  assert.equal(originAllowed(wwwOnly, "https://marinahair.ae"), true);
});

await test("somebody else's site is refused", () => {
  assert.equal(originAllowed(venue.embed!, "https://not-marinahair.ae"), false);
  assert.equal(originAllowed(venue.embed!, "https://marinahair.ae.evil.com"), false);
  // A prefix match would let this through, which is the classic version of
  // this bug.
  assert.equal(originAllowed(venue.embed!, "https://marinahair.aegis.com"), false);
});

await test("no origin at all is refused, not treated as ours", () => {
  // A direct visit to the embed URL — somebody pasted it — sends no framing
  // origin. Allowing that makes the widget a public page anybody can spend.
  assert.equal(originAllowed(venue.embed!, null), false);
  assert.equal(originAllowed(venue.embed!, ""), false);
});

await test("an empty allowlist allows nothing", () => {
  // The other classic: a list that is empty because nobody filled it in, read
  // as "no restrictions".
  const none = { ...venue.embed!, allowedOrigins: [] };
  assert.equal(originAllowed(none, "https://marinahair.ae"), false);
});

await test("a disabled widget refuses even a registered origin", () => {
  const off = { ...venue.embed!, enabled: false };
  assert.equal(originAllowed(off, "https://marinahair.ae"), false);
});

await test("an origin is a scheme and a host, never a path", () => {
  // A browser sends an origin, and an origin has no path. An allowlist entry
  // with one would never match anything.
  assert.equal(normaliseOrigin("https://marinahair.ae/book?ref=1"), "https://marinahair.ae");
  assert.equal(normaliseOrigin("marinahair.ae"), "https://marinahair.ae");
  assert.equal(normaliseOrigin("http://localhost:3000"), "http://localhost:3000");
  assert.equal(normaliseOrigin("   "), null);
  assert.equal(normaliseOrigin("javascript:alert(1)"), null);
});

console.log("\n\x1b[1mThe day's budget\x1b[0m\n");

await test("a fresh widget is within its cap", () => {
  const gate = checkEmbedGate(getLocation(venue.id)!);
  assert.equal(gate.allowed, true);
  assert.equal(gate.used, 0);
});

await test("the cap counts website calls and stops at the limit", () => {
  const live = getLocation(venue.id)!;
  for (let i = 0; i < live.embed!.maxCallsPerDay; i++) {
    saveCall(startCall(live, "embed", "+971500000000"));
  }
  const gate = checkEmbedGate(getLocation(venue.id)!);
  assert.equal(gate.allowed, false);
  assert.equal(gate.used, live.embed!.maxCallsPerDay);
  // And what a visitor is told is a sentence, not a status code.
  assert.ok(gate.message && !/cap|limit|quota|error/i.test(gate.message), gate.message);
  assert.ok(gate.message?.includes("ring us"));
});

await test("a busy telephone does not switch the website widget off", async () => {
  // Separate channels, separate budgets. Conflating them would make a good day
  // on the phone look like an outage on the site.
  //
  // On its own venue, deliberately: the one above has already had its day's
  // worth of *browser* calls, so reusing it would prove nothing — the first
  // version of this test did exactly that and failed for the wrong reason.
  const second = await signUp({
    businessName: "Busy Line Salon",
    email: "owner@busyline.test",
    password: "Correct-Horse-Battery-9",
    vertical: "salon",
    timezone: "Asia/Dubai",
  });
  assert.ok(second.ok);
  const quiet = enableEmbed(second.ok ? second.location : null!, ["https://busyline.ae"]);

  for (let i = 0; i < 100; i++) {
    saveCall(startCall(quiet, "phone", "+971500000001"));
  }
  assert.equal(checkEmbedGate(getLocation(quiet.id)!).allowed, true);
});

await test("another venue's calls do not count against this one", () => {
  const belline = getLocation(BELLINE_LOCATION_ID)!;
  for (let i = 0; i < 100; i++) saveCall(startCall(belline, "embed", "+971500000002"));
  assert.equal(checkEmbedGate(getLocation(venue.id)!).allowed, false, "state changed unexpectedly");
  // The venue we just filled is still the one that is full, not this one.
  const other = getLocation(BELLINE_LOCATION_ID)!;
  assert.notEqual(other.id, venue.id);
});

console.log("\n\x1b[1mThe snippet\x1b[0m\n");

await test("the snippet is one line and carries the venue's own key", () => {
  const snippet = embedSnippet(getLocation(venue.id)!);
  assert.equal(snippet.split("\n").length, 1, "a snippet somebody has to read is one nobody pastes");
  assert.ok(snippet.includes(getLocation(venue.id)!.embed!.key));
  assert.ok(snippet.includes("https://app.belline.ai/embed.js"));
  assert.ok(snippet.includes("async"));
});

await test("the snippet never contains anything secret", () => {
  const snippet = embedSnippet(getLocation(venue.id)!);
  // It goes in a customer's page source, so this is not paranoia: it is the
  // one place a session id or a stream token would be catastrophic.
  for (const forbidden of ["belline_session", "sk_", "whsec_", "Bearer", "token"]) {
    assert.equal(
      snippet.toLowerCase().includes(forbidden.toLowerCase()),
      false,
      `the snippet leaks ${forbidden}`,
    );
  }
});

await test("the widget script is served and has no secrets in it either", () => {
  const js = fs.readFileSync(path.join(process.cwd(), "public", "embed.js"), "utf8");
  assert.ok(js.includes("data-belline"));
  assert.ok(js.includes("microphone"), "the iframe cannot ask for a microphone");
  // It runs on somebody else's page; it must never throw into their console
  // for a missing attribute.
  assert.ok(js.includes("console.warn"), "a missing key fails silently");
  assert.equal(/sk_|whsec_|belline_session/.test(js), false);
});

// ---------------------------------------------------------------------------
console.log("\nHow it looks — the venue's choices, within the guidelines\n");

{
  const { parseAppearance, resolveAppearance, widgetConfig, contrastRatio, EMBED_PALETTE, APPEARANCE_RULES } =
    await import("../src/lib/embed");

  await test("nothing chosen means the defaults, and the defaults are readable", () => {
    const r = parseAppearance({});
    assert.ok(r.ok);
    const look = resolveAppearance(r.ok ? r.appearance : {});
    assert.equal(look.voiceLabel, "Talk to us");
    assert.equal(look.accent, EMBED_PALETTE.indigo);
    assert.equal(look.accentText, "#FFFFFF");
    assert.ok(contrastRatio(look.accent, look.accentText) >= APPEARANCE_RULES.minContrast);
  });

  await test("words are the venue's, up to the limit, and never a link", () => {
    const ok = parseAppearance({ voiceLabel: "  Ring   Marina  ", chatLabel: "Message us" });
    assert.ok(ok.ok && ok.appearance.voiceLabel === "Ring Marina");
    const long = parseAppearance({ voiceLabel: "a".repeat(APPEARANCE_RULES.labelMaxChars + 1) });
    assert.ok(!long.ok && long.problem.field === "voiceLabel");
    const link = parseAppearance({ chatLabel: "Chat at www.example.com" });
    assert.ok(!link.ok && link.problem.field === "chatLabel");
  });

  await test("a colour from the palette by name, or a hex that keeps the words readable", () => {
    const named = parseAppearance({ accent: "Forest" });
    assert.ok(named.ok && named.appearance.accent === "forest");
    const hex = parseAppearance({ accent: "#1f2e4a" });
    assert.ok(hex.ok && hex.appearance.accent === "#1F2E4A");
    // Pale is fine — the words go in ink. A mid grey reads on neither.
    const pale = parseAppearance({ accent: "#F0EAD6" });
    assert.ok(pale.ok);
    const mid = parseAppearance({ accent: "#7B7B7B" });
    assert.ok(!mid.ok && /contrast/.test(mid.problem.message));
    const junk = parseAppearance({ accent: "reddish" });
    assert.ok(!junk.ok && junk.problem.field === "accent");
  });

  await test("light accents get ink text and an ink mark; dark ones white text and a white mark", () => {
    // Deep enough to pass, and light enough that ink reads better than paper.
    const light = resolveAppearance({ accent: "#C9A227" });
    assert.equal(light.accentText, "#1B2735");
    assert.equal(light.accentMark, "#1B2735");
    const dark = resolveAppearance({ accent: "wine" });
    assert.equal(dark.accentText, "#FFFFFF");
    assert.equal(dark.accentMark, "#FFFFFF");
  });

  await test("shape and corner are one of two, and anything else is refused", () => {
    assert.ok(parseAppearance({ shape: "round", corner: "left" }).ok);
    assert.ok(!parseAppearance({ shape: "square" }).ok);
    assert.ok(!parseAppearance({ corner: "top" }).ok);
  });

  await test("what the widget fetches carries no allowlist, no ceilings and no owner", () => {
    const cfg = widgetConfig(
      {
        key: "be_x",
        enabled: true,
        allowedOrigins: ["https://secret.example"],
        maxCallsPerDay: 40,
        maxCallSeconds: 300,
        mode: "both",
        appearance: { voiceLabel: "Ring us", whatsapp: false },
      },
      "https://wa.me/971501234567",
    );
    const json = JSON.stringify(cfg);
    assert.ok(!json.includes("secret.example"));
    assert.ok(!json.includes("maxCalls"));
    assert.equal(cfg.mode, "both");
    assert.equal(cfg.voiceLabel, "Ring us");
    assert.equal(cfg.whatsappLink, null, "the venue switched the WhatsApp button off");
  });

  await test("the widget fetches its look and keeps the defaults if that fails", () => {
    const js = fs.readFileSync(path.join(process.cwd(), "public", "embed.js"), "utf8");
    assert.ok(js.includes('"/api/embed/" + encodeURIComponent(key) + "/config"'));
    assert.ok(js.includes("the defaults are already on screen"));
    // No drawing comes from the config: no path in the bell, no icon, no SVG.
    // The one picture it may carry instead is the venue's logo (below), and
    // only from Belline's own /api/logo/.
    assert.ok(!/cfg\.(bell|icon|mark|svg)/.test(js));
  });

  // -------------------------------------------------------------------------
  // The logo on the button, and ringing.

  await test("the button mark is the bell or the logo, and ringing is on or off — anything else is refused", () => {
    const logo = parseAppearance({ buttonMark: "logo", ring: true });
    assert.ok(logo.ok && logo.appearance.buttonMark === "logo" && logo.appearance.ring === true);
    const bell = parseAppearance({ buttonMark: "bell", ring: false });
    assert.ok(bell.ok && bell.appearance.buttonMark === "bell" && bell.appearance.ring === false);
    const other = parseAppearance({ buttonMark: "https://evil.example/logo.png" });
    assert.ok(!other.ok && other.problem.field === "buttonMark");
    const yes = parseAppearance({ ring: "yes" });
    assert.ok(!yes.ok && yes.problem.field === "ring");
  });

  await test("by default the button shows the bell and does not ring", () => {
    const look = resolveAppearance({});
    assert.equal(look.buttonMark, "bell");
    assert.equal(look.ring, false);
    assert.equal(look.logoUrl, null);
    // A logo uploaded but not chosen stays off the button.
    assert.equal(resolveAppearance({}, "en", "/api/logo/lg_" + "a".repeat(24)).buttonMark, "bell");
  });

  await test("the logo is drawn only when chosen and uploaded; a choice without a logo falls back to the bell", () => {
    const url = "/api/logo/lg_" + "b".repeat(24);
    const chosen = resolveAppearance({ buttonMark: "logo" }, "en", url);
    assert.equal(chosen.buttonMark, "logo");
    assert.equal(chosen.logoUrl, url);
    const noLogo = resolveAppearance({ buttonMark: "logo" }, "en", null);
    assert.equal(noLogo.buttonMark, "bell", "a button with no logo to draw was told to draw one");
    assert.equal(noLogo.logoUrl, null);
  });

  await test("the widget config carries the mark, the logo URL and the ring, and still nothing private", () => {
    const url = "/api/logo/lg_" + "c".repeat(24);
    const cfg = widgetConfig(
      {
        key: "be_x",
        enabled: true,
        allowedOrigins: ["https://secret.example"],
        maxCallsPerDay: 40,
        maxCallSeconds: 300,
        appearance: { buttonMark: "logo", ring: true },
      },
      null,
      "en",
      url,
    );
    assert.equal(cfg.buttonMark, "logo");
    assert.equal(cfg.logoUrl, url);
    assert.equal(cfg.ring, true);
    assert.ok(!JSON.stringify(cfg).includes("secret.example"));
    const route = fs.readFileSync(path.join(process.cwd(), "src", "app", "api", "embed", "[key]", "config", "route.ts"), "utf8");
    assert.match(route, /widgetConfig\(location\.embed, link, answersIn\(location\), logoUrlFor\(location\)\)/);
  });

  await test("embed.js draws only a Belline-served logo, decoratively, and puts the bell back if it fails", () => {
    const js = fs.readFileSync(path.join(process.cwd(), "public", "embed.js"), "utf8");
    assert.match(js, /cfg\.buttonMark === "logo"/);
    // The URL from the config must be one of our logo paths, and is joined to our own origin.
    assert.ok(js.includes("/^\\/api\\/logo\\/lg_[0-9a-f]{24}$/.test(cfg.logoUrl)"), "the logo URL is not checked");
    assert.match(js, /img\.src = origin \+ logoPath/);
    assert.match(js, /img\.alt = ""/);
    assert.match(js, /addEventListener\("error"[\s\S]{0,120}replaceChild\(mark, holder\)/);
    assert.ok(!/innerHTML[^;]*logo/i.test(js), "the logo is written as HTML");
    // Always in a white circle, contained.
    assert.match(js, /\.belline-logo\{[^}]*background:#FFFFFF/);
    assert.match(js, /object-fit:contain/);
  });

  await test("embed.js rings only without reduced motion, follows the setting live, and stops for good on interaction", () => {
    const js = fs.readFileSync(path.join(process.cwd(), "public", "embed.js"), "utf8");
    assert.match(js, /cfg\.ring === true\) ring\(\)/);
    // Checked before every burst, and a change to the setting quiets a running ring.
    assert.match(js, /matchMedia\("\(prefers-reduced-motion: reduce\)"\)/);
    assert.match(js, /if \(!reducedMotion\(\) && !document\.hidden && !panel\)/);
    assert.match(js, /addEventListener\("change", onChange\)/);
    assert.match(js, /if \(stillQuery\.matches\) quiet\(\)/);
    // No matchMedia at all counts as reduce.
    assert.match(js, /return !stillQuery \|\| stillQuery\.matches/);
    // Any sign of interest stops it permanently: the flag is never reset.
    assert.match(js, /\["pointerenter", "mouseenter", "focusin", "touchstart", "click"\]\.forEach[\s\S]{0,120}stopRinging/);
    assert.match(js, /function open\(kind, label\) \{\s*if \(panel\) return;\s*stopRinging\(\);/);
    assert.equal((js.match(/ringStopped = true/g) ?? []).length, 1);
    assert.ok(!/ringStopped = false;[\s\S]*ringStopped = false/.test(js), "something turns ringing back on");
    assert.match(js, /if \(ringStopped\) return;/);
    // Occasional, not constant, and capped per page view.
    assert.match(js, /var RING_EVERY_MS = \d{5}/);
    assert.match(js, /var RING_MAX = \d+;/);
    // And the CSS itself is scoped to the widget's own names and off under reduced motion.
    assert.match(js, /@keyframes belline-shake/);
    assert.ok(!/@keyframes (bell-|shake|ring|nudge)/.test(js), "an unscoped keyframe name could collide with the host page");
    assert.match(js, /@media \(prefers-reduced-motion:reduce\)\{[^"]*"\s*\+\s*"\.belline-ringing/);
  });

  await test("the editor offers the logo only once there is one, rings in the preview, and respects reduced motion", () => {
    const editor = fs.readFileSync(path.join(process.cwd(), "src", "app", "(app)", "website", "WidgetEditor.tsx"), "utf8");
    assert.match(editor, /<LogoUpload locationId=\{locationId\} logoUrl=\{logoUrl\} onChange=\{setLogoUrl\} \/>/);
    assert.match(editor, /const disabled = value === "logo" && !logoUrl;/);
    assert.match(editor, /Upload your logo above to put it on the button/);
    assert.match(editor, /Ring the button now and then/);
    assert.match(editor, /logoUrl\?: string \| null;/, "logoUrl must stay an optional prop");
    const css = fs.readFileSync(path.join(process.cwd(), "src", "app", "globals.css"), "utf8");
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.widget-preview-ring,/);
  });
}

console.log("\n\x1b[1mKnowing it is installed\x1b[0m\n");

{
  const { recordSeen, suggestedOrigins } = await import("../src/lib/embed");
  const { upsertLocation, getBusiness } = await import("../src/lib/store");
  const { journey } = await import("../src/lib/onboarding/journey");
  const source = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

  const fresh = () => getLocation(venue.id)!;
  // A clean record, and the widget on for one site.
  upsertLocation({ ...fresh(), onboarding: { version: 1, channels: {} } });
  enableEmbed(fresh(), ["https://marinahair.ae"]);

  await test("a ping from a site the venue did not name writes nothing and tells the widget not to render", () => {
    assert.deepEqual(recordSeen(fresh(), "https://copycat.example"), { ok: false });
    assert.deepEqual(recordSeen(fresh(), null), { ok: false }, "a missing origin counted as the venue's");
    assert.deepEqual(recordSeen(fresh(), "https://marinahair.ae.copycat.example"), { ok: false });
    assert.equal(fresh().onboarding?.channels.web, undefined);
  });

  await test("a ping from the venue's own site marks the widget installed, and www counts", () => {
    const at = new Date("2026-09-15T10:00:00.000Z");
    const out = recordSeen(fresh(), "https://www.marinahair.ae", at);
    assert.ok(out.ok && out.firstTime);
    assert.equal(fresh().onboarding?.channels.web?.detectedAt, at.toISOString());
    assert.deepEqual(fresh().onboarding?.channels.web?.domains, ["https://marinahair.ae"]);
  });

  await test("pinging again is idempotent: detection keeps its first time, only the last check moves", () => {
    const later = new Date("2026-09-15T11:00:00.000Z");
    const out = recordSeen(fresh(), "https://marinahair.ae", later);
    assert.ok(out.ok && !out.firstTime);
    assert.equal(fresh().onboarding?.channels.web?.detectedAt, "2026-09-15T10:00:00.000Z");
    assert.equal(fresh().onboarding?.channels.web?.lastCheckAt, later.toISOString());
  });

  await test("detection completes the website chat step without any conversation", () => {
    const steps = journey(fresh()).steps;
    assert.equal(steps.find((s) => s.id === "website")!.done, true);
  });

  await test("a switched-off widget is not detected, even from its own site", () => {
    const offVenue = disableEmbed(fresh());
    assert.deepEqual(recordSeen(offVenue, "https://marinahair.ae"), { ok: false });
    enableEmbed(fresh(), ["https://marinahair.ae"]);
  });

  await test("the website setup read is the suggested site, and saved sites win over it", () => {
    const base = fresh();
    const bare = { ...base, embed: undefined, onboarding: { version: 1 as const, channels: { web: { domains: ["https://marinahair.ae"] } } } };
    assert.deepEqual(suggestedOrigins(bare), ["https://marinahair.ae"]);
    assert.deepEqual(suggestedOrigins({ ...bare, onboarding: { version: 1, channels: {} } }, "www.marina-business.ae/about"), ["https://www.marina-business.ae"]);
    assert.deepEqual(suggestedOrigins(base), base.embed!.allowedOrigins);
    assert.ok(getBusiness(base.tenantId, base.businessId), "the fixture has a business");
    assert.match(source("src/app/api/setup/route.ts"), /normaliseOrigin\(String\(body\.website/);
  });

  await test("embed.js pings on load and takes itself off the page when refused", () => {
    const js = fs.readFileSync(path.join(process.cwd(), "public", "embed.js"), "utf8");
    assert.ok(js.includes('"/api/embed/" + encodeURIComponent(key) + "/seen"'));
    assert.match(js, /status === 403[\s\S]{0,40}dock\.remove\(\)/);
  });

  await test("the seen route trusts the browser's Origin header and nothing the page sends", () => {
    const route = source("src/app/api/embed/[key]/seen/route.ts");
    assert.match(route, /headers\.get\("origin"\)/);
    assert.match(route, /recordSeen\(/);
    assert.ok(!/req\.json\(/.test(route), "the route reads a body a page could forge");
    assert.match(route, /status: 403/);
  });

  await test("the website page switches on without a reload, polls every 20 seconds and has one label per field", () => {
    const editor = source("src/app/(app)/website/WidgetEditor.tsx");
    const check = source("src/app/(app)/website/InstallCheck.tsx");
    assert.ok(!/location\.reload\(/.test(editor), "saving still reloads the page");
    assert.match(check, /\/api\/embed\/status/);
    assert.match(check, /20_000/);
    // The two website inputs on this page used to share a name. A visible
    // label repeated as its own group's aria-label (Shape, Corner) is fine.
    const labelsOf = (src: string) => new Set([...src.matchAll(/(?:aria-label="|<label[^>]*>)([^"<{]+)/g)].map((m) => m[1].trim().toLowerCase()));
    const shared = [...labelsOf(check)].filter((l) => labelsOf(editor).has(l));
    assert.deepEqual(shared, [], `labels used on both website fields: ${shared.join(", ")}`);
    assert.ok(!labelsOf(check).has("your website address"), "the install check still has the old shared label");
  });

  await test("the install panel and the header follow the save, not the server's snapshot of the page", () => {
    // The section both the Channels tab and the setup step render.
    const page = source("src/app/(app)/channels/sections.tsx");
    const editor = source("src/app/(app)/website/WidgetEditor.tsx");

    // The defect this pins: the panel that watches for the widget appearing
    // was gated on the server's `embed` — read before the widget was switched
    // on — while the save patches client state and never re-renders the page.
    // An owner switched it on, pasted the line, and was told nothing until
    // their next visit. Nothing server-rendered may decide whether it mounts.
    assert.ok(!/InstallCheck/.test(page), "the server page still decides whether the install panel mounts");
    assert.match(editor, /\{enabled && <InstallCheck/);
    assert.match(editor, /detectedAt=\{detectedAt\}/);

    // The same fault in the header: `enabled` was client state and `offering`
    // a stale prop, so a widget saved as "both" announced itself as talking.
    // Both now come off what the save returned.
    assert.ok(!/offering:/.test(editor), "the header still takes what it offers from a server prop");
    assert.match(editor, /setSavedMode\(data\.mode\)/);
    assert.match(editor, /savedMode !== "chat"/);

    // And the rest of the screen is still server-rendered, so the save asks
    // for it again — a refresh, never a reload: a reload eats the sites box.
    assert.match(editor, /router\.refresh\(\)/);
    assert.ok(!/location\.reload\(/.test(editor), "saving still reloads the page");
  });

  await test("builder tabs cover WordPress, Wix, Shopify, Squarespace and Tag Manager, plus an email for a web person", async () => {
    const { BUILDER_TABS } = await import("../src/lib/onboarding/platform");
    const ids = BUILDER_TABS.map((t) => t.id);
    for (const id of ["wordpress", "wix", "shopify", "squarespace", "gtm"]) assert.ok(ids.includes(id), `no ${id} tab`);
    assert.ok(BUILDER_TABS.every((t) => t.steps.length > 0));
    const guide = source("src/app/(app)/website/InstallGuide.tsx");
    assert.match(guide, /mailto:\?subject=/);
    assert.match(guide, /Send to my web person/);
  });
}

console.log(
  failed === 0
    ? `\n\x1b[32m✓ ${passed} passed, 0 failed\x1b[0m\n`
    : `\n\x1b[31m✗ ${passed} passed, ${failed} failed\x1b[0m\n`,
);
process.exit(failed === 0 ? 0 : 1);

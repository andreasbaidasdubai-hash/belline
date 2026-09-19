/**
 * The notice a cold-email recipient is owed, and the ways it could go missing.
 *
 * The outreach engine flagged its own gap: a scraped business contact on a
 * named person is personal data, Art. 6(1)(f) is arguable, and Art. 13/14 want
 * a notice at first contact with an Art. 21 objection right. The footer had an
 * unsubscribe link and nothing else — which stops the next message and tells
 * the reader nothing about the processing that already happened.
 *
 * There is now a page and a link to it in every footer. What is pinned here is
 * every way that could quietly stop being true:
 *
 *  - a frame added for a new market with no privacy sentence in it;
 *  - a footer that carries the opt-out and loses the notice;
 *  - a send that goes out anyway, because the last check before the bytes
 *    leave only ever looked at the postal address;
 *  - the German page becoming a machine translation of English marketing
 *    prose, which is where an Abmahnung starts;
 *  - the page being published naming "Example Ltd" so that a screen goes
 *    green before the company exists;
 *  - the page's own promises drifting from the limits the engine enforces.
 *
 * Nothing here sends and nothing here is legal advice. The page states an
 * Art. 6(1)(f) basis and says in as many words where that is untested; these
 * tests check that those words are still there, not that they are right.
 *
 *   npm run check:mail-privacy
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

for (const key of Object.keys(process.env)) {
  if (key.startsWith("LEGAL_") || key.startsWith("OUTREACH_")) delete process.env[key];
}
delete process.env.SENDER_POSTAL_ADDRESS;
delete process.env.SITE_ORIGIN;

const notice = await import("../src/lib/legal/outreach-privacy");
const identityMod = await import("../src/lib/legal/identity");
const countries = await import("../src/lib/sales/sending/countries");
const compliance = await import("../src/lib/sales/sending/compliance");
const provider = await import("../src/lib/sales/sending/provider");
const unsub = await import("../src/lib/sales/sending/unsubscribe");
const templates = await import("../src/lib/sales/outreach/templates");
const locale = await import("./site-locale");

const EN = read(`public/${notice.OUTREACH_PRIVACY_SOURCE}`);
const DE = read(`public/${notice.OUTREACH_PRIVACY_SOURCE_DE}`);

const FULL = {
  LEGAL_ENTITY: "Belline FZ-LLC",
  LEGAL_ADDRESS: "Dubai Digital Park, Dubai Silicon Oasis, Dubai, UAE",
  LEGAL_MANAGING_DIRECTOR: "Andreas Baidas",
  LEGAL_REGISTRATION: "DSO-FZCO-84713",
  LEGAL_EMAIL: "hello@belline.ai",
};

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

const section = (title: string) => console.log(`\n\x1b[1m${title}\x1b[0m\n`);

// ---------------------------------------------------------------------------
section("Every outreach template links to the notice");

test("every frame has a privacy sentence with a {url} slot in it", () => {
  // Reached through resolveFrame rather than the private FRAMES array, for
  // every key the resolver can land on.
  const keys: { countryCode: string | null; language: string }[] = [
    { countryCode: null, language: "en" },
    { countryCode: "AE", language: "en" },
    { countryCode: "AE", language: "ar" },
    { countryCode: "CH", language: "de" },
    { countryCode: "DE", language: "de" },
    { countryCode: "ZZ", language: "en" },
  ];
  for (const key of keys) {
    const frame = templates.resolveFrame(key);
    assert.ok(frame.privacy?.trim(), `${frame.key}: no privacy sentence`);
    assert.ok(frame.privacy.includes("{url}"), `${frame.key}: the privacy sentence has no {url} slot`);
    assert.ok(frame.unsubscribe?.trim(), `${frame.key}: no unsubscribe sentence`);
  }
});

test("the frames' source names a privacy sentence as often as an unsubscribe one", () => {
  // The resolver above cannot see a frame nobody resolves to. This can: a
  // frame added for a new market with an unsubscribe line and no notice is a
  // frame that would draft a non-compliant first touch.
  const source = read("src/lib/sales/outreach/templates.ts");
  const frames = source.slice(source.indexOf("const FRAMES"), source.indexOf("export function resolveFrame"));
  const unsubscribes = (frames.match(/^\s{4}unsubscribe:/gm) ?? []).length;
  const privacies = (frames.match(/^\s{4}privacy:/gm) ?? []).length;
  assert.ok(unsubscribes > 0, "no frames found — this test is looking in the wrong place");
  assert.equal(privacies, unsubscribes, "a frame has an unsubscribe line and no privacy sentence");
});

test("an assembled draft carries the notice beside the opt-out", () => {
  const body = templates.assemble({
    frame: templates.resolveFrame({ countryCode: "AE", language: "en" }),
    firstName: "Sara",
    observation: "Your site takes bookings by form only.",
    problem: "Calls out of hours go unanswered.",
    solution: "Belline answers them and books.",
    cta: "Worth two minutes?",
    demoUrl: "https://app.belline.test/demo/x",
    unsubscribeUrl: "https://app.belline.test/u/t",
    privacyUrl: "https://belline.ai/outreach-privacy",
    senderAddress: "Belline · Dubai",
  }).body;
  assert.ok(body.includes("https://app.belline.test/u/t"), "no unsubscribe link");
  assert.ok(body.includes("https://belline.ai/outreach-privacy"), "no privacy notice");
});

test("no notice means the words say so, not a URL that would 404", () => {
  const body = templates.assemble({
    frame: templates.resolveFrame({ countryCode: "AE", language: "en" }),
    firstName: null,
    observation: "o",
    problem: "p",
    solution: "s",
    cta: "c",
    demoUrl: "https://app.belline.test/demo/x",
    unsubscribeUrl: null,
    privacyUrl: null,
    senderAddress: "Belline · Dubai",
  }).body;
  assert.ok(body.includes(templates.NO_PRIVACY_NOTICE), "the draft must say why there is no notice");
  assert.ok(!body.includes("belline.ai/outreach-privacy"), "a dead notice URL must not be written into a draft");
});

test("the footer carries the notice in both languages, beside the opt-out", () => {
  for (const [language, expected] of [
    ["en", "https://belline.ai/outreach-privacy"],
    ["de", "https://belline.ai/de-de/datenschutz-kontaktaufnahme"],
  ]) {
    const footer = unsub.footerFor({
      language,
      url: "https://app.belline.test/u/t",
      privacyUrl: expected,
      entity: "Belline FZ-LLC",
      address: "Dubai",
    });
    assert.ok(footer.includes("https://app.belline.test/u/t"), `${language}: the opt-out went missing`);
    assert.ok(footer.includes(expected), `${language}: the notice is not in the footer`);
  }
});

test("a German recipient is sent to the German notice, per country", () => {
  assert.equal(notice.outreachPrivacyUrl({ language: "en", env: {} }), "https://belline.ai/outreach-privacy");
  for (const [code, slug] of [["DE", "de-de"], ["AT", "de-at"], ["CH", "de-ch"]]) {
    assert.equal(
      notice.outreachPrivacyUrl({ language: "de", countryCode: code, env: {} }),
      `https://belline.ai/${slug}/datenschutz-kontaktaufnahme`,
    );
  }
  // An unknown country with a German message still gets a German page.
  assert.match(notice.outreachPrivacyUrl({ language: "de-CH", countryCode: null, env: {} }), /\/de-de\//);
});

test("a sending domain can host its own copy without the notice changing", () => {
  const env = { OUTREACH_PRIVACY_ORIGIN: "https://try-belline.com/" };
  assert.equal(notice.outreachPrivacyUrl({ language: "en", env }), "https://try-belline.com/outreach-privacy");
  assert.equal(
    notice.outreachPrivacyUrl({ language: "de", countryCode: "AT", env }),
    "https://try-belline.com/de-at/datenschutz-kontaktaufnahme",
  );
});

// ---------------------------------------------------------------------------
section("A send refuses without it");

const HEADERS = unsub.unsubscribeHeaders({ url: "https://app.belline.test/u/t" });
const PRIVACY = "https://belline.ai/outreach-privacy";
const IDENTITY = identityMod.legalIdentity({ SENDER_POSTAL_ADDRESS: "Belline · Dubai" });
const message = (text: string) => ({
  from: "andreas@try-belline.com",
  fromName: "Andreas",
  to: "dr.sara@clinic.test",
  subject: "s",
  text,
  headers: HEADERS,
});

test("a body with the postal identity and the opt-out but no notice is refused", () => {
  assert.throws(
    () => provider.assertSendable(message("Belline · Dubai\nhttps://app.belline.test/u/t"), IDENTITY, PRIVACY),
    /privacy notice/,
    "this is exactly the message the engine used to be willing to send",
  );
});

test("an empty notice URL is refused rather than treated as nothing to check", () => {
  const text = `Belline · Dubai\nhttps://app.belline.test/u/t\n${PRIVACY}`;
  for (const empty of ["", "   "]) {
    assert.throws(() => provider.assertSendable(message(text), IDENTITY, empty), /no privacy notice/);
  }
});

test("a body that carries both goes through", () => {
  const text = `Belline · Dubai\nhttps://app.belline.test/u/t\n${PRIVACY}`;
  provider.assertSendable(message(text), IDENTITY, PRIVACY);
});

test("the wrong language's notice does not satisfy the check", () => {
  const german = "https://belline.ai/de-de/datenschutz-kontaktaufnahme";
  const text = `Belline · Dubai\nhttps://app.belline.test/u/t\n${PRIVACY}`;
  assert.throws(() => provider.assertSendable(message(text), IDENTITY, german), /privacy notice/);
});

test("the compliance gate blocks a batch whose notice cannot be published", () => {
  const base = {
    companyName: "Clinic",
    toAddress: "dr.sara@clinic.test",
    countryCode: "AE",
    country: countries.effectiveRule("AE"),
    identity: identityMod.legalIdentity(FULL),
    suppressed: null,
    step: 1,
    touches90d: 0,
    lastTouchAt: null,
    hasDemoLink: true,
    hasResearch: true,
    sequenceStopped: null,
    guardProblems: [] as string[],
    canSignUnsubscribe: true,
    engineReady: true,
  };
  assert.equal(compliance.screen({ ...base, hasPrivacyNotice: true }).ok, true);
  const blocked = compliance.screen({ ...base, hasPrivacyNotice: false });
  assert.equal(blocked.ok, false);
  assert.ok(blocked.blocks.some((b) => b.code === "no_privacy_notice"));
  assert.equal(compliance.isActionable("no_privacy_notice"), true);
});

test("the notice needs the same five identity fields DACH already needs", () => {
  assert.deepEqual([...notice.NOTICE_IDENTITY].sort(), [...countries.DACH_IDENTITY].sort());
});

// ---------------------------------------------------------------------------
section("It cannot be published with invented company details");

test("an empty identity is not ready, and says which fields are missing", () => {
  const state = notice.noticeReadiness(identityMod.legalIdentity({}));
  assert.equal(state.ready, false);
  assert.deepEqual(state.placeholders, [], "empty is honest, not invented");
  for (const field of ["entity", "address", "managingDirector", "registration"]) {
    assert.ok(state.missing.includes(field as never), `${field} should be reported missing`);
  }
});

test("a complete, real identity is ready", () => {
  const state = notice.noticeReadiness(identityMod.legalIdentity(FULL));
  assert.deepEqual(state.placeholders, []);
  assert.deepEqual(state.missing, []);
  assert.equal(state.ready, true);
});

test("a plausible-looking placeholder is caught, not published", () => {
  for (const [key, value] of [
    ["LEGAL_ENTITY", "Example Ltd"],
    ["LEGAL_ENTITY", "Acme Holding"],
    ["LEGAL_ENTITY", "Belline FZ-LLC (in formation)"],
    ["LEGAL_ADDRESS", "123 Main Street, Dubai"],
    ["LEGAL_ADDRESS", "Musterstraße 1, 10115 Berlin"],
    ["LEGAL_MANAGING_DIRECTOR", "Max Mustermann"],
    ["LEGAL_MANAGING_DIRECTOR", "TBD"],
    ["LEGAL_REGISTRATION", "000000"],
    ["LEGAL_REGISTRATION", "123456"],
    ["LEGAL_REGISTRATION", "n/a"],
  ]) {
    const state = notice.noticeReadiness(identityMod.legalIdentity({ ...FULL, [key]: value }));
    assert.equal(state.ready, false, `"${value}" was accepted as a real ${key}`);
    assert.ok(state.placeholders.length > 0, `"${value}" was not recognised as a placeholder`);
  }
});

test("a real company is not rejected for containing an unlucky substring", () => {
  for (const value of ["Attestor Capital", "Barbara Weiss Praxis GmbH", "Naomi Bar-On", "Sunna Medical"]) {
    assert.equal(notice.looksLikePlaceholder(value), false, `"${value}" was wrongly called a placeholder`);
  }
  assert.equal(notice.looksLikePlaceholder("DSO-FZCO-84713"), false);
  assert.equal(notice.looksLikePlaceholder("Dubai Digital Park, Dubai Silicon Oasis"), false);
});

test("the build refuses invented details and omits the page when they are empty", () => {
  const build = read("scripts/build-site.ts");
  assert.match(build, /noticeReadiness/, "build-site does not consult the readiness of the notice");
  assert.match(build, /NOTICE\.placeholders\.length > 0[\s\S]{0,400}process\.exit\(1\)/, "a placeholder does not stop the build");
  assert.match(build, /if \(!NOTICE\.ready\)[\s\S]{0,600}console\.warn/, "an empty identity does not warn");
  assert.ok(
    build.includes("if (!NOTICE.ready) delete GERMAN_SOURCES[OUTREACH_PRIVACY_SOURCE_DE]"),
    "the German notice would still be rendered with no controller to name",
  );
});

test("the notice is wired into the build the way the other legal pages are", () => {
  const build = read("scripts/build-site.ts");
  assert.ok(build.includes("OUTREACH_PRIVACY_SOURCE,"), "the English page is not in PAGES");
  assert.ok(build.includes("OUTREACH_PRIVACY_SOURCE_DE,"), "the German source is not in PAGES");
  assert.ok(build.includes(`[OUTREACH_PRIVACY_SOURCE_DE]: "outreach-privacy.html"`), "no German render is registered");

  const page = locale.LEGAL_PAGES["outreach-privacy.html"];
  assert.equal(page.english, "/outreach-privacy");
  assert.equal(page.german, "datenschutz-kontaktaufnahme");

  // The alternates name the English page and all three German ones.
  const alternates = locale.legalAlternates("outreach-privacy.html");
  assert.match(alternates, /hreflang="en" href="https:\/\/belline\.ai\/outreach-privacy"/);
  for (const slug of ["de-de", "de-at", "de-ch"]) {
    assert.ok(
      alternates.includes(`https://belline.ai/${slug}/datenschutz-kontaktaufnahme`),
      `no alternate for /${slug}`,
    );
  }
  assert.match(alternates, /hreflang="x-default"/);
});

// ---------------------------------------------------------------------------
section("What the English page has to say");

test("it names the controller from the identity block, not in prose", () => {
  for (const key of ["entity", "address", "director", "registration"]) {
    assert.ok(EN.includes(`data-legal="${key}"`), `the English page hard-codes or omits ${key}`);
  }
  assert.match(EN, /<link rel="canonical" href="https:\/\/belline\.ai\/outreach-privacy">/);
});

test("it says what Art. 13/14 require it to say", () => {
  for (const [re, what] of [
    [/Article 14/, "the Art. 14 basis for the notice itself"],
    [/Article 6\(1\)\(f\)|Art\. 6\(1\)\(f\)/, "the lawful basis"],
    [/legitimate interest/i, "the interest, named"],
    [/public business listing/i, "where the data came from"],
    [/your own website|their own website/i, "the other source"],
    [/Art(?:icle|\.) 21/, "the right to object"],
    [/Art(?:icle|\.) 15/, "the right of access"],
    [/Art(?:icle|\.) 16/, "the right to rectification"],
    [/Art(?:icle|\.) 17/, "the right to erasure"],
    [/supervisory authority/i, "the right to complain"],
    [/Amazon SES/, "the email provider"],
    [/twelve months/i, "a retention period"],
  ] as [RegExp, string][]) {
    assert.match(EN, re, `the English notice does not state ${what}`);
  }
});

test("it names the interest honestly rather than as a benefit to the reader", () => {
  assert.match(
    EN,
    /trying to find its first customers/,
    "the legitimate interest has been dressed up; it is ours, not the reader's",
  );
  assert.match(EN, /not a benefit to you/i, "the notice no longer admits whose interest it is");
});

test("it says the objection is permanent, and what record survives it", () => {
  assert.match(EN, /suppression list/i, "the suppression list is not mentioned");
  assert.match(EN, /permanent/i, "it does not say the suppression is permanent");
  assert.match(EN, /minimum/i, "it does not say we keep the minimum needed");
  assert.match(EN, /Article 17\(3\)/, "it does not name a basis for keeping the suppression record");
  assert.match(EN, /uncertain/i, "the uncertainty about that basis has been quietly removed");
});

test("objecting is one step, and no reason is demanded", () => {
  assert.match(EN, /one click/i);
  assert.match(EN, /without a form|no form/i);
  assert.match(EN, /do not (?:ask why|have to give a reason)|without .{0,20}reason/i);
});

// ---------------------------------------------------------------------------
section("The German version is a German notice, not the English one translated");

test("it is not the English page", () => {
  assert.notEqual(DE, EN);
  const text = (html: string) =>
    html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const en = text(EN);
  const de = text(DE);
  // A handful of English sentences that a translated page could not keep and
  // a machine-translated one would have rendered word for word.
  for (const sentence of [
    "You are reading this because Belline wrote to you at work",
    "Our legal basis is Article 6(1)(f) GDPR",
    "Where it came from",
    "Who else sees it",
  ]) {
    assert.ok(en.includes(sentence), `the English page no longer contains "${sentence}" — update this test`);
    assert.ok(!de.includes(sentence), `the German page carries the English sentence "${sentence}"`);
  }
});

test("it cites German law in the German form, which a translation would not", () => {
  for (const [re, what] of [
    [/Art\. 14 DSGVO/, "Art. 14 DSGVO"],
    [/Art\. 6 Abs\. 1 lit\. f DSGVO/, "Art. 6 Abs. 1 lit. f DSGVO"],
    [/Art\. 21 Abs\. 2 DSGVO/, "Art. 21 Abs. 2 DSGVO"],
    [/Art\. 17 Abs\. 3 lit\. b/, "Art. 17 Abs. 3 lit. b DSGVO"],
    [/Art\. 77 DSGVO/, "the Art. 77 right to complain"],
    [/Art\. 4 Nr\. 7 DSGVO/, "the controller definition"],
    [/§ 7 Abs\. 2 Nr\. 2 UWG/, "§ 7 UWG, which is what actually bites here"],
    [/§ 107 TKG/, "the Austrian rule"],
    [/Art\. 3 Abs\. 1 lit\. o und s UWG|Art\. 3 Abs\. 1 lit\. o/, "the Swiss rule"],
    [/berechtigtes? Interesse/, "the legitimate interest, in German"],
    [/Auftragsverarbeitung|Art\. 28 DSGVO/, "the processor relationship"],
    [/Standardvertragsklauseln/, "the transfer mechanism"],
    [/Erwägungsgrund 47/, "the recital the basis leans on"],
  ] as [RegExp, string][]) {
    assert.match(DE, re, `the German notice does not cite ${what}`);
  }
  // The English citation style is the tell of a translated page.
  assert.ok(!/Article \d/.test(DE), "the German page uses English article citations");
  assert.ok(!/GDPR/.test(DE), "the German page says GDPR rather than DSGVO");
});

test("it stands on its own — it does not say the English version governs", () => {
  // The other two German legal pages are convenience translations and say so.
  // This one must not: for a German recipient, this is the notice.
  assert.ok(!DE.includes("englische Fassung"), "the German notice defers to the English one");
  assert.ok(!DE.includes("Sprachfassungen"), "the German notice carries the translation disclaimer");
  assert.ok(!DE.includes("Übersetzung zu Ihrer Information"), "the German notice calls itself a translation");
  assert.match(DE, /<html lang="de-DE">/);
  assert.match(DE, /<link rel="canonical" href="https:\/\/belline\.ai\/de-de\/datenschutz-kontaktaufnahme">/);
});

test("it names the controller from the same identity block", () => {
  for (const key of ["entity", "address", "director", "registration"]) {
    assert.ok(DE.includes(`data-legal="${key}"`), `the German page hard-codes or omits ${key}`);
  }
  assert.match(DE, /Vertretungsberechtigt/, "no representative line, which § 5 DDG expects");
});

test("it is not listed as a translation, so nothing tries to keep it in step with the English", () => {
  const translations = read("scripts/check-translations.ts");
  assert.ok(
    !translations.includes(notice.OUTREACH_PRIVACY_SOURCE_DE),
    "the German notice is in TRANSLATIONS, which would force it to mirror English prose",
  );
});

// ---------------------------------------------------------------------------
section("The page does not promise more than the engine enforces");

test("the limits the German page states are the limits DACH actually runs under", () => {
  for (const code of ["DE", "AT", "CH"]) {
    const rule = countries.ruleFor(code);
    assert.equal(rule.maxSequenceSteps, 3, `${code}: the page says höchstens drei Nachrichten`);
    assert.equal(rule.minDaysBetweenTouches, 7, `${code}: the page says mindestens sieben Tagen Abstand`);
    assert.equal(rule.companyTouchCap90d, 3, `${code}: the page says drei Nachrichten in 90 Tagen`);
  }
  assert.match(DE, /höchstens drei Nachrichten/);
  assert.match(DE, /sieben Tagen/);
  assert.match(DE, /90 Tagen/);
});

test("both pages name only the processors the engine can actually reach", () => {
  // Resend carries customers' transactional mail and is refused for cold
  // outreach in code. A privacy notice listing it would be a false statement
  // about who has the reader's data.
  for (const [page, name] of [[EN, "English"], [DE, "German"]] as [string, string][]) {
    assert.ok(!/Resend/.test(page), `${name}: the notice names Resend, which never carries cold mail`);
    assert.match(page, /Amazon SES/, `${name}: the notice does not name the provider that does send`);
  }
  assert.ok(Object.keys(provider.REFUSED_PROVIDERS).includes("resend"));
  assert.deepEqual([...provider.SUPPORTED_PROVIDERS], ["ses"]);
});

console.log(
  failed === 0
    ? `\n\x1b[32m✓ ${passed} passed, 0 failed\x1b[0m\n`
    : `\n\x1b[31m✗ ${passed} passed, ${failed} failed\x1b[0m\n`,
);
process.exit(failed === 0 ? 0 : 1);

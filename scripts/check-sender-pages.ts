/**
 * The pages our sending domains answer with, and the ways they could go wrong.
 *
 * We send cold mail from four lookalike domains. Each one is a domain a
 * stranger will type into a browser after getting an unexpected email, and
 * what is there is the whole of their evidence about whether we are real. The
 * page is therefore load-bearing in a way a marketing page is not, and these
 * are the failures that would make it worthless without making anything go
 * red on its own:
 *
 *  - a fifth domain is bought and added to the engine, and its page is never
 *    built — so the one domain currently sending is the one with nothing on
 *    it. Pinned to the engine's list, not to a copy of it;
 *  - the identity drifts from the one in the email footer, so the page a
 *    recipient checks against the message disagrees with the message;
 *  - the letterhead is quietly filled with a plausible company to make this
 *    check pass, which is the failure `outreach-privacy.ts` exists to name;
 *  - the "reply no thanks" promise outliving the matcher that honours it —
 *    a page that tells somebody how to make us stop, over code that does not
 *    stop, is worse than no page;
 *  - the pages losing `noindex` and turning up in a search for Belline ahead
 *    of belline.ai;
 *  - the link to the privacy notice pointing at a page this same build
 *    decided not to publish.
 *
 * Nothing here sends and nothing here writes to site/: the page is rendered
 * in memory from the same function the build calls.
 *
 *   npm run check:sender-pages
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Type-only, so it is erased and cannot pull the module in before the
// environment below has been cleaned.
import type { SendingDomainInfo } from "../src/lib/sales/sending/domains";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

for (const key of Object.keys(process.env)) {
  if (key.startsWith("LEGAL_") || key.startsWith("OUTREACH_")) delete process.env[key];
}
delete process.env.SENDER_POSTAL_ADDRESS;
delete process.env.SITE_ORIGIN;

const domains = await import("../src/lib/sales/sending/domains");
const identityMod = await import("../src/lib/legal/identity");
const notice = await import("../src/lib/legal/outreach-privacy");
const unsub = await import("../src/lib/sales/sending/unsubscribe");
const suppression = await import("../src/lib/sales/compliance/suppression");
const marketing = await import("../src/lib/marketing");
const { senderPage } = await import("./site-sender");

const EMPTY = identityMod.legalIdentity({});
const FULL = identityMod.legalIdentity({
  LEGAL_ENTITY: "Belline FZ-LLC",
  LEGAL_ADDRESS: "Dubai Digital Park, Dubai Silicon Oasis, Dubai, UAE",
  LEGAL_MANAGING_DIRECTOR: "Andreas Baidas",
  LEGAL_REGISTRATION: "DSO-FZCO-84713",
  LEGAL_EMAIL: "hello@belline.ai",
});

/** A page as the build writes it today: no company, so no published notice. */
function today(domain: SendingDomainInfo): string {
  return senderPage({
    domain,
    legal: EMPTY,
    privacyUrl: null,
    policyUrl: `${domain.site}/privacy`,
    unsubscribePath: unsub.UNSUBSCRIBE_PATH,
  });
}

/** The same page once the company exists and the notice is published. */
function formed(domain: SendingDomainInfo): string {
  return senderPage({
    domain,
    legal: FULL,
    privacyUrl: notice.outreachPrivacyUrl({ language: "en" }),
    policyUrl: `${domain.site}/privacy`,
    unsubscribePath: unsub.UNSUBSCRIBE_PATH,
  });
}

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

// --- the list is one list -----------------------------------------------------

test("all four owned domains are in the one list, and belline.ai is not", () => {
  assert.deepEqual(
    [...domains.SENDING_DOMAIN_NAMES],
    ["trybelline.com", "getbelline.com", "bellineai.com", "hellobelline.com"],
  );
  assert.ok(!domains.SENDING_DOMAIN_NAMES.includes("belline.ai"), "belline.ai carries transactional mail");
  assert.equal(domains.isSendingDomain("belline.ai"), false);
  assert.equal(domains.isSendingDomain("app.belline.ai"), false);
});

test("the build and the server read that list rather than keeping their own", () => {
  const build = read("scripts/build-site.ts");
  assert.match(build, /SENDING_DOMAINS/, "build-site.ts does not read the domain list");
  assert.match(read("src/lib/marketing.ts"), /sendingDomainFor/, "marketing.ts does not read the domain list");
  // The literal names belong in domains.ts and nowhere else.
  for (const name of domains.SENDING_DOMAIN_NAMES) {
    assert.ok(!build.includes(name), `build-site.ts hard-codes ${name} instead of reading the list`);
    assert.ok(
      !read("scripts/site-sender.ts").includes(`"${name}"`),
      `site-sender.ts hard-codes ${name}`,
    );
  }
});

test("the engine's own status names an owned domain this deployment is missing", () => {
  // The list is the engine's, not the site's: it is what makes a bought,
  // warmed-up domain that nobody added visible instead of silently idle.
  assert.match(read("src/lib/sales/sending/engine.ts"), /SENDING_DOMAIN_NAMES/);
});

test("a hostname is matched with its port, its case and its www", () => {
  assert.equal(domains.sendingDomainFor("TryBelline.com:443")?.domain, "trybelline.com");
  assert.equal(domains.sendingDomainFor("www.getbelline.com")?.domain, "getbelline.com");
  assert.equal(domains.sendingDomainFor("bellineai.com.")?.domain, "bellineai.com");
  assert.equal(domains.sendingDomainFor("notbelline.com"), null);
  assert.equal(domains.sendingDomainFor(undefined), null);
});

// --- every domain has a page, and it says the four things ---------------------

for (const domain of domains.SENDING_DOMAINS) {
  const page = today(domain);

  test(`${domain.domain}: the page names its own domain and points at belline.ai`, () => {
    assert.ok(page.includes(domain.domain), "the page does not name the domain it is served on");
    assert.match(page, /href="https:\/\/belline\.ai"/, "no link to the main site");
    assert.match(page, /is not the\s+product/, "the page does not say the domain is not the product");
    assert.match(page, /sends its own business email|Belline sends its own/, "no plain statement of what the domain is for");
  });

  test(`${domain.domain}: the mark and the site's own stylesheet, not a second design`, () => {
    assert.match(page, /<link rel="stylesheet" href="\/site\.css">/, "the page does not use site.css");
    assert.ok(page.includes('class="brand"'), "no Belline lockup");
    assert.ok(page.includes('circle cx="24" cy="24" r="24" fill="#0071E3"'), "not the Belline bell badge");
    assert.ok(page.includes('class="wrap legal"'), "not laid out as a legal-bearing page");
  });

  test(`${domain.domain}: noindex, and no canonical competing with belline.ai`, () => {
    assert.match(page, /<meta name="robots" content="noindex, nofollow">/, "the page may be indexed");
    assert.ok(!/rel="canonical"/.test(page), "a canonical link on a noindex page");
    assert.ok(!page.includes("sitemap"), "the page refers to a sitemap");
  });

  test(`${domain.domain}: the sender identity, exactly as the email footer carries it`, () => {
    const line = unsub.senderIdentityLine(EMPTY);
    assert.equal(line, "Belline", "the empty letterhead is no longer the honest placeholder");
    assert.ok(page.includes(line), "the page does not carry the footer's own identity line");
    // The footer for a real send, built the same way, agrees with the page.
    const footer = unsub.footerFor({
      language: "en",
      url: "https://trybelline.com/u/blu1.1.1.x.y",
      privacyUrl: "https://belline.ai/outreach-privacy",
      entity: EMPTY.entity,
      address: EMPTY.address,
      email: EMPTY.email,
    });
    assert.ok(footer.includes(line), "the email footer and the page disagree about who is writing");
  });

  test(`${domain.domain}: says there is no company yet rather than inventing one`, () => {
    assert.match(page, /not yet a registered company/, "the page is silent about the missing entity");
    assert.deepEqual(notice.placeholderIdentityFields(EMPTY), [], "the identity itself now reads as invented");
    for (const word of ["Example", "Acme", "Ltd.", "123 Main"]) {
      assert.ok(!page.includes(word), `the page invents a company: ${word}`);
    }
  });

  test(`${domain.domain}: a way to stop that needs no old email, and it is true`, () => {
    assert.ok(page.includes(`href="${unsub.UNSUBSCRIBE_PATH}"`), "no link to the unsubscribe page");
    assert.match(page, /no thanks/, "the page does not offer the reply that stops everything");
    assert.match(page, /permanent/, "the page does not say the stop is permanent");
    assert.match(page, /whole business/, "the page does not say the stop covers the whole business");
    // The promise and the matcher, pinned together.
    assert.equal(suppression.looksLikeOptOut("no thanks"), true);
    assert.equal(suppression.looksLikeOptOut("No thanks, we have someone"), true);
    assert.equal(suppression.looksLikeOptOut("No, thank you."), true);
    assert.equal(suppression.looksLikeOptOut("thanks, tell me more"), false, "an interested reply must not be an opt-out");
  });

  test(`${domain.domain}: the privacy link follows what the build actually publishes`, () => {
    // Not published yet: no link to it, and the page says why.
    assert.ok(!page.includes(notice.OUTREACH_PRIVACY_PATH), "links to a notice this build did not write");
    assert.match(page, /neither exists yet/, "no explanation of the missing notice");
    assert.ok(page.includes("/privacy"), "no link to the published privacy policy");
    // Published: the module's URL, not a hand-written one.
    const live = formed(domain);
    assert.ok(
      live.includes(notice.outreachPrivacyUrl({ language: "en" })),
      "the formed page does not link to the outreach privacy notice",
    );
    assert.ok(live.includes("Belline FZ-LLC · Dubai"), "the formed page does not carry the real letterhead");
    assert.ok(!/neither exists yet/.test(live), "the formed page still apologises for a notice that is up");
  });

  test(`${domain.domain}: no sales pitch on a page somebody came to for the exit`, () => {
    for (const bait of ["/checkout", "Get started", "Sign in", "call?start=1"]) {
      assert.ok(!page.includes(bait), `the verification page is selling: ${bait}`);
    }
  });
}

// --- serving ------------------------------------------------------------------

test("a sending domain is a marketing host, and is never indexable", () => {
  for (const name of domains.SENDING_DOMAIN_NAMES) {
    assert.equal(marketing.isMarketingHost(name), true, `${name} would be handed to the dashboard`);
    assert.equal(marketing.indexableRequest(name, {}), false, `${name} would be indexed`);
    assert.equal(marketing.indexableRequest(`www.${name}`, {}), false);
  }
  assert.equal(marketing.indexableRequest("belline.ai", {}), true);
});

test("the built page for each domain is where the server looks for it", () => {
  for (const domain of domains.SENDING_DOMAINS) {
    assert.equal(domains.senderPageFile(domain.domain), `sender/${domain.domain}/index.html`);
  }
  // Built into site/ only by `npm run site`; absent in a fresh checkout, and
  // the server falls back to the landing page rather than 404ing, so this is
  // reported and not failed.
  const missing = domains.SENDING_DOMAINS.filter(
    (d) => !fs.existsSync(path.join(ROOT, "site", domains.senderPageFile(d.domain))),
  );
  if (missing.length > 0) {
    console.log(`      (site/ not built for ${missing.map((d) => d.domain).join(", ")} — run 'npm run site')`);
  }
});

// Rendered, not read: what matters is what a visitor is served, and a source
// file that merely mentions the right words has proved nothing.
const stopHtml = await (await (await import("../src/app/u/route")).GET()).text();

test("the stop page the sender pages link to answers on its own, with no token", () => {
  assert.equal(unsub.UNSUBSCRIBE_PATH, "/u");
  assert.match(stopHtml, /<meta name="robots" content="noindex, nofollow">/, "the stop page may be indexed");
  assert.match(stopHtml, /no thanks/, "the stop page does not name the reply that works");
  assert.ok(stopHtml.includes(EMPTY.email), "the stop page gives no address to write to");
  assert.match(stopHtml, /permanent/, "the stop page does not say the stop is permanent");
  // It must never claim to have done something it cannot do without knowing
  // who is asking — that would be a lie that also loses the request.
  assert.ok(!/you'?re unsubscribed/i.test(stopHtml), "the tokenless page claims to have unsubscribed a stranger");
  // And no form: an address box on an unauthenticated page suppresses
  // somebody else's business.
  assert.ok(!/<form|<input/i.test(stopHtml), "the stop page collects an address");
  assert.match(read("src/app/u/[token]/route.ts"), /stopPage/, "the two stop pages no longer share their shell");
});

console.log(
  failed === 0
    ? `\n\x1b[32m✓ ${passed} passed, 0 failed\x1b[0m\n`
    : `\n\x1b[31m✗ ${passed} passed, ${failed} failed\x1b[0m\n`,
);
process.exit(failed === 0 ? 0 : 1);

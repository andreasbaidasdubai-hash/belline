/**
 * What a machine reads about Belline, and whether it is still true.
 *
 *   npm run check:seo
 *
 * Two artefacts, one problem. `/llms.txt` tells an assistant what Belline is,
 * what it costs, where it works and what it will not do; the JSON-LD tells a
 * search engine and a crawler roughly the same thing in a different notation.
 * Both are summaries of the catalogue, the markets module, the language
 * registry and the flags — and a summary's failure is never that it was wrong
 * when it was written. It is that a price moved on a Tuesday and the summary
 * did not.
 *
 * So nothing here compares the file to a copy of itself. Every assertion
 * recomputes the number from the module that owns it and then looks for it in
 * what shipped. A price change with no rebuild fails this check; a capability
 * claimed with its flag off fails it; a country listed as served that
 * `markets.ts` calls not-yet fails it.
 *
 * The built site is checked when it exists (`npm run site` first, as CI does),
 * and the renderer is always checked, so this is still worth running on a
 * clean tree.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

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

const ORIGIN = "https://belline.ai";
const SITE = process.env.SITE_OUT || "site";

const { renderLlmsTxt, verticalJsonLd, limitLines, marketLines, languageLines, planPrice } = await import("./site-llms");
const { MARKETS, liveMarkets, formatMoney } = await import("../src/lib/markets");
const { PACKS, TRIAL, VIDEO_VOICE_MINUTE_RATIO, priceOf, sellable, productById } = await import("../src/lib/billing/plans");
const { LANGUAGE_REGISTRY } = await import("../src/config/languages");
const { languageUsable } = await import("../src/lib/language");
const { publicFlag } = await import("../src/lib/site-flags");
const { VERTICALS } = await import("./site-content");

const market = liveMarkets()[0] ?? "AE";
/** What this build would write today, whether or not anybody has run the build. */
const fresh = renderLlmsTxt({ origin: ORIGIN, german: true });
/** What the last build actually wrote, when there was one. */
const built = exists(`${SITE}/llms.txt`) ? read(`${SITE}/llms.txt`) : null;

console.log("\n\x1b[1m/llms.txt\x1b[0m\n");

test("the build writes one, at the root, from the generator and not from a file anybody edits", () => {
  assert.match(read("scripts/build-site.ts"), /renderLlmsTxt\(\{ origin: ORIGIN/, "build-site.ts no longer generates llms.txt");
  assert.match(read("scripts/build-site.ts"), /path\.join\(OUT, "llms\.txt"\)/);
  // A hand-written copy in public/ would be copied over the generated one by
  // the asset loop, and then nothing here would ever notice a stale price.
  assert.equal(exists("public/llms.txt"), false, "public/llms.txt exists: two sources of truth, and the hand-written one wins");
  // It has to be served as something a reader reads, not as a download.
  assert.match(read("src/lib/marketing.ts"), /"\.txt": "text\/plain; charset=utf-8"/, "llms.txt would be served as application/octet-stream");
  assert.match(read("public/robots.txt"), /llms\.txt/, "robots.txt does not point at it");
  assert.match(read("public/sitemap.xml"), /<loc>https:\/\/belline\.ai\/llms\.txt<\/loc>/);
  if (built === null) throw new Error(`no ${SITE}/llms.txt — run 'npm run site' (everything below is checked against the renderer as well)`);
});

test("it follows the llms.txt convention: a title, a summary, then sections of links", () => {
  const lines = fresh.split("\n");
  assert.equal(lines[0], "# Belline", "the first line must be the H1 name");
  assert.equal(lines[1], "");
  assert.match(lines[2], /^> /, "the second block must be the blockquote summary");
  assert.ok(fresh.split("\n").filter((l) => l.startsWith("# ")).length === 1, "exactly one H1");
  for (const heading of ["## What it costs", "## Where it works today", "## What it cannot do", "## Pages", "## Contact"]) {
    assert.ok(fresh.includes(heading), `missing section: ${heading}`);
  }
  // Every page link is absolute and on this site: a relative link in a file
  // fetched by an assistant resolves against nothing useful.
  const links = [...fresh.matchAll(/\]\((.*?)\)/g)].map((m) => m[1]);
  assert.ok(links.length >= VERTICALS.length + 1, "the Pages section has lost its links");
  for (const href of links) assert.ok(href.startsWith(`${ORIGIN}/`), `${href} is not an absolute belline.ai address`);
  assert.ok(fresh.endsWith("\n") || fresh.endsWith("#price"), "it should end cleanly");
});

test("every price in it is the catalogue's, today — a price change with no rebuild fails here", () => {
  for (const source of [fresh, built].filter(Boolean) as string[]) {
    for (const p of sellable(market)) {
      const price = planPrice(p, market);
      assert.ok(source.includes(`${p.name} — ${price} a month`), `llms.txt does not quote ${p.name} at ${price} — rebuild the site`);
    }
    // Nothing that looks like a price and is not one of them.
    const quoted = [...source.matchAll(/AED\s[\d,]*\d/g)].map((m) => m[0]);
    const allowed = new Set([
      ...sellable(market).map((p) => planPrice(p, market)),
      ...PACKS.map((k) => formatMoney(k.prices[market] ?? 0, market)),
    ]);
    for (const q of quoted) assert.ok(allowed.has(q), `llms.txt quotes ${q}, which is not a catalogue price`);
    // The trial and the packs, from their own modules.
    assert.ok(source.includes(`${TRIAL.days} days free`), "the trial length drifted");
    assert.ok(source.includes(`${TRIAL.minutes} voice minutes and ${TRIAL.conversations} text conversations`), "the trial allowance drifted");
    for (const pack of PACKS) {
      assert.ok(source.includes(formatMoney(pack.prices[market] ?? 0, market)), `the ${pack.pool} pack price drifted`);
      assert.ok(source.includes(String(pack.units)), `the ${pack.pool} pack size drifted`);
    }
  }
});

test("the markets it names are the markets module's, live and not-yet kept apart", () => {
  const { live, planned } = marketLines();
  for (const source of [fresh, built].filter(Boolean) as string[]) {
    for (const m of live) assert.ok(source.includes(MARKETS[m].name), `${MARKETS[m].name} is live and unnamed`);
    for (const m of planned) {
      assert.ok(source.includes(MARKETS[m].name), `${MARKETS[m].name} is missing from the not-open list`);
    }
    // The one sentence that must not become plural by accident.
    assert.ok(
      source.includes("This is the only place Belline can be bought.") === (live.length === 1),
      "a second market opened, or closed, and the sentence about the only one did not follow",
    );
    for (const m of planned) {
      const before = source.slice(0, source.indexOf("## What it cannot do"));
      assert.equal(
        new RegExp(`\\*\\*Live:\\*\\*[^\\n]*${MARKETS[m].name}`).test(before),
        false,
        `${MARKETS[m].name} is listed as live and markets.ts says it is not`,
      );
    }
  }
});

test("it cannot claim a capability whose flag is off", () => {
  const source = built ?? fresh;
  // Video. The plan lines only mention it with the flag on, and the "cannot
  // do" list only says it is missing with the flag off. Exactly one of the two.
  const claimsVideo = /Video receptionist included/.test(source);
  const denies = /No video receptionist/.test(source);
  assert.equal(claimsVideo, publicFlag("video.avatar"), "llms.txt claims the video receptionist with its flag off (or hides it with the flag on)");
  assert.equal(denies, !publicFlag("video.avatar"), "llms.txt and the video flag disagree about whether there is a video receptionist");
  if (claimsVideo) assert.ok(source.includes(String(VIDEO_VOICE_MINUTE_RATIO)), "the video ratio is claimed without its number");

  // Languages. A language the registry does not call live, and the deployment
  // cannot use, may never appear as one Belline answers in.
  const languages = languageLines();
  assert.deepEqual(
    languages.live,
    LANGUAGE_REGISTRY.filter((l) => languageUsable(l.code)).map((l) => l.name),
    "the language list drifted from the registry",
  );
  assert.ok(source.includes(`**Languages:** ${languages.live.join(", ")}.`), "the languages line is not the registry's");
  // Only the part of the line before "Not yet:" is a claim; what comes after
  // it is the disclaimer, and a language is allowed to be named there.
  const claimed = (source.match(/\*\*Languages:\*\* ([^\n]*)/)?.[1] ?? "").split("Not yet:")[0];
  for (const name of languages.planned) {
    assert.equal(new RegExp(`\\b${name}\\b`).test(claimed), false, `${name} is offered as a language Belline answers in, and it is not`);
  }
  // Arabic in particular: a UAE product that does not speak Arabic has to say so.
  assert.ok(
    languageUsable("ar") || /Arabic is built and not switched on/.test(source),
    "Arabic is not live and llms.txt does not say so",
  );

  // Calendar writes.
  const calendars = publicFlag("booking.google") || publicFlag("booking.outlook") || publicFlag("booking.calendly");
  assert.equal(/No calendar writes yet/.test(source), !calendars, "llms.txt and the booking flags disagree");

  // And the one thing it must always say, because a clinic is the example in
  // the brief and the answer has to be findable without placing a call.
  assert.ok(/No medical, legal or financial advice/.test(source));
  assert.ok(limitLines().length >= 4, "the limits section has emptied out");
});

console.log("\n\x1b[1mStructured data\x1b[0m\n");

/** Every JSON-LD graph on a built page, parsed. */
function graphsIn(html: string): Record<string, unknown>[] {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  return blocks.flatMap((m) => {
    const parsed = JSON.parse(m[1]) as { "@graph"?: Record<string, unknown>[] };
    return parsed["@graph"] ?? [parsed as Record<string, unknown>];
  });
}

const landingPages: { label: string; html: string }[] = [
  { label: "landing", html: read("public/landing.html") },
  { label: "landing.de", html: read("public/landing.de.html") },
];
const builtPages: { label: string; html: string }[] = exists(`${SITE}/index.html`)
  ? [
      { label: `${SITE}/index.html`, html: read(`${SITE}/index.html`) },
      ...VERTICALS.map((v) => ({ label: `${SITE}/${v.slug}`, html: read(`${SITE}/${v.slug}/index.html`) })),
      ...["de-de", "de-at", "de-ch"].filter((d) => exists(`${SITE}/${d}/index.html`)).map((d) => ({ label: `${SITE}/${d}`, html: read(`${SITE}/${d}/index.html`) })),
    ]
  : [];

test("every page that carries structured data carries valid JSON, one Organization, and an @id others can point at", () => {
  for (const page of [...landingPages, ...builtPages]) {
    const graph = graphsIn(page.html);
    assert.ok(graph.length > 0, `${page.label} has no structured data`);
    const org = graph.find((n) => n["@type"] === "Organization");
    assert.ok(org, `${page.label} names no Organization`);
    assert.equal(org!["@id"], `${ORIGIN}/#organization`, `${page.label}'s Organization has no stable @id`);
    assert.equal(org!.name, "Belline");
    for (const node of graph) assert.ok(node["@type"], `${page.label} has a node with no @type`);
  }
});

test("the Organization names the contact channels that actually exist, and serves only the live markets", () => {
  for (const page of landingPages) {
    const org = graphsIn(page.html).find((n) => n["@type"] === "Organization") as Record<string, unknown>;
    assert.equal(org.email, "hello@belline.ai", `${page.label}: the contact email drifted`);
    assert.ok(typeof org.telephone === "string" && (org.telephone as string).startsWith("+"), `${page.label}: no reachable telephone`);
    const points = org.contactPoint as Record<string, unknown>[];
    assert.ok(Array.isArray(points) && points.length >= 1, `${page.label}: no contactPoint`);
    for (const point of points) {
      assert.equal(point["@type"], "ContactPoint");
      assert.equal(point.email, "hello@belline.ai");
      assert.deepEqual(point.availableLanguage, ["English"], "a contact point offers a language nobody there speaks");
    }
    // areaServed is a claim about where Belline works, and markets.ts owns it.
    const served = org.areaServed as { name?: string };
    assert.deepEqual(
      [served?.name],
      liveMarkets().map((m) => MARKETS[m].name),
      `${page.label}: areaServed and the live markets disagree`,
    );
  }
});

test("the plans are offers with a real price, a real currency and a period — and PreOrder where nothing is for sale", () => {
  if (!builtPages.length) throw new Error(`no built site — run 'npm run site'`);
  for (const page of builtPages) {
    const graph = graphsIn(page.html);
    const app = graph.find((n) => n["@type"] === "SoftwareApplication") as Record<string, unknown> | undefined;
    const service = graph.find((n) => n["@type"] === "Service") as Record<string, unknown> | undefined;
    assert.ok(app || service, `${page.label} describes neither the software nor the service`);

    if (app) {
      assert.equal(app.provider && (app.provider as Record<string, string>)["@id"], `${ORIGIN}/#organization`, `${page.label}: the app names no provider`);
      const offers = app.offers as Record<string, unknown>[];
      assert.ok(Array.isArray(offers) && offers.length > 0, `${page.label}: no offers`);
      const dach = /de-(de|at|ch)/.test(page.label);
      for (const offer of offers) {
        assert.equal(offer["@type"], "Offer");
        assert.ok(typeof offer.price === "string" && Number(offer.price) > 0, `${page.label}: an offer with no price`);
        assert.ok(typeof offer.priceCurrency === "string" && (offer.priceCurrency as string).length === 3, `${page.label}: an offer with no currency`);
        // schema.org has no Offer.billingIncrement. It belongs on the price
        // specification, and without one the reader cannot tell a monthly
        // subscription from a one-off payment.
        assert.equal("billingIncrement" in offer, false, `${page.label}: billingIncrement is back on the Offer, where schema.org has no such property`);
        const spec = offer.priceSpecification as Record<string, unknown>;
        assert.equal(spec?.["@type"], "UnitPriceSpecification", `${page.label}: an offer that does not say it is monthly`);
        assert.equal(spec.unitCode, "MON");
        assert.equal(spec.price, offer.price, `${page.label}: the offer and its price specification disagree`);
        assert.equal(
          offer.availability,
          dach ? "https://schema.org/PreOrder" : "https://schema.org/InStock",
          `${page.label}: a waitlist page offering something for sale, or the other way round`,
        );
      }
      if (!dach) {
        // The three prices are the catalogue's three prices, in order.
        assert.deepEqual(
          offers.map((o) => `${o.priceCurrency} ${o.price}`),
          sellable(market).map((p) => `${MARKETS[market].currency} ${priceOf(p.id, market) / 100}`),
          `${page.label}: the structured-data prices are not the catalogue's — rebuild the site`,
        );
        assert.deepEqual(
          offers.map((o) => o.name),
          sellable(market).map((p) => `Belline ${p.name}`),
        );
        for (const [i, offer] of offers.entries()) {
          assert.equal(offer.description, productById(sellable(market)[i].id).summary, `${page.label}: an offer's description is not the product's`);
        }
      }
    }

    if (service) {
      const aggregate = service.offers as Record<string, unknown>;
      assert.equal(aggregate["@type"], "AggregateOffer");
      assert.equal(aggregate.priceCurrency, MARKETS[market].currency);
      const prices = sellable(market).map((p) => priceOf(p.id, market) / 100);
      assert.equal(aggregate.lowPrice, String(Math.min(...prices)), `${page.label}: the cheapest plan drifted`);
      assert.equal(aggregate.highPrice, String(Math.max(...prices)), `${page.label}: the dearest plan drifted`);
      assert.equal(aggregate.offerCount, String(prices.length));
    }
  }
});

test("the sector pages say who provides the service, where, and where they sit", () => {
  if (!builtPages.length) throw new Error(`no built site — run 'npm run site'`);
  for (const v of VERTICALS) {
    const html = read(`${SITE}/${v.slug}/index.html`);
    const graph = graphsIn(html);
    const service = graph.find((n) => n["@type"] === "Service") as Record<string, unknown>;
    assert.ok(service, `/${v.slug} still has no Service`);
    assert.equal(service.description, v.description, `/${v.slug}: the Service description and the page's own differ`);
    assert.equal(service.url, `${ORIGIN}/${v.slug}`);
    assert.equal((service.provider as Record<string, string>)["@id"], `${ORIGIN}/#organization`);
    assert.deepEqual(
      (service.areaServed as { name: string }[]).map((c) => c.name),
      liveMarkets().map((m) => MARKETS[m].name),
      `/${v.slug}: areaServed and the live markets disagree`,
    );
    const crumbs = graph.find((n) => n["@type"] === "BreadcrumbList") as Record<string, unknown>;
    assert.ok(crumbs, `/${v.slug} has no breadcrumb`);
    assert.deepEqual((crumbs.itemListElement as { name: string }[]).map((i) => i.name), ["Belline", v.name]);
    // And the generator is the only author of it.
    assert.match(read("scripts/build-site.ts"), /\$\{verticalJsonLd\(v, ORIGIN\)\}/, "the sector JSON-LD is no longer generated");
    // The languages the channel offers are the ones Belle actually speaks.
    const channel = service.availableChannel as Record<string, unknown>;
    assert.deepEqual(channel.availableLanguage, languageLines().live, `/${v.slug}: a channel offers a language Belle does not speak`);
  }
  // The rendered graph and the shipped one are the same graph.
  for (const v of VERTICALS) {
    assert.ok(read(`${SITE}/${v.slug}/index.html`).includes(verticalJsonLd(v, ORIGIN)), `/${v.slug}'s structured data is stale — rebuild the site`);
  }
});

test("the FAQ in the structured data is still the FAQ on the page, and says nothing the flags deny", () => {
  const graph = graphsIn(read("public/landing.html"));
  const faq = graph.find((n) => n["@type"] === "FAQPage") as Record<string, unknown>;
  assert.ok(faq, "the landing page lost its FAQPage");
  const questions = faq.mainEntity as { name: string; acceptedAnswer: { text: string } }[];
  assert.ok(questions.length >= 10, "the FAQ shrank");
  for (const q of questions) {
    assert.ok(q.name.trim().length > 0 && q.acceptedAnswer.text.trim().length > 0, `an empty FAQ entry: ${q.name}`);
  }
  // `public/landing.html` is the flag-off page by construction: src/lib/site-flags.ts
  // splices the two video questions into this array when the flag is on, and
  // reverts them when it is not. A video question checked in here would be one
  // the revert could never take out again, and the page would claim a video
  // receptionist on a deployment that has none.
  assert.deepEqual(
    questions.filter((q) => /video/i.test(q.name)).map((q) => q.name),
    [],
    "public/landing.html has a video question written into its structured data; it belongs in src/lib/site-flags.ts, behind the flag",
  );
});

console.log(
  failed === 0
    ? `\n\x1b[32m✓ ${passed} passed, 0 failed\x1b[0m\n`
    : `\n\x1b[31m✗ ${passed} passed, ${failed} failed\x1b[0m\n`,
);
process.exit(failed === 0 ? 0 : 1);

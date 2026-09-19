/**
 * The location landing pages, checked against the two ways they can go wrong.
 *
 * They can go wrong *technically* — a page with no canonical, a link to a URL
 * this build did not write, a sitemap that has fallen behind the pages. Those
 * are the easy half and the first section below is all of them.
 *
 * They can also go wrong in the way that actually matters, which is by being
 * dishonest or by being filler. This is a system that turns two data files
 * into thirty pages, and that is precisely the shape of thing Google's
 * scaled-content-abuse policy is written about. Two rules, and they are the
 * reason this file exists:
 *
 *  - **A page for a market that is not live never carries a way to buy.**
 *    `src/lib/markets.ts` says AE is live and GB and IE are not, and the
 *    checkout refuses a market that is not live. A London page with a "Get
 *    started" button would send a reader to a checkout that turns them away,
 *    having told them on the way that we serve their city. So: no checkout
 *    link, no price, no trial sentence, no offer in the structured data, and
 *    the waitlist instead — exactly what the German pages do.
 *
 *  - **Enough of each page is its own.** Every page shares the chrome, the
 *    channels and the three steps, and that is fine. What is not fine is a
 *    page whose only difference from its neighbour is a substituted city name.
 *    `uniqueShare` below measures, per page, what proportion of its visible
 *    sentences appear on no other page in the matrix, and the build fails
 *    under the floor. Arithmetic rather than good intentions, because good
 *    intentions are what produce a thousand pages about plumbers in a
 *    thousand towns.
 *
 *   npm run check:seo
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { SEO_VERTICALS } = await import("./seo/verticals");
const { SEO_CITIES, inCity } = await import("./seo/cities");
const { SEO_PAIRS } = await import("./seo/pairs");
const { MARKETS } = await import("../src/lib/markets");
const matrix = await import("./seo/matrix");
const { faqsFor } = await import("./seo/render");

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

function head(title: string) {
  console.log(`\n\x1b[1m${title}\x1b[0m\n`);
}

const OUT = process.env.SITE_OUT || "site";
const PAGES = matrix.seoPages();

/** The built HTML of every generated page, by its URL path. */
const BUILT = new Map<string, string>();
for (const page of PAGES) {
  const file = path.join(OUT, page.path.replace(/^\//, ""), "index.html");
  if (fs.existsSync(file)) BUILT.set(page.path, fs.readFileSync(file, "utf8"));
}

/** Visible text, with the markup, the scripts and the structured data taken out. */
function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/i, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    // Decoded rather than blanked: `&#39;` is an apostrophe, and turning it
    // into a space made "Sharjah's" into two words, which made every
    // comparison with the copy that produced it fail for no reason.
    .replace(/&#39;/g, "’")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&[a-z]+;|&#\d+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Sentences, roughly: enough to compare two pages without a parser. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length >= 40);
}

head("Every page was built, and is findable");

test("every page in the matrix was written to disk", () => {
  assert.ok(PAGES.length > 0, "the build published no location pages at all");
  for (const page of PAGES) {
    assert.ok(BUILT.has(page.path), `${page.path} was not built — run npm run site first`);
  }
});

test("a combination listed for publication has copy written for it", () => {
  assert.deepEqual(matrix.missingPairCopy(), [], "a page is listed to publish with no pair copy");
});

test("every pair of copy names a trade and a city that exist", () => {
  for (const key of Object.keys(SEO_PAIRS)) {
    const [vertical, city] = key.split("/");
    assert.ok(SEO_VERTICALS.some((v) => v.slug === vertical), `pairs.ts has "${key}" and there is no trade "${vertical}"`);
    assert.ok(SEO_CITIES.some((c) => c.slug === city), `pairs.ts has "${key}" and there is no city "${city}"`);
  }
});

test("the sitemap lists exactly the pages the build wrote", () => {
  const xml = fs.readFileSync(path.join(OUT, "sitemap.xml"), "utf8");
  for (const page of PAGES) {
    assert.ok(xml.includes(`<loc>${matrix.ORIGIN}${page.path}</loc>`), `${page.path} is not in the sitemap`);
  }
  // And nothing in the sitemap that is not on disk: a listed URL that 404s is
  // worse than one that is missing.
  const listed = [...xml.matchAll(/<loc>https:\/\/belline\.ai(\/ai-receptionist[^<]*)<\/loc>/g)].map((m) => m[1]);
  for (const url of listed) assert.ok(BUILT.has(url), `the sitemap lists ${url} and the build did not write it`);
});

head("The head of every page is complete");

for (const page of PAGES) {
  test(`${page.path} — title, description, canonical, hreflang, Open Graph`, () => {
    const html = BUILT.get(page.path)!;
    const title = /<title>([^<]+)<\/title>/.exec(html);
    assert.ok(title && title[1].trim().length > 20, "no usable <title>");
    assert.ok(title![1].length <= 75, `the title is ${title![1].length} characters and will be cut in a result: ${title![1]}`);

    // Measured decoded: `&#39;` is one character to a reader and to Google,
    // and six to a regular expression.
    const desc = /<meta name="description" content="([^"]+)">/.exec(html);
    assert.ok(desc, "no meta description");
    const written = desc![1].replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
    assert.ok(written.length >= 70, "the meta description is too short to say anything");
    assert.ok(written.length <= 170, `the description is ${written.length} characters and will be cut: ${written}`);

    assert.ok(html.includes(`<link rel="canonical" href="${matrix.ORIGIN}${page.path}">`), "the canonical does not point at this page");
    assert.match(html, /<link rel="alternate" hreflang="en" href="https:\/\/belline\.ai\/ai-receptionist[^"]*">/, "no hreflang");
    assert.match(html, /<link rel="alternate" hreflang="x-default"/, "no x-default");
    assert.ok(html.includes(`<meta property="og:url" content="${matrix.ORIGIN}${page.path}">`), "og:url is wrong");
    assert.match(html, /<meta property="og:image" content="[^"]+">/, "no og:image");
    assert.match(html, /<meta name="twitter:card" content="summary_large_image">/, "no twitter card");
  });
}

head("The structured data says what the page says");

for (const page of PAGES) {
  test(`${page.path} — JSON-LD parses, and its FAQ is the FAQ on the page`, () => {
    const html = BUILT.get(page.path)!;
    const block = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
    assert.ok(block, "no JSON-LD at all");
    const data = JSON.parse(block![1]) as { "@graph": Record<string, unknown>[] };
    assert.ok(Array.isArray(data["@graph"]) && data["@graph"].length > 0, "an empty @graph");

    const types = data["@graph"].map((n) => n["@type"]);
    assert.ok(types.includes("BreadcrumbList"), "no BreadcrumbList");

    if (page.kind === "combo") {
      assert.ok(types.includes("Service"), "a landing page with no Service");
      assert.ok(types.includes("SoftwareApplication"), "a landing page with no SoftwareApplication");
      const faqNode = data["@graph"].find((n) => n["@type"] === "FAQPage") as
        | { mainEntity: { name: string; acceptedAnswer: { text: string } }[] }
        | undefined;
      assert.ok(faqNode, "a landing page with no FAQPage");
      const expected = faqsFor(page.vertical, page.pair);
      assert.equal(faqNode!.mainEntity.length, expected.length, "the structured FAQ and the written FAQ are different lengths");
      assert.ok(expected.length >= 6 && expected.length <= 8, `${expected.length} FAQs — the page wants six to eight`);
      const text = visibleText(html);
      for (const [i, q] of expected.entries()) {
        assert.equal(faqNode!.mainEntity[i].name, q.q, "the structured question is not the question on the page");
        assert.equal(faqNode!.mainEntity[i].acceptedAnswer.text, q.a, `the structured answer to "${q.q}" is not the one on the page`);
        // And both are actually visible, so the markup is not making a claim
        // to a search engine that a reader cannot see.
        assert.ok(text.includes(q.q.replace(/[’']/g, "’")) || text.includes(q.q), `"${q.q}" is in the JSON-LD and not on the page`);
      }
    }
  });
}

head("Nothing links to a page that does not exist");

for (const page of PAGES) {
  test(`${page.path} — every internal link resolves, and it links to its neighbours`, () => {
    const html = BUILT.get(page.path)!;
    const hrefs = [...html.matchAll(/href="(\/[^"#]*)(?:#[^"]*)?"/g)].map((m) => m[1]).filter(Boolean);
    for (const href of new Set(hrefs)) {
      if (href.startsWith("/ai-receptionist")) {
        assert.ok(BUILT.has(href.replace(/\/$/, "")), `links to ${href}, which this build did not write`);
        continue;
      }
      // Everything else has to be a file or a directory-with-an-index in the
      // build output. Catches /salons after somebody renames a trade page.
      const target = path.join(OUT, href.replace(/^\//, ""));
      const ok = href === "/" || fs.existsSync(target) || fs.existsSync(`${target}.html`) || fs.existsSync(path.join(target, "index.html"));
      assert.ok(ok, `links to ${href}, which is not in ${OUT}/`);
    }
    // A page nothing links out of is an orphan in the other direction.
    const internal = hrefs.filter((h) => h.startsWith("/ai-receptionist") && h !== page.path);
    assert.ok(internal.length >= 2, `only ${internal.length} links to the rest of the matrix`);
  });
}

head("A market we are not open in is never sold to");

for (const page of PAGES) {
  const city = "city" in page ? page.city : undefined;
  if (!city) continue;
  const live = matrix.marketLive(city);
  test(`${page.path} — ${city.name} is ${live ? "live, so it sells" : "not live, so it sells nothing"}`, () => {
    const html = BUILT.get(page.path)!;
    if (live) {
      assert.match(html, /app\.belline\.ai\/checkout/, "a live market's page has no way to buy");
      return;
    }

    // The three things that would make this page a lie, in descending order of
    // how badly: a checkout link, a price, and a trial offer.
    assert.doesNotMatch(html, /app\.belline\.ai\/checkout/, "a page for a market we cannot sell in links to the checkout");
    assert.doesNotMatch(html, /data-cta="plan-/, "a pricing card reached a page for a market we cannot sell in");
    const currency = MARKETS[city.market].currency;
    const prefix = MARKETS[city.market].prefix.trim();
    assert.ok(
      !new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s?\\d`).test(html),
      `a price in ${currency} reached the ${city.name} page`,
    );
    assert.doesNotMatch(html, /\b\d+ days free\b/, "a trial offer reached a page nobody can start a trial from");
    assert.doesNotMatch(html, /Get started/, `"Get started" reached the ${city.name} page`);

    // And it must positively say so and offer the one thing it can.
    assert.match(html, /not open in/i, `the ${city.name} page never says we are not open there`);
    assert.match(html, /api\/leads\/waitlist/, "no waitlist form to join instead");
    assert.match(html, /id="waitlist"/, "the waitlist has no anchor for the header and hero to point at");
  });
}

test("every waitlist country on a built page is a market we cannot sell in", () => {
  for (const [page, html] of BUILT) {
    for (const m of [...html.matchAll(/<option value="([A-Z]{2})"/g)].map((x) => x[1])) {
      assert.ok(m in MARKETS, `${page} offers a country "${m}" that is not a market`);
      assert.equal(MARKETS[m as "GB"].status, "not-yet", `${page}'s waitlist offers ${m}, which is on sale`);
    }
  }
});

head("Nothing unfinished, invented or borrowed");

/**
 * Words that mean somebody meant to come back to this. `lorem` and the rest
 * are obvious; `{{` and `${` catch a template expression that was written into
 * a data file as text and never evaluated, which is the way this actually
 * happens.
 */
const UNFINISHED = [/lorem ipsum/i, /\bTODO\b/, /\bTBD\b/, /\bFIXME\b/, /\bXXX\b/, /\{\{/, /\$\{/, /\bplaceholder\b/i, /\[insert/i];

/**
 * The claims we have no evidence for.
 *
 * A percentage, a "join N businesses", a star rating, a customer count. None
 * of these has ever been measured here, and a single one of them on a page
 * like this turns the whole set into marketing nobody should believe.
 */
/**
 * The only percentages allowed on one of these pages: the allowance warnings
 * the catalogue itself writes (`overLimitSentence`, src/lib/billing/speak.ts),
 * which appear in the pricing block. Read from the sentence rather than typed,
 * so a change to the catalogue moves this with it.
 */
const { overLimitSentence } = await import("../src/lib/billing/speak");
const ALLOWED_PERCENTAGES = new Set([...overLimitSentence().matchAll(/\d{1,3}(?:\.\d+)?\s?%/g)].map((m) => m[0].replace(/\s/g, "")));

const UNEVIDENCED: [RegExp, string][] = [
  [/\b\d+[,.]?\d*\s?(?:\+|plus)?\s*(?:businesses|customers|clients|salons|restaurants|clinics|practices|venues)\b/i, "a customer count"],
  [/\b(?:trusted|loved|used) by\b/i, "a trust claim"],
  [/\b\d(?:\.\d)?\s*(?:out of 5|\/5|stars?)\b/i, "a rating"],
  [/\b\d+\s*(?:reviews|testimonials)\b/i, "a review count"],
  [/\bon average\b/i, "an average"],
  [/\b(?:studies|research) shows?\b/i, "a study"],
];

for (const page of PAGES) {
  test(`${page.path} — no unfinished text, no invented numbers`, () => {
    const text = visibleText(BUILT.get(page.path)!);
    for (const pattern of UNFINISHED) {
      assert.doesNotMatch(text, pattern, `unfinished text matching ${pattern}`);
    }
    for (const [pattern, what] of UNEVIDENCED) {
      const hit = pattern.exec(text);
      assert.equal(hit, null, `${what} on the page, which nobody has measured: "${hit?.[0]}"`);
    }
    // Percentages get their own rule rather than a flat ban, because there are
    // two honest ones on the site: the catalogue's own "we tell you at 70%,
    // 90% and 100%" of an allowance. Anything else is a statistic somebody
    // typed, and there is no third kind.
    for (const [, figure] of text.matchAll(/\b(\d{1,3}(?:\.\d+)?\s?%)/g)) {
      assert.ok(
        ALLOWED_PERCENTAGES.has(figure.replace(/\s/g, "")),
        `"${figure}" is a statistic on ${page.path}, and nobody has measured it`,
      );
    }
  });
}

test("the space for a customer story is empty on purpose, and says so", () => {
  for (const page of PAGES) {
    if (page.kind !== "combo") continue;
    const html = BUILT.get(page.path)!;
    assert.match(html, /data-case-study="pending"/, `${page.path} has lost the customer-story section`);
    const text = visibleText(html);
    assert.match(text, /no testimonial here yet/i, `${page.path} does not say the space is empty`);
    // A quotation mark around a sentence in that section would be somebody
    // having filled it in with something nobody said.
    assert.doesNotMatch(text, /“[^”]{25,}”\s*—\s*[A-Z]/, `${page.path} has grown a testimonial`);
  }
});

test("no page claims Belline speaks a language it does not", () => {
  for (const [page, html] of BUILT) {
    const text = visibleText(html);
    assert.doesNotMatch(text, /Belline (?:answers|speaks) in Arabic/i, `${page} claims Arabic`);
    assert.doesNotMatch(text, /answers in (?:Arabic|Hindi|Urdu|Malayalam|Tagalog|Irish)/i, `${page} claims a language we do not answer in`);
  }
});

test("no page offers a time, a slot or a confirmed booking", () => {
  // The same promise as check-honesty, turned on the marketing pages: Belline
  // takes requests and a person confirms them. A landing page that says
  // "books it straight into your calendar" is selling something that does not
  // exist yet, and the sales conversation that follows is unrecoverable.
  for (const [page, html] of BUILT) {
    const text = visibleText(html);
    assert.doesNotMatch(text, /books? (?:it )?(?:straight )?into your (?:calendar|diary|system)/i, `${page} promises a calendar booking`);
    assert.doesNotMatch(text, /confirms the (?:appointment|booking|table) (?:itself|automatically)/i, `${page} promises an automatic confirmation`);
  }
});

head("Each page is mostly its own");

/**
 * What share of a page's sentences appear nowhere else in the matrix.
 *
 * Measured over visible text with the head, the scripts and the SVGs removed,
 * and only over sentences long enough to be sentences — the nav, the footer
 * and the button labels are shared by design and counting them would flatter
 * every page equally.
 */
function uniqueShare(page: string): number {
  const mine = sentences(visibleText(BUILT.get(page)!));
  if (mine.length === 0) return 0;
  const others = new Set<string>();
  for (const [other, html] of BUILT) {
    if (other === page) continue;
    for (const s of sentences(visibleText(html))) others.add(s);
  }
  return mine.filter((s) => !others.has(s)).length / mine.length;
}

/**
 * The floor.
 *
 * Forty per cent of a landing page being written for that page alone is the
 * brief, and it is also about the point at which a reader stops feeling they
 * have seen this page before. The hubs are indexes and are allowed to be
 * thinner, but not much: a hub that is only a list of links is a doorway page.
 */
const FLOOR = { combo: 0.4, hub: 0.3 };

for (const page of PAGES) {
  const floor = page.kind === "combo" ? FLOOR.combo : FLOOR.hub;
  test(`${page.path} — at least ${Math.round(floor * 100)}% of it is written for this page`, () => {
    const share = uniqueShare(page.path);
    assert.ok(
      share >= floor,
      `only ${(share * 100).toFixed(0)}% of this page's sentences appear on no other page. ` +
        "Write more of scripts/seo/pairs.ts for it, or do not publish it.",
    );
  });
}

test("no two pages share a title or a meta description", () => {
  const titles = new Map<string, string>();
  const descriptions = new Map<string, string>();
  for (const [page, html] of BUILT) {
    const title = /<title>([^<]+)<\/title>/.exec(html)![1];
    const desc = /<meta name="description" content="([^"]+)">/.exec(html)![1];
    assert.ok(!titles.has(title), `${page} and ${titles.get(title)} have the same title`);
    assert.ok(!descriptions.has(desc), `${page} and ${descriptions.get(desc)} have the same description`);
    titles.set(title, page);
    descriptions.set(desc, page);
  }
});

test("every landing page's H1 names the trade and the city", () => {
  for (const page of PAGES) {
    if (page.kind !== "combo") continue;
    const h1 = /<h1[^>]*>([^<]+)<\/h1>/.exec(BUILT.get(page.path)!);
    assert.ok(h1, `${page.path} has no H1`);
    assert.ok(h1![1].includes(page.vertical.plural), `${page.path}'s H1 does not name the trade`);
    assert.ok(h1![1].includes(page.city.name), `${page.path}'s H1 does not name the city`);
    assert.equal((BUILT.get(page.path)!.match(/<h1/g) ?? []).length, 1, `${page.path} has more than one H1`);
  }
});

head("The data behind it holds together");

test("every trade and every city is complete enough to publish", () => {
  for (const v of SEO_VERTICALS) {
    assert.ok(v.pains.length >= 3, `${v.slug}: fewer than three pain points`);
    assert.ok(v.callTypes.length >= 4, `${v.slug}: fewer than four call types`);
    assert.ok(v.faqs.length >= 6 && v.faqs.length <= 8, `${v.slug}: ${v.faqs.length} FAQs, wanted six to eight`);
    assert.ok(v.boundary.length > 80, `${v.slug}: the boundary is too short to mean anything`);
  }
  for (const c of SEO_CITIES) {
    assert.ok(c.market in MARKETS, `${c.slug}: "${c.market}" is not a market`);
    for (const field of ["languages", "week", "peak", "habits", "emergency", "intro"] as const) {
      assert.ok(String(c[field]).length > 20, `${c.slug}: ${field} is empty or a stub`);
    }
    assert.ok(inCity(c).startsWith("in "), `${c.slug}: the preposition phrase reads wrong`);
  }
});

test("a pair has real local substance rather than the city's name in the trade's paragraph", () => {
  for (const [key, pair] of Object.entries(SEO_PAIRS)) {
    const city = SEO_CITIES.find((c) => c.slug === key.split("/")[1])!;
    assert.ok(pair.local.length >= 3, `${key}: fewer than three local paragraphs`);
    assert.ok(pair.faqs.length >= 1, `${key}: no question that is only asked here`);
    const body = pair.local.map((l) => l.body).join(" ");
    assert.ok(body.length > 900, `${key}: ${body.length} characters of local copy is a template with a name in it`);
    assert.ok(body.includes(city.name), `${key}: the local copy never names ${city.name}`);
  }
});

test("the full matrix is thirty landing pages, and every URL is a legal path", () => {
  assert.equal(SEO_VERTICALS.length * SEO_CITIES.length, 30, "the matrix is no longer five trades by six cities");
  assert.equal(matrix.MATRIX.length, 30);
  for (const url of matrix.allMatrixUrls()) {
    assert.match(url, /^https:\/\/belline\.ai\/ai-receptionist\/[a-z0-9-]+\/[a-z0-9-]+$/, `${url} is not a clean URL`);
  }
  // The two hub namespaces must not be able to collide.
  for (const c of SEO_CITIES) {
    assert.ok(!SEO_VERTICALS.some((v) => v.slug === c.slug), `"${c.slug}" is both a city and a trade`);
  }
});

console.log(
  failed === 0
    ? `\n\x1b[32m✓ ${passed} passed, 0 failed\x1b[0m  (${BUILT.size} pages checked)\n`
    : `\n\x1b[31m✗ ${passed} passed, ${failed} failed\x1b[0m\n`,
);
process.exit(failed === 0 ? 0 : 1);

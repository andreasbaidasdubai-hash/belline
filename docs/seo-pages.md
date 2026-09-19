# The location landing pages

`/ai-receptionist/<trade>/<city>` — one page per trade-and-city combination,
plus a hub per trade, a hub per city, and an index over the lot. They are
built by `npm run site` into `site/`, served by the app's own server for
non-app hostnames (`src/lib/marketing.ts`), and checked by `npm run check:seo`.

They are part of the existing marketing site, not a second one. Same
`public/site.css`, same `public/site.js`, same header and footer
(`scripts/site-chrome.ts`), same prices out of `src/lib/billing/plans.ts`, same
demo call scenes as the trade pages. Nothing here introduces a framework, a
design system or a source of prices.

---

## Where everything lives

| File | What it holds | When you change it |
|---|---|---|
| `scripts/seo/verticals.ts` | What is true about a **trade** — pain points, call types, the boundary, six to eight FAQs, hub copy | You learn something about the trade |
| `scripts/seo/cities.ts` | What is true about a **city** — languages, working week, peak hours, booking habits, emergency number, districts, hub copy | You learn something about the city |
| `scripts/seo/pairs.ts` | What is only true where the two **meet** — the hero lead, the meta description, three or four local paragraphs, the questions asked only here | Somebody sits down and writes about that combination |
| `scripts/seo/matrix.ts` | Which combinations are published, and every URL | You publish or unpublish a page |
| `scripts/seo/render.ts` | The four page shapes | The pages need a new section |
| `scripts/check-seo.ts` | Everything below that can be checked by a machine | You add a rule |

The three-way split is not tidiness. A trade file changes for trade reasons, a
city file for city reasons, and a pair file only when a person writes something
new — three different cadences, three files.

---

## Adding a city

1. **Add the entry** to `SEO_CITIES` in `scripts/seo/cities.ts`. Every field is
   required and every field has to be a fact somebody could check: the working
   week, the languages callers actually use, the emergency number Belline is
   given there, real districts. `market` is the important one — it is a code
   from `src/lib/markets.ts`, and it decides on its own whether the page can be
   bought from or has to carry the waitlist.
2. **Write the pairs.** For every trade you want a page for, add a
   `"<trade>/<city>"` entry to `SEO_PAIRS` in `scripts/seo/pairs.ts`. This is
   the work. There is no fallback and there is deliberately no template: a
   combination with no pair copy is simply not published, and one listed for
   publication with no pair copy fails the build.
3. **List the combinations** in `FIRST_PASS` in `scripts/seo/matrix.ts`, or set
   `SEO_PAGES=all` to publish everything that has pair copy.
4. `npm run site && npm run check:seo`.

The hubs, the internal links, the sitemap entries, the hreflang block and the
breadcrumbs all follow from the data. Nothing else needs touching.

## Adding a trade

1. **Add the entry** to `SEO_VERTICALS` in `scripts/seo/verticals.ts`. Point
   `tradePage` at the existing page under `/salons`, `/dental`, `/clinics` or
   `/restaurants` if one fits — the landing pages take their demo call scenes
   from it, so the call you hear on `/ai-receptionist/spas/dubai` is the
   recorded one, not a second script that will drift.
2. Reuse an image already in `public/img/`. A new photograph is a separate
   decision, not a side effect of adding a page.
3. Write the pairs, list the combinations, build and check — steps 2 to 4
   above.

## Publishing more of the matrix

`FIRST_PASS` in `scripts/seo/matrix.ts` lists what a normal build writes. It is
three pages on purpose, so the quality could be judged before thirty went out
under one domain. To build everything that has pair copy:

```
SEO_PAGES=all npm run site && SEO_PAGES=all npm run check:seo
```

Moving from three to thirty is: write twenty-seven pair entries, then either
add them to `FIRST_PASS` or make `SEO_PAGES=all` the default. No code changes.

---

## The rules, and which of them the check enforces

### A market we are not open in is never sold to

`src/lib/markets.ts` says `AE` is `live` and `GB` and `IE` are `not-yet`, and
the checkout refuses a market that is not live. So a London page that said
"Get started" would walk somebody into a checkout that turns them away, having
told them on the way that we serve their city.

Pages for those cities carry the waitlist instead, exactly as the German
pages do: no checkout link, no price in the local currency, no trial offer, no
`Offer` in the structured data, and a hero that says in the first paragraph
that we are not open there. `check:seo` fails the build on every one of those.

Nothing about this is written in the copy. `marketLive(city)` reads the market
table, and the day `GB` flips to `live` the London pages grow a buy button and
lose the waitlist without a word being edited.

### At least 40% of each landing page is its own

`check:seo` measures it. For every published page it takes the visible
sentences, subtracts the ones that appear on any other page in the system, and
fails under 40% for a landing page and 30% for a hub.

That number is why the page sections are split the way they are: pain points
live on the trade hub and call types on the landing pages, so a hub and the
page under it are not the same document; the city hub carries the four-up city
facts and the landing page carries two of them; the landing page's FAQ is up to
four pair questions and four trade questions, so half of it is written for that
page alone. If a new page comes in under the floor, the answer is to write more
of its pair copy, not to lower the floor.

### Nothing invented

No statistics, no percentages except the catalogue's own allowance warnings, no
customer counts, no ratings, no review counts, no "trusted by", no testimonials
and no logos. `check:seo` greps for all of them. The space where a real
customer story will go carries a section saying plainly that it is empty and
why — that is a true sentence, not a placeholder, and the check makes sure it
stays that way and that no quotation ever appears in it.

The check also refuses `TODO`, `TBD`, `lorem ipsum`, `{{` and `${` anywhere in
the visible text, and any claim that Belline answers in a language it does not.

### The same promises as everywhere else

Belline takes requests and a person confirms them. The check fails any page
that says Belline books into a calendar or confirms an appointment itself —
the marketing equivalent of the rule `check:honesty` enforces on the agent.

---

## Adding a language later

Not built, and the seam is ready for it. `SEO_LOCALES` in
`scripts/seo/matrix.ts` is an array of `{ lang, prefix }`. Every URL in the
system — canonical, hreflang, sitemap, internal link, breadcrumb — is composed
through `indexPath`, `verticalHubPath`, `cityHubPath` and `comboPath`, which
take the locale and read the prefix from that array. No renderer writes a path
by hand.

German would be: add `{ lang: "de-DE", prefix: "/de-de/ki-empfang" }`, add
German fields to the trade, city and pair data, and render. The hreflang block
and the alternates follow. This mirrors what `scripts/site-locale.ts` already
does for the landing and legal pages.

---

## The full matrix — 30 URLs

Five trades × six cities. **Bold** is published today; the rest need pair copy
written before they can be.

| | Dubai | Abu Dhabi | Sharjah | London | Manchester | Dublin |
|---|---|---|---|---|---|---|
| **Restaurants** | **✓** | — | — | — | — | — |
| **Hair & beauty salons** | — | — | **✓** | — | — | — |
| **Dental clinics** | — | — | — | **✓** | — | — |
| **Aesthetic & medical clinics** | — | — | — | — | — | — |
| **Spas** | — | — | — | — | — | — |

```
https://belline.ai/ai-receptionist/restaurants/dubai                  ← published
https://belline.ai/ai-receptionist/restaurants/abu-dhabi
https://belline.ai/ai-receptionist/restaurants/sharjah
https://belline.ai/ai-receptionist/restaurants/london                 (waitlist)
https://belline.ai/ai-receptionist/restaurants/manchester             (waitlist)
https://belline.ai/ai-receptionist/restaurants/dublin                 (waitlist)
https://belline.ai/ai-receptionist/hair-salons/dubai
https://belline.ai/ai-receptionist/hair-salons/abu-dhabi
https://belline.ai/ai-receptionist/hair-salons/sharjah                ← published
https://belline.ai/ai-receptionist/hair-salons/london                 (waitlist)
https://belline.ai/ai-receptionist/hair-salons/manchester             (waitlist)
https://belline.ai/ai-receptionist/hair-salons/dublin                 (waitlist)
https://belline.ai/ai-receptionist/dental-clinics/dubai
https://belline.ai/ai-receptionist/dental-clinics/abu-dhabi
https://belline.ai/ai-receptionist/dental-clinics/sharjah
https://belline.ai/ai-receptionist/dental-clinics/london              ← published (waitlist)
https://belline.ai/ai-receptionist/dental-clinics/manchester          (waitlist)
https://belline.ai/ai-receptionist/dental-clinics/dublin              (waitlist)
https://belline.ai/ai-receptionist/aesthetic-clinics/dubai
https://belline.ai/ai-receptionist/aesthetic-clinics/abu-dhabi
https://belline.ai/ai-receptionist/aesthetic-clinics/sharjah
https://belline.ai/ai-receptionist/aesthetic-clinics/london           (waitlist)
https://belline.ai/ai-receptionist/aesthetic-clinics/manchester       (waitlist)
https://belline.ai/ai-receptionist/aesthetic-clinics/dublin           (waitlist)
https://belline.ai/ai-receptionist/spas/dubai
https://belline.ai/ai-receptionist/spas/abu-dhabi
https://belline.ai/ai-receptionist/spas/sharjah
https://belline.ai/ai-receptionist/spas/london                        (waitlist)
https://belline.ai/ai-receptionist/spas/manchester                    (waitlist)
https://belline.ai/ai-receptionist/spas/dublin                        (waitlist)
```

Plus the hubs, which are derived and never listed by hand:

```
https://belline.ai/ai-receptionist                       the index
https://belline.ai/ai-receptionist/<trade>               one per published trade
https://belline.ai/ai-receptionist/in/<city>             one per published city
```

`in/` keeps the two hub namespaces apart, so a trade and a city can never be
the same URL. `check:seo` asserts no slug is both.

---

## Screenshots

`docs/seo/screens/` holds the three published pages at 1280 and 390, taken from
a `npm run serve:site` of the real build. Retake them with a short Playwright
script after a design change; they are there so a reader of this document can
see what the pages look like without running anything.

## Running it

```
npm run site          build the site, including these pages
npm run serve:site    serve site/ at http://localhost:4321
npm run check:seo     the rules above
```

`check:seo` reads `site/`, so build first. It is part of `npm run check:all`.

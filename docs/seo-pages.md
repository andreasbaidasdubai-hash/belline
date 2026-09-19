# The search landing pages

`/{framing}/{trade}/{country}/{city}` — one page per trade-and-city combination,
plus a hub per trade, a hub per country, a hub per city, an index over the lot,
and two framing pages that are about a channel rather than a place. They are
built by `npm run site` into `site/`, served by the app's own server for
non-app hostnames (`src/lib/marketing.ts`), and checked by `npm run check:seo`.

They are part of the existing marketing site, not a second one. Same
`public/site.css`, same `public/site.js`, same header and footer
(`scripts/site-chrome.ts`), same prices out of `src/lib/billing/plans.ts`, same
demo call scenes as the trade pages. Nothing here introduces a framework, a
design system or a source of prices.

**What the page set is, and why.** It is the set the September 2026 UAE
keyword research argued for (`docs/seo/uae-keywords.md`), which is a different
set from the one this system originally shipped with:

| The research said | What changed |
|---|---|
| `ai receptionist for spa dubai` returns no topical result at all | **Spas dropped.** |
| `ai receptionist for real estate agents` and `ai agent dubai real estate` are both confirmed, with a live UAE sub-market | **Real estate added** as the fifth trade. |
| Every alphabetical expansion of `ai receptionist dubai` returns receptionist salaries, and the ads on it are recruitment ads | **City pages are anchored to trades**, in the title and on the page. Nothing here competes for the bare city phrase. |
| `whatsapp bot` and `wa chatbot` are −90% year on year; `whatsapp chatbot` holds its bids | **"Chatbot", never "bot"** — and `check:seo` fails a title, description or H1 containing the word on its own. |
| `whatsapp chatbot dubai` has the richest confirmed UAE long tail | **`/whatsapp-chatbot`** and four trade pages under it. |
| `call answering` is +900% year on year, but its geo-modified UAE form is dead in autocomplete | **`/call-answering`**, one page, no city — and `check:seo` fails the phrase appearing in a title that has a city in it. |
| `answering service <city>`, `virtual receptionist <city>` and IVR are the wrong intent or the wrong buyer | **No pages for any of them**, enforced by a check on the URLs. |
| London, Manchester and Dublin are half the matrix for markets we cannot sell to | **London kept** as the one honest waitlist page, Manchester and Dublin dropped. |

Two things the research's phase-1 list proposed are **not built**:
`/ai-receptionist/pricing` (target `ai receptionist cost`, which the research
called the cheapest win on the list) and `/ai-receptionist/vs-answering-service`.
Neither was in the brief for this pass. They are the obvious next two pages.

---

## Where everything lives

| File | What it holds | When you change it |
|---|---|---|
| `scripts/seo/verticals.ts` | What is true about a **trade** — pain points, call types, the boundary, six to eight FAQs, hub copy | You learn something about the trade |
| `scripts/seo/cities.ts` | What is true about a **city** — languages, working week, peak hours, booking habits, emergency number, districts, hub copy — and about a **country**, in `SEO_COUNTRIES` | You learn something about the city |
| `scripts/seo/pairs.ts` | What is only true where the two **meet** — the hero lead, the meta description, four local paragraphs, the questions asked only here | Somebody sits down and writes about that combination |
| `scripts/seo/channels.ts` | The WhatsApp and call-answering pages, which belong to neither a trade nor a city | You add a framing, or a trade page under one |
| `scripts/seo/matrix.ts` | The framings, which combinations are published, and every URL | You publish or unpublish a page |
| `scripts/seo/render.ts` | The seven page shapes | The pages need a new section |
| `src/lib/seo-redirects.ts` | Where every URL this system has ever published now lives | A published URL moves. Never delete a line from it |
| `scripts/check-seo.ts` | Everything below that can be checked by a machine | You add a rule |

The split is not tidiness. A trade file changes for trade reasons, a city file
for city reasons, and a pair file only when a person writes something new —
different cadences, different files.

---

## The URL shape, and why it has a country in it

```
/{framing}                            framing hub    /ai-receptionist
/{framing}/{trade}                    trade hub      /ai-receptionist/dental-clinics
/{framing}/in/{country}               country hub    /ai-receptionist/in/ae
/{framing}/in/{country}/{city}        city hub       /ai-receptionist/in/ae/dubai
/{framing}/{trade}/{country}/{city}   landing page   /ai-receptionist/dental-clinics/ae/dubai
```

`{framing}` is a closed set in `SEO_FRAMINGS` — `ai-receptionist`,
`whatsapp-chatbot`, `call-answering`. `{country}` is the ISO code already in
`src/lib/markets.ts`, lower-cased, which means `marketLive()` keeps deciding
waitlist-versus-checkout for free and a new country is a code, a city list and
pair copy rather than a migration. City slugs are not globally unique — London
Ontario, Newcastle, Springfield — and without the country segment the first
collision would be found by a 404 in production.

A **country hub** is built only where a country has more than one published
city *and* somebody has written `SEO_COUNTRIES` copy for it. The United
Kingdom has London and nothing else, so there is no `/ai-receptionist/in/gb`:
it would be the city page with a different heading, which is a doorway page
with extra steps.

`in/` keeps the hub namespaces apart, so a trade and a country can never be the
same URL. `check:seo` asserts no slug is both, and that no framing slug is a
trade slug either.

### The old URLs

Three landing pages and three city hubs were published at the old
`/ai-receptionist/{trade}/{city}` shape. They are redirected permanently from
one table, `src/lib/seo-redirects.ts`, which is read in three places:

- `src/lib/marketing.ts` — the app's own server answers 301 before any file lookup
- `scripts/build-site.ts` — writes `site/_redirects` for Netlify
- `vercel.json` — hand-kept, and `check:seo` fails if it disagrees with the table

`check:seo` also fails if a redirect's destination was not built, or if a
redirected URL is *also* built, which would be two URLs for one page.

---

## Adding a city

1. **Add the entry** to `SEO_CITIES` in `scripts/seo/cities.ts`. Every field is
   required and every field has to be a fact somebody could check: the working
   week, the languages callers actually use, the emergency number Belline is
   given there, real districts. `market` is the important one — it is a code
   from `src/lib/markets.ts`, and it decides on its own whether the page can be
   bought from or has to carry the waitlist, and what the URL's country segment is.
2. **Write the pairs.** For every trade you want a page for, add a
   `"<trade>/<city>"` entry to `SEO_PAIRS` in `scripts/seo/pairs.ts`. This is
   the work. There is no fallback and there is deliberately no template: a
   combination with no pair copy is simply not published, and one listed for
   publication with no pair copy fails the build.
3. **List the combinations** in `PUBLISHED` in `scripts/seo/matrix.ts`, or set
   `SEO_PAGES=all` to publish everything that has pair copy.
4. `npm run site && npm run check:seo`.

The hubs, the internal links, the sitemap entries, the hreflang block and the
breadcrumbs all follow from the data. Nothing else needs touching.

## Adding a trade

1. **Add the entry** to `SEO_VERTICALS` in `scripts/seo/verticals.ts`. Point
   `tradePage` at the existing page under `/salons`, `/dental`, `/clinics` or
   `/restaurants` if one fits — the landing pages take their demo call scenes
   from it, so the call you hear is the recorded one, not a second script that
   will drift. A trade with no such page (real estate is the one) simply gets
   no call panel; the renderer leaves the section out rather than playing a
   dental practice's conversation under a property heading.
2. Reuse an image already in `public/img/`. A new photograph is a separate
   decision, not a side effect of adding a page.
3. Write the pairs, list the combinations, build and check.

## Adding a framing

A framing is a phrase worth its own root, not a synonym. Add it to
`SEO_FRAMINGS` in `scripts/seo/matrix.ts`, add its slug to every locale's
`framing` map in `SEO_LOCALES`, and write a `ChannelHubCopy` — and, if the
phrase is asked trade by trade rather than city by city, a `ChannelTradeCopy`
per trade — in `scripts/seo/channels.ts`. Only `ai-receptionist` carries the
trade × city matrix; the others are a hub and, at most, a page per trade.

---

## The rules, and which of them the check enforces

### A market we are not open in is never sold to

`src/lib/markets.ts` says `AE` is `live` and `GB` is `not-yet`, and the
checkout refuses a market that is not live. So a London page that said "Get
started" would walk somebody into a checkout that turns them away, having told
them on the way that we serve their city.

Pages for those cities carry the waitlist instead, exactly as the German pages
do: no checkout link, no price in the local currency, no trial offer, no
`Offer` in the structured data, and a hero that says in the first paragraph
that we are not open there. `check:seo` fails the build on every one of those.

Nothing about this is written in the copy. `marketLive(city)` reads the market
table, and the day `GB` flips to `live` the London pages grow a buy button and
lose the waitlist without a word being edited.

### Each page is written for itself, measured two ways

`check:seo` measures, per page, the sentences that appear on **no other page in
the system** — and it measures them over the page's *body*, not the whole page.
The header, the footer, the three steps, the channel strip, the price cards and
the closing call to action are marked `data-shared="site"` where they are
rendered and are excluded from both halves of the sum. They are the same on
every page on purpose, and a landing page that dropped its pricing to score
better would be a worse page.

Two floors, because one number was not enough:

- **Absolute.** At least 3,000 characters of a landing page appears nowhere
  else — about five hundred words written for one page and no other, which is
  not something a template produces. 2,500 for a channel trade page, 1,000 for
  a hub.
- **Proportional.** At least 35% of a landing page's body sentences are its
  own, as a guard against a page growing shared bulk around a fixed amount of
  its own writing.

The ratio **came down**, from 0.4 of the whole page to 0.35 of the body, and
the docstring in `check-seo.ts` says so rather than implying the measure simply
got better. Measured, the landing pages sit between 39% and 51%: 0.4 would have
failed one and left three within a point of failing, and the only way to pass
it would have been to reword a trade-level sentence per city — the behaviour
the check exists to prevent, performed to satisfy the check. The absolute floor
is the one doing the work and the one to raise if this set grows.

The original rule was 40% of the *whole* page, which was the right test when
there were three pages and nothing was shared between them. At thirty-three it
had started measuring how much furniture a page carries. The rest of a landing
page's body is legitimately trade-level — what Belline does with an allergen
question is the same sentence in Dubai and in Sharjah, and rewriting it per
city to raise a score would be the exact behaviour the check exists to prevent,
performed to satisfy the check.

The trade's own eight questions are **rotated** so that the three cities under
one trade do not publish the same four answers word for word: each city takes a
disjoint pair, and all eight live on the trade hub above them.

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

On the WhatsApp pages there is a second promise to keep: we do not resell
WhatsApp Business API access and we do not obtain anybody a verified badge.
Half the UAE results for that phrase are agencies selling exactly those, and
every page under `/whatsapp-chatbot` says so in the same breath as the word
"chatbot".

### The framing, enforced

- No `<title>`, description or `<h1>` anywhere contains the word **bot** on its own.
- Every page with a city on it leads its title with **AI receptionist**.
- Every city hub's title names a **trade**, so nothing competes for the bare
  `ai receptionist <city>` phrase the job boards own.
- **Call answering** has its own page and its own H1, and appears in no title
  that has a city in it.
- No URL in the system is `answering-service`, `virtual-receptionist` or `ivr`
  — the *segment*, not the substring, so a future
  `/ai-receptionist/vs-answering-service` is not blocked by a rule aimed at
  `answering service dubai`.

### The rest of the site links into this one

A page set nothing links to is a page set a crawler visits once and a reader
never does. `check:seo` asserts that `site/index.html` links to
`/ai-receptionist` and to each framing hub, and that every hand-written trade
page (`/dental`, `/salons`, `/clinics`, `/restaurants`) links to its trade hub.
It also asserts the other direction — that nothing in the system is an orphan.

### No page asks the same question twice

The pair copy and the trade copy are written months apart by people thinking
about the same telephone, so they converge. `faqsFor` drops a trade question
the pair has already asked and takes the next one instead, measured on word
overlap of both the question and the answer, and `check:seo` fails a page that
still carries two.

---

## Adding a language later

Not built, and the seam is ready for it. `SEO_LOCALES` in
`scripts/seo/matrix.ts` is an array of `{ lang, prefix, framing }`, where
`framing` maps each framing slug to its segment in that language. Every URL in
the system — canonical, hreflang, sitemap, internal link, breadcrumb — is
composed through `framingPath`, `indexPath`, `verticalHubPath`,
`countryHubPath`, `cityHubPath` and `comboPath`, which take the locale. No
renderer writes a path by hand.

German would be: add
`{ lang: "de-DE", prefix: "/de-de", framing: { "ai-receptionist": "ki-empfang", … } }`,
add German fields to the trade, city and pair data, and render. This mirrors
what `scripts/site-locale.ts` already does for the landing and legal pages.

---

## Every URL

Sixteen landing pages: five trades across Dubai, Abu Dhabi and Sharjah, plus
dental clinics in London, which is a market we are not open in.

| | Dubai | Abu Dhabi | Sharjah | London |
|---|---|---|---|---|
| **Restaurants** | ✓ | ✓ | ✓ | — |
| **Hair & beauty salons** | ✓ | ✓ | ✓ | — |
| **Dental clinics** | ✓ | ✓ | ✓ | ✓ (waitlist) |
| **Aesthetic & medical clinics** | ✓ | ✓ | ✓ | — |
| **Real estate** | ✓ | ✓ | ✓ | — |

```
https://belline.ai/ai-receptionist                                    the index
https://belline.ai/ai-receptionist/restaurants                        trade hub
https://belline.ai/ai-receptionist/hair-salons                        trade hub
https://belline.ai/ai-receptionist/dental-clinics                     trade hub
https://belline.ai/ai-receptionist/aesthetic-clinics                  trade hub
https://belline.ai/ai-receptionist/real-estate                        trade hub
https://belline.ai/ai-receptionist/in/ae                              country hub
https://belline.ai/ai-receptionist/in/ae/dubai                        city hub
https://belline.ai/ai-receptionist/in/ae/abu-dhabi                    city hub
https://belline.ai/ai-receptionist/in/ae/sharjah                      city hub
https://belline.ai/ai-receptionist/in/gb/london                       city hub (waitlist)
https://belline.ai/ai-receptionist/restaurants/ae/dubai
https://belline.ai/ai-receptionist/restaurants/ae/abu-dhabi
https://belline.ai/ai-receptionist/restaurants/ae/sharjah
https://belline.ai/ai-receptionist/hair-salons/ae/dubai
https://belline.ai/ai-receptionist/hair-salons/ae/abu-dhabi
https://belline.ai/ai-receptionist/hair-salons/ae/sharjah
https://belline.ai/ai-receptionist/dental-clinics/ae/dubai
https://belline.ai/ai-receptionist/dental-clinics/ae/abu-dhabi
https://belline.ai/ai-receptionist/dental-clinics/ae/sharjah
https://belline.ai/ai-receptionist/dental-clinics/gb/london           (waitlist)
https://belline.ai/ai-receptionist/aesthetic-clinics/ae/dubai
https://belline.ai/ai-receptionist/aesthetic-clinics/ae/abu-dhabi
https://belline.ai/ai-receptionist/aesthetic-clinics/ae/sharjah
https://belline.ai/ai-receptionist/real-estate/ae/dubai
https://belline.ai/ai-receptionist/real-estate/ae/abu-dhabi
https://belline.ai/ai-receptionist/real-estate/ae/sharjah
https://belline.ai/whatsapp-chatbot                                   framing hub
https://belline.ai/whatsapp-chatbot/restaurants
https://belline.ai/whatsapp-chatbot/hair-salons
https://belline.ai/whatsapp-chatbot/dental-clinics
https://belline.ai/whatsapp-chatbot/real-estate
https://belline.ai/call-answering                                     framing hub
```

Thirty-three pages. There is deliberately no WhatsApp page for aesthetic and
medical clinics: a messaging funnel for cosmetic treatments runs into
health-authority rules on how a clinic may advertise and what it may claim, and
that is a decision for the founder and a clinic's own compliance person rather
than a page somebody generated on a Saturday.

### The four URLs that used to exist

```
/ai-receptionist/restaurants/dubai      → /ai-receptionist/restaurants/ae/dubai
/ai-receptionist/hair-salons/sharjah    → /ai-receptionist/hair-salons/ae/sharjah
/ai-receptionist/dental-clinics/london  → /ai-receptionist/dental-clinics/gb/london
/ai-receptionist/in/dubai               → /ai-receptionist/in/ae/dubai
/ai-receptionist/in/sharjah             → /ai-receptionist/in/ae/sharjah
/ai-receptionist/in/london              → /ai-receptionist/in/gb/london
```

---

## Screenshots

`docs/seo/screens/` holds six pages at 1280 and 390, taken from a
`npm run serve:site` of the real build: a salon page in Dubai, a restaurant
page in Dubai, a salon page in Sharjah, a real estate page in Sharjah (the
trade with no recorded demo call), a WhatsApp trade page, and the London
waitlist page. Retake them with a short Playwright script after a design
change; they are there so a reader of this document can see what the pages look
like without running anything.

---

## What is still open

Reviewed before publication by three readers — one on UX and conversion, one on
SEO, one on the copy — and these are the things they raised that are *not* done.
They are recorded here rather than in a report nobody will find again.

**Decisions for the founder**

- **The WhatsApp pages' titles lead with "AI receptionist", not "WhatsApp
  chatbot".** That is the house rule, and the SEO reader argued it costs the
  exact phrase (`whatsapp chatbot dubai`) that earned those pages their own
  root. Changing five titles would recover it.
- **Two pages from the research's phase-1 list are not built:**
  `/ai-receptionist/pricing` (target `ai receptionist cost` — the research
  called it the cheapest win on the list, and no title in the system carries a
  price) and `/ai-receptionist/vs-answering-service`. Neither was in the brief
  for this pass. The path rule no longer blocks the second.
- **What Starter actually enforces.** "Your own rules about what it may and may
  not decide" is a Growth feature in the catalogue, and rule-holding is the
  argument the salon pages are built on. The copy no longer claims live call
  transfer on every plan; it still claims rule-holding on every plan, and
  somebody should decide whether that is right before a customer does.
- **The demo number is a United States one** and the pages say so. Every reader
  who looked at it said the same thing: a receptionist product that is expert
  in Dubai numbers and holds none itself invites the wrong question at the
  moment of decision. A UAE number, or a callback form, is the fix.

**Known, unfixed**

- On a short phone the hero's "Get started" sits just below the fold, under
  Belle's video. The layout *shift* is fixed (`video-pending`); the ordering is
  a change to the shared hero and would move the home page too.
- Belle's floating bubble overlaps the waitlist form's middle fields at 390px.
- "Get started" points straight at the checkout on pages that also say "no card
  required". "Start 30 days free" is the more honest label, site-wide.
- `/ai-receptionist` (the index) and `/ai-receptionist/in/ae` overlap while the
  UAE is the only live market. The country hub is the stronger page; the index
  is thin. One reader would merge them, and the URL pattern is the reason not
  to yet.
- `/dental` and `/ai-receptionist/dental-clinics` compete for one intent, and
  the same is true of `/clinics`, `/salons` and `/restaurants`. It predates
  this system; it now has a second page on the other side of it.

## Running it

```
npm run site          build the site, including these pages
npm run serve:site    serve site/ at http://localhost:4321
npm run check:seo     the rules above
```

`check:seo` reads `site/`, so build first. It is part of `npm run check:all`.

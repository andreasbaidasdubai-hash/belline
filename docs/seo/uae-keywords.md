# UAE keywords — the short list, and a URL pattern that scales

Research 19 September 2026. English only. UAE only. The goal is not a map of
the market; it is **a small set of phrases and one repeatable URL shape** that
we can clone to other countries and cities without a rewrite.

## What the evidence is

**Google Suggest**, `gl=ae`, 531 seeds at ~1 request/second: each seed alone,
each with `dubai` / `uae` / `abu dhabi` / `sharjah`, alphabetical expansion on
eight priority seeds, question prefixes, commercial tails. The endpoint returns
**nothing** for a string people do not type — controls: `dentist dubai` and
`salon dubai` return ten suggestions, `zzqx dubai service` returns an empty
array. So "no suggestions" is real negative evidence (below Google's threshold
in this locale), not proof of zero searches. The endpoint also echoes the seed
back only when the seed is itself a known query, which separates "people type
this" from "we invented this".

**SERPs via Bing with `cc=ae`, read from a UAE IP.** Google served the
"unusual traffic" interstitial to the automated browser and bypassing it was
not an option. Bing's ranking is not Google's, but *who has bothered to build a
UAE page for a phrase* and *whether the ads are job ads* hold across engines.

**Google Keyword Planner**, UAE + English, 3,466 ideas, from the founder's
account — with one critical limitation: **the Ads account is cancelled, so
every single keyword returns the same "100 – 1k" range.** That column is
withheld data, not a measurement. Nothing in this document is ranked by it, and
nobody should quote it as a volume. What *is* real in that export is
**competition, top-of-page bids and year-on-year change**, and those differ
sharply per term.

## The four things the data actually says

1. **"Receptionist" drags job-seekers behind it in this market.** Every
   alphabetical expansion of `ai receptionist dubai` returns
   `receptionist salary in uae`, `receptionist salary in dubai`,
   `receptionist jobs in dubai for freshers`. The `receptionist dubai` SERP is
   a jobs board end to end, and the paid ads on `ai receptionist dubai` itself
   are recruitment ads (Jobrapido, JobLeads). The suspicion was right.
2. **"Virtual receptionist" and "answering service" mean something else here.**
   `answering service dubai`, `call answering service dubai`,
   `telephone answering dubai` and all their geo variants return **no
   suggestions at all**. `virtual receptionist dubai` does — as
   `virtual office dubai with ejari`, `virtual office dubai cost`,
   `virtual assistant dubai salary`. The SERP is Clutch, GoodFirms, Sortlist and
   company-formation firms selling a phone add-on with a trade licence.
3. **But "call answering" as a phrase is the fastest-growing thing in the
   export: +900% YoY, alongside "answering calls", also +900%, at CHF 4.86–8.26
   top-of-page bids.** That is growth in the generic phrase, not the UAE
   geo-modified one, and it is the single strongest piece of trend evidence we
   have.
4. **The WhatsApp assumption needs splitting in two.** The UAE long tail
   branches richly under WhatsApp — `whatsapp business api dubai`,
   `… provider dubai`, `… pricing dubai`, `… company dubai`,
   `whatsapp api provider uae`, `whatsapp api pricing in uae`,
   `whatsapp automation dubai`, `whatsapp chatbot dubai`, `whatsapp chatbot uae`
   are all confirmed, where `ai receptionist dubai` branches into salaries. Yet
   Keyword Planner shows **`whatsapp bot` and `wa chatbot` both −90% YoY** while
   `whatsapp chatbot` holds CHF 1.95–9.58 bids. Those are consistent, not
   contradictory: the *"bot"* spelling is the hobbyist end (its autocomplete
   tail is `free`, `github`, `apk`, `group link`) and it is collapsing; the
   *"chatbot"* and *"API"* spellings are the commercial end and are not.
   **Target "chatbot", never "bot".**

## The shortlist — nine phrases, ranked

Each row is one page. "Evidence" is what the phrase rests on; confidence is
mine.

| # | Target phrase | Evidence | Confidence |
|---|---|---|---|
| 1 | `ai receptionist for dental clinics` (+ `… uae`) | Confirmed autocomplete; the densest UAE SERP of any trade — sanad.im, heyanaya.ai, mawidi.com, huskyvoice, leverageai.ae plus two "8 tools compared" posts. Both framings and a live market converge here | **High** |
| 2 | `whatsapp chatbot dubai` | Confirmed; UAE vendor-heavy SERP (wapi.ae, botsense, crankup.ae, commbots, fictoralabs); CHF 1.95–9.58 bids. Avoid the word "bot" | **High** |
| 3 | `ai receptionist cost` / `ai receptionist price` | Confirmed globally (`ai receptionist cost per month` too). Competitor after competitor writes a Dubai cost article and publishes no price; we have AED 249/499/999 | **High** — cheapest win on the list |
| 4 | `call answering service` (+ `… for small business`) | +900% YoY, CHF 4.86–8.26 bids. Note the geo-modified UAE form is dead in autocomplete, so target the generic phrase with UAE proof on the page, not `call answering service dubai` in the title | **Medium-high** |
| 5 | `whatsapp booking bot for clinics uae` (title it "WhatsApp appointment booking for UAE clinics") | Entire SERP of UAE vendors selling exactly our product — letsbot, responder.ae, lirevon, commbots, healthcluster, ichelon | **High** |
| 6 | `ai receptionist for salons` (`… hair salons`, `… beauty salons`) | Confirmed tail; `whatsapp chatbot for salons dubai` has only two real UAE competitors. Keyword Planner also shows `hair salon software` at CHF 15.80 — advertisers pay real money around salons | **Medium-high** |
| 7 | `ai receptionist for restaurants` (`best ai receptionist for restaurants`) | Confirmed tail; one Dubai-specific competitor (trycover.ai). Keep it about the phone during service, not reservations software | **Medium** |
| 8 | `ai receptionist vs answering service` | Real, crowded SERP. Captures the answering-service intent without competing with Clutch and GoodFirms for the directory phrase | **Medium-high** |
| 9 | `ai receptionist for real estate agents` / `ai agent dubai real estate` | Both confirmed; a live UAE sub-market (brokerdesk-ai, huskyvoice, trustample). **The largest UAE vertical missing from our matrix** | **Medium** — needs new `verticals.ts` copy |

**Deliberately not on the list**, with reasons: `virtual receptionist dubai`
(virtual-office and job intent); `answering service dubai` (five directories);
`chatbot dubai` (government bots — RTA, Mahboub, Dubai Police — plus job
queries); `website chatbot *` (empty at every UAE variant);
`appointment booking software uae` and `restaurant reservation system dubai`
(empty; the word "booking" belongs to travel consumers and POS vendors);
`missed calls *` (a Mac Miller song and consumers worried about a missed call —
a good headline, a bad target); and **IVR / interactive voice response**, which
carries the highest bids in the whole export (up to CHF 18.20) but whose
autocomplete is `ivr meaning`, `ivr full form` and a shampoo brand — those bids
are telco and enterprise contact-centre vendors buying an auction we would lose
expensively and to the wrong buyer. `spas` is dropped from phase 1 outright:
`ai receptionist for spa dubai` returns no topical result at all.

## Which phrase should lead the page titles

**Lead with "AI receptionist", qualify with the channel, and never lead with
"bot".**

- *AI receptionist* is the only phrase that names the whole product in one
  word, and it is what a referred buyer types. Its weakness is the job-seeker
  halo — which is a problem for the **city** pages (`ai receptionist dubai`),
  not for the **trade** pages (`ai receptionist for dental clinics`), because
  nobody looks for a job as a dental clinic's software.
- *WhatsApp chatbot* has the richest UAE long tail and real bids, but it
  attracts buyers shopping for API access and a green tick, which we do not
  sell. It belongs in the title as a **channel qualifier** and in its own trade
  pages, not as the product's name. The −90% on `whatsapp bot`/`wa chatbot` is
  a warning about the word, not about WhatsApp.
- *Call answering* is the growth story (+900%) and honest bid money, and it is
  the phrase least polluted by jobs. It belongs in the H1 and body ("answers and
  books the call"), and as its own page, but the geo-modified form is dead in
  the UAE, so it should not carry the city pages.

Concretely, the title pattern I would ship:

> **AI Receptionist for Dental Clinics in Dubai — Answers Calls & WhatsApp, Books the Appointment | AED 249/mo**

That one string carries the product noun, the trade phrase (#1), the channel
qualifier (#2), the call-answering verb (#4) and the price (#3), and it is a
template, not a one-off.

## A URL pattern that scales

Today: `/ai-receptionist/<trade>/<city>`, plus `/ai-receptionist/<trade>` and
`/ai-receptionist/in/<city>`. Two things will break when this leaves the UAE.

1. **City slugs are not globally unique.** London UK and London Ontario,
   Newcastle, Springfield. Adding a country later is a URL migration.
2. **The framing is baked into the root.** Every page in the system is titled
   for the phrase with the job-seeker halo, and there is nowhere to put a
   WhatsApp-led page except a second site.

Recommended shape — same renderer, one extra segment and one extra dimension:

```
/{framing}                            hub            /ai-receptionist
/{framing}/{trade}                    trade hub      /ai-receptionist/dental-clinics
/{framing}/in/{country}               country hub    /ai-receptionist/in/ae
/{framing}/in/{country}/{city}        city hub       /ai-receptionist/in/ae/dubai
/{framing}/{trade}/{country}/{city}   landing page   /ai-receptionist/dental-clinics/ae/dubai
```

`{framing}` is a small closed set — `ai-receptionist`, `whatsapp-chatbot`,
`call-answering` — declared the way `SEO_LOCALES` already is, so no renderer
writes a path by hand and the hreflang, sitemap and breadcrumb logic follows
unchanged. `{country}` is the ISO code already in `src/lib/markets.ts`, which
means `marketLive()` keeps deciding waitlist-versus-checkout for free. The cost
is three published URLs to redirect, now, while there are three.

**Phase 1, UAE, in build order** — nine pages, matching the shortlist:

```
1  /ai-receptionist/dental-clinics/ae/dubai        ai receptionist for dental clinics uae
2  /whatsapp-chatbot                                whatsapp chatbot dubai
3  /ai-receptionist/pricing                         ai receptionist cost
4  /call-answering                                  call answering service for small business
5  /whatsapp-chatbot/clinics                        whatsapp appointment booking for uae clinics
6  /ai-receptionist/hair-salons/ae/dubai            ai receptionist for salons
7  /ai-receptionist/vs-answering-service            ai receptionist vs answering service
8  /ai-receptionist/restaurants/ae/dubai            ai receptionist for restaurants   (published today, retitle + move)
9  /ai-receptionist/real-estate/ae/dubai            ai receptionist for real estate agents
```

Amendments to the existing 30-URL matrix: **drop spas** from phase 1; **fold
aesthetic clinics into clinics** rather than giving them their own pair copy;
**add real estate** as a vertical; **park London, Manchester and Dublin** until
`GB` flips to `live` (the machinery is right, but they are half the matrix for
markets we cannot sell to); keep **Abu Dhabi and Sharjah as city hubs only** —
neither `ai receptionist abu dhabi` nor `ai receptionist sharjah` is a
confirmed query, while `whatsapp business api provider abu dhabi` is.

The pattern above is what makes the next country cheap: a new market is a
country code, a city list and pair copy — never a URL change.

## Arabic — parked, with a reason to revisit

Not harvested further per the narrowed scope. From the 30 Arabic seeds already
run before the change: `اتمتة واتساب دبي`, `واتساب بوت دبي`, `شات بوت الامارات`,
`شركة شات بوت دبي`, `رد على المكالمات دبي`, `مساعد ذكي للرد على الهاتف` and
`سكرتير ذكي` all returned **nothing**. The Arabic B2B suggestions that do exist
point at Saudi and Egypt (`واتساب api السعودية`, `واتساب api في مصر`), the
Arabic bot tail is dominated by `مجاني` (free), and Arabic booking queries are
patients booking Burjeel and Dubai Health, not clinics buying software.

**Worth a second pass later, but not now, and not for SEO.** Arabic is a
product capability — every competitor's title tag already claims it, and one
(ZIWO) sells Gulf-dialect handling as its headline — so launching it wins
demos, not rankings. Revisit when a live Ads account can price Arabic keywords
properly, or when a customer tells us their buyers searched in Arabic.

## What we still cannot know without an active Ads account

- **Any real volume.** With the account cancelled, all 3,466 ideas show the same
  "100 – 1k". We cannot rank phrases by size, cannot compare
  `whatsapp chatbot dubai` to `ai receptionist dubai`, and must not quote that
  range as data. Reactivating the account with even minimal spend unlocks exact
  numbers, and is the single highest-value next step.
- **The job-seeker split inside `ai receptionist dubai`.** We know the
  contamination is there; we cannot size the buyer slice. Cheapest resolution:
  one week of exact-match `[ai receptionist dubai]` at a small daily cap, then
  read the search-terms report. Search Console will answer it for free once the
  pages have impressions, just slower.
- **Whether the confirmed trade tail carries UAE volume.**
  `ai receptionist for dental clinics` is confirmed as a query somewhere in the
  world; country-filtered numbers would tell us if it is typed here.
- **Difficulty.** No domain authority or backlink data — whether Clutch and
  GoodFirms can be displaced is unknown.
- **Google's own SERP.** Everything above is Bing: Google's ad counts, People
  Also Ask and local pack for these phrases are unread.

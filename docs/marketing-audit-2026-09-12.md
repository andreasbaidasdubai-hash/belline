# Belline marketing site — audit, 12 September 2026

Report only. Nothing committed, nothing deployed. Verified against the live
site (belline.ai, 375 px and 1440 px), the live checkout, the Railway
environment, and the code — not against STATUS.md alone, which is a day stale
in places (billing/checkout now exist; the design is Fraunces on paper, not
Manrope on navy).

## What is actually true today (the basis for every verdict below)

| Claim area | Reality |
|---|---|
| Card / payment | Stripe is **not configured** in production (no `STRIPE_*` variables). Checkout creates the account and starts a trial with no payment step at all. "No card" is true — by accident. When Stripe is switched on, `CheckoutForm` goes straight to Stripe after signup, and "no card" becomes false unless a card-free trial is built into that flow. Decide which it is before Stripe goes live. |
| Trial | 14 days and **30 live-call minutes** (`TRIAL_MINUTES = 30`). The page says "a limited number". |
| Phone | Forwarding on no-answer/busy to the Twilio number: live. The demo line is **+1 571** — a US number. There is no UAE number. |
| Website bell + chat | Live (this week). |
| WhatsApp | Built, not connected (Meta verification). The page says so — correctly. |
| Arabic | Not built. English only. Nowhere on the site claims Arabic; the plan data marks it `not-yet` and checkout hides it. Keep it that way. |
| Live transfer | **Does not exist.** The agent "transfers" by ending the call and flagging a callback. No `<Dial>` anywhere. The site never says "put you through" — good — but "goes to your team with the context" reads as a handover. |
| Diary | Belline's **own** diary. Google Calendar one-way sync is written, not switched on (no credentials). Fresha, SevenRooms, OpenTable, Treatwell: not available (partner-gated). The site never mentions any of this. |
| Waitlist | Matches a freed slot to a waiting guest and puts them at the top of *your* list with a 30-minute hold. **Belline does not ring or message them.** |
| Recording | No call audio recorded — true. |
| Data export | **No export exists.** The FAQ says "exportable". |
| Onboarding | Self-serve `/setup` (paste website → four things). "We set your venue up with you", "we do one of them with you", "about half an hour" and "named contact" are staffing promises, not product. |
| Reliability | No failover, no observability (STATUS 33/34). "Never a caller sent to voicemail" depends on the container being up. |
| Internal documents | **`belline.ai/market.html`, `/plan.html` and `/golive.html` are publicly served** — the market study, the 90-day plan and the go-live runbook, because they live in `public/`. |

## The table

Ranked by cost of leaving it. **K** keep · **C** change · **R** remove.

| # | Element | Verdict | Why | Replacement |
|---|---|---|---|---|
| 1 | `/market.html`, `/plan.html`, `/golive.html` | **R** | Your competitive study, 90-day plan and runbook are one URL guess away from a competitor or a prospect. `build-site.ts` copies every `.html` in `public/`. | Move the three files out of `public/` (e.g. `docs/site/`) or exclude them in the pages filter. No copy change. |
| 2 | The unanswered question: *"What about my booking system?"* | **C** (add) | A salon on Fresha, a restaurant on SevenRooms — the buyer you named — reads "it books into the real one", assumes their system, and finds out at setup. Nothing on the site says the diary is Belline's own. This stops the sale twice: once when they discover it, once when they tell the next owner. | New FAQ + a line under "Books customers". Copy §4. |
| 3 | Facts strip: "Never / a caller sent to voicemail" and "Your diary / it books into the real one" | **C** | "Never" is a reliability guarantee you have no failover for. "The real one" implies their existing system. | Copy §2. |
| 4 | "Hands over when it should — goes to your team with the context" | **C** | Reads as a live handover. What exists is a message with the number and the transcript, flagged. That is still a strong claim — say that one. | Copy §3. |
| 5 | Business plan: "Waitlist — it offers a slot the moment one frees" | **C** | Belline does not contact the guest. Your team does, from the top of the list. | "Waitlist — when a slot frees, the guest who wanted it is at the top of your list with their number, held for you for thirty minutes." (also `plans.ts` line 113) |
| 6 | Vertical closer: "Setting a venue up takes about half an hour." | **R** | No customer has been onboarded. Unsupported. | Delete the sentence; the rest of that card stands. |
| 7 | "Three steps, and we do one of them with you." / "we set your venue up with you" / "Priority support" / "Named contact for onboarding" | **C** (flag) | These are promises about people, not product. True only if you will personally do them for every trial in the next months. Keep only what you will staff. | Heading → "Three steps. Ring it before your customers do." Terms line → "Standard onboarding is free." Keep "Named contact" on Enterprise only if it is you. |
| 8 | FAQ "What do you do with our guests' data?" — "exportable" | **C** | No export exists. | "…The data belongs to your venue, and we will hand it over in full if you leave." (a commitment you can keep by hand) |
| 9 | Clinic scene: "ring 999, or go straight to your nearest A&E" | **C** | UK. Dubai ambulance is **998**; nobody here says A&E. This is also what the *product* says on the line — the authority rule's wording must change with it (`assessAuthority` rule text), or the page and the call disagree. | "Please call 998 for an ambulance, or go to the nearest emergency department now. I'm not the right place for this." |
| 10 | FAQ: "never charged a penny more" | **C** | Pence in a dirham business. | "never charged a dirham more" |
| 11 | Positioning: the word *Dubai* appears nowhere; the phone number is American | **C** | The buyer is a Dubai owner. AED is the only local signal; a +1 number reads as a foreign product and costs them an international call to try it. | Eyebrow, title, description (copy §1). Get a UAE Twilio number when you can (needs trade licence docs) — flagged as your decision, not copy. |
| 12 | Hero lead | **C** | "Answers your phone and your website 24/7, handles customer questions and books appointments — so you never miss another customer" is a feature list ending in an absolute. It is about the product. The buyer's sentence is *the call I couldn't take*. | Copy §1. |
| 13 | Hero H1 "Someone always answers." | **K** | Short, true, and the one thing Retell, Vapi and Synthflow (tools for building agents) cannot say to an owner. Against a human answering service the difference is the next line, not this one. | — |
| 14 | The differentiator is below the fold | **C** | The strongest thing you have — "knows a colour needs a patch test, a six-top needs two hours, a first visit is a consultation" — lives on the trade pages. On the home page the first proof is generic. | One line in the facts strip (copy §2) and the "Books customers" card (§3). |
| 15 | Mobile: three floating controls at the fold | **C** (CSS) | At 375 px the sticky buy-bar, the chat bubble and the bell all sit over the call panel and cover the **Listen** button. The HTML comment says the bell "steps aside under 760 px"; it does not. | Under 760 px: hide `.bell-fab` (the buy-bar already carries the bell); move `.chat-fab` above the buy-bar or into it. |
| 16 | Mobile: call tabs wrap ("RESTAURANTS" drops to its own line) | **C** (CSS) | Looks broken at the fold. | Let `.call-tabs` scroll horizontally, or drop tracking/padding at ≤420 px. |
| 17 | Mobile: facts strip 2+1 | **C** (CSS) | "Your diary" sits alone under a two-column grid. | Single column at ≤620 px. |
| 18 | Nav: "Sign in" (home) vs "Staff sign-in" (trade pages) | **C** | Two names for one door. You chose "Sign in" in the header; keep it everywhere and "Staff sign-in" only in the footer. | `navFor()` in build-site.ts. |
| 19 | Nav: "Sign in" pill the same weight as "Get Belline" at 1440 | **C** | Two equal pills, one primary. | Keep it visible, as you asked, but as a text link (`.nav-quiet` without the border). |
| 20 | Trade cards numbered 01–04 | **C** | The order carries no information; numbers on the steps do. | Drop `.trade-n`. |
| 21 | Steps 01–03 | **K** | A real sequence. | — |
| 22 | Step 01 "Paste your website — Belline reads it… You correct anything that's wrong" | **K** | `/setup` fetches the site and shows what it understood. True. | — |
| 23 | Channels section incl. the WhatsApp note | **K** | The honest line is the most persuasive paragraph on the page. | — |
| 24 | Pricing head "Less than one missed booking." | **K** | Defensible in all four trades at AED 179. | — |
| 25 | "14 days free — a limited number of live-call minutes" | **C** | You know the number. Say it; vagueness reads as a catch. | "Thirty minutes of live calls, no card, nothing charged." |
| 26 | "No card" (hero, pricing, closer) | **K** (flag) | True today only because Stripe is off. When it goes on, the checkout must run a card-free trial or this line comes down the same day. | — |
| 27 | Terms: "neither do calls cut short by a fault on our side" | **K** | *Correction:* `billableMinutes()` returns 0 for any call whose status is not `completed`, which is what a server fault leaves behind — the clause is true, and `check:billing` pins the page's wording to the engine's. My first read was wrong. | — |
| 28 | "Every change versioned, with one-click revert" | **K** | True as of today (History panel on *How it works*). | — |
| 29 | Closer: US number as the way to "ring it yourself" | **C** | Speak to Belle is free and one tap; the number costs a Dubai owner an international call. | Copy §6: button first, number second, marked international. |
| 30 | Trade card copy | **C** (minor) | "and it can tell which one it is being asked for" is vague. | "and knows an emergency is not a check-up." |
| 31 | Comparison line "A receptionist works office hours. Belline answers 24/7." | **C** (add) | Answers the human-answering-service objection halfway. | "An answering service takes a message. Belline takes the booking — and answers at three in the morning." |
| 32 | `<title>` / description | **C** | No trade, no city — the two things a search has. | Copy §1. |
| 33 | `robots.txt`, `sitemap.xml`, 404 page | **C** (add) | All three 404 (Vercel's plain-text 404). Cheap. | Add both files to `public/`; a branded `404.html`. |
| 34 | Structured data | **C** (add) | You have a real FAQ and real prices; `FAQPage` and `Organization` JSON-LD are free rich results. | Add to landing.html head. |
| 35 | Shared link | **K** | OG image resolves (308 → 200), title and description set, `summary_large_image`. Fine. The image is generic — worth a version carrying "Someone always answers" and the four trades, but not urgent. | — |
| 36 | Design system | **K** | Editorial, not templated: warm paper, hairlines instead of cards, brass held back to eyebrows and times, Fraunces with the optical axis doing real work at small sizes. Body at 18 px earns it. Nothing reads as a template. | — |
| 37 | FAQ coverage of the four objections | **C** (add) | "Will it sound like a robot", "what if it books wrong", "can it put someone through", "does it speak Arabic" are not answered anywhere on the page. All four arise on the first read. | Copy §5. |

## Rewritten copy

### §1 Head, hero

```html
<title>Belline — AI receptionist for clinics, salons and restaurants in Dubai</title>
<meta name="description" content="Belline answers the calls your team can't reach — mid-service, mid-treatment, after close — and books straight into your diary. For clinics, dental practices, salons and restaurants in Dubai. Fourteen days free, no card.">
<meta property="og:title" content="Belline — Someone always answers">
<meta property="og:description" content="An AI receptionist for Dubai's clinics, dental practices, salons and restaurants. Answers 24/7, books into your diary, hands anything it shouldn't decide to you.">
```

Eyebrow:
> AI reception for Dubai's clinics, salons and restaurants

H1 — unchanged:
> Someone always answers.

Lead:
> The calls your team can't reach — mid-treatment, mid-service, nine at night — Belline picks up. It answers from your own hours, prices and rules, books straight into your diary, and takes a message on anything it shouldn't decide.

Hero note:
> Fourteen days free, no card. Keep your number — nothing changes for your callers. English, for now.

### §2 Facts strip

| big | small |
|---|---|
| 24/7 | including after you close |
| No voicemail | every call is answered, or a message taken with a number to ring back |
| Your rules | it knows a colour needs a patch test and a six-top needs two hours |

### §3 "What it does"

**Answers 24/7** — Even when you're closed, or already on the line with somebody else. *(unchanged)*

**Books customers** — Checks what is genuinely free, then takes the appointment. Belline keeps the diary: you and your team work in it, and it never offers a time that isn't there.

**Knows your business** — Your hours, services, prices and policies — answered in your own words. *(unchanged)*

**Takes a message when it should** — A complaint, anything clinical, anything it shouldn't decide: it takes the number and what was said, flags it, and you ring back. It does not guess.

### §4 The booking-system answer (new — FAQ entry, and referenced from "Books customers")

> **Does it work with Fresha, SevenRooms or OpenTable?**
> Not yet, and we won't pretend otherwise. Belline keeps its own diary — you and your team work in it, and it is the diary the receptionist books into. A one-way feed into Google Calendar is built and waiting on Google's approval. The booking-platform integrations need a partner agreement with each of them; we have not got those yet. If your whole business lives in one of them, the honest advice today is to try Belline on the trial and see whether the diary is enough.

### §5 FAQ — rewrites and additions

**Do we have to change our phone number?** — unchanged.

**What happens if we run out of minutes?** — unchanged except "a penny" → "a dirham".

**Will it answer calls our staff would have taken?** — unchanged.

**Are we tied in?** — unchanged.

**What do you do with our guests' data?**
> Transcripts and bookings are stored so you can audit what was said; call audio is not recorded. The data belongs to your venue, and we hand all of it over if you leave. We are happy to sign whatever your legal counsel requires.

**Will it sound like a robot?** *(new)*
> Ring it and decide — the number and the bell on this page reach the same receptionist your callers would. It speaks like a person, it says "sure" and "let me see", and it will not read you a script. On the demo line it tells you it is an AI; on your line, what it says about itself is your choice.

**What if it books something wrong?** *(new)*
> It can only offer a time that is actually free — availability comes from the booking engine, not from the conversation, so it cannot invent a slot. Every booking has the full transcript beside it. If it is unsure of a name, a date or a number it asks again rather than guessing, and anything outside its rules becomes a message for you instead of a booking.

**Can it put a caller through to us?** *(new)*
> Not live, not yet. When a call needs a person it takes the number and the reason, marks it urgent if it is, and ends the call so you can ring back with the whole story in front of you. Live transfer is on the way; we will say so here when it works.

**Does it speak Arabic?** *(new)*
> Not yet. It answers in English today. Arabic is planned, but nobody has made a real Arabic call on it, so we are not selling you one.

### §6 Getting started, pricing terms, closer

Steps heading:
> Three steps. Ring it before your customers do.

Step 03:
> **Ring it yourself** — Try to catch it out before your customers do. When you're happy, switch the forwarding on and it's live.

Pricing terms, third card:
> **14 days free** — Thirty minutes of live calls, no card, nothing charged. Standard onboarding is free.

Comparison line:
> An answering service takes a message. Belline takes the booking — and answers at three in the morning.

Closer:
> **Your next customer could ring tonight.**
> Make sure someone answers.
> [Get Belline] Fourteen days free · No card · Cancel anytime
>
> **Or be the caller, first.**
> The same receptionist your callers would reach. Nothing you book is real — it says so itself.
> [Speak to Belle] — free, in your browser
> Or ring +1 571 778 5920 (an international call from the UAE — your usual charges apply).
> · Ask what time it closes · Try to book something · Then try to catch it out

Trade-page closer, second card:
> **Nothing to install** — No new handset, no app for your staff, no change to what is printed on your door.

Clinic scene, second call (and the matching authority rule in the product):
> "That needs proper medical attention now, not an appointment."
> "Please call 998 for an ambulance, or go to the nearest emergency department. I'm not the right place for this."

Dental trade card:
> Check-ups, hygienist and emergencies — and it knows an emergency is not a check-up.

## Not copy, but blocking

1. Move `market.html`, `plan.html`, `golive.html` out of `public/`.
2. Decide the card question before Stripe is configured: card-free trial in the checkout flow, or take "no card" off the page.
3. Decide which staffing promises you will keep for every trial: "we set your venue up with you", "priority support", "named contact".
4. A UAE number for the demo line (Twilio needs trade-licence documents) — the single most local thing the page could show.
5. `robots.txt`, `sitemap.xml`, `404.html`, FAQ JSON-LD.
6. CSS: floating controls under 760 px, call tabs at ≤420 px, facts strip at ≤620 px, trade-card numbers, "Sign in" as a text link, `navFor()` label.

# Belline — unit economics, pricing, markets, sales agent and onboarding

14 September 2026. Written against the `concierge` codebase as it stands today (`plans.ts`, `usage.ts`, `clients.ts`, `projection.ts`, `seed-belline.ts`, `onboarding/`, `golive`, `whatsapp-provision.ts`, `embed.ts`, `sales/`), the STATUS and marketing-audit documents, and vendor list prices checked this week. Every number that feeds a decision is reconciled to a figure you already use in the code, and where I disagree with the code I say so.

The short version: your marginal cost of a phone minute is about **AED 0.23** on a US number and about **AED 0.35** on a UAE line, not the AED 0.40 the code assumes — so the code is conservative in the right direction. Chat and WhatsApp conversations cost **AED 0.06–0.18 each**, which is close enough to zero that they should be priced as wedges, not as products. The current three-plan ladder (AED 179 / 365 / 899) is priced like a premium product with stingy allowances (60 minutes is a third of what Rosie gives for the same money); an aggressive posture keeps the price points and triples the allowances, adds a free chat tier as a distribution engine, and sells the four channels as modules with an "everything" bundle that anchors the page.

---

## 1. What a unit costs you today

### 1.1 The stack, as built

Voice runs Twilio Media Streams → Deepgram nova-3 streaming → Claude (Sonnet 5 default on new venues, Haiku 4.5 on Belle) with a 1-hour prompt cache → ElevenLabs Flash v2.5. Web chat and WhatsApp run the same agent loop text-only; WhatsApp goes direct to Meta's Cloud API (no Twilio markup) and the venue supplies a SIM, so there is no per-number fee from Meta. The web voice button runs the same voice pipeline minus telephony.

### 1.2 Vendor prices used (September 2026 list prices)

| Component | Rate | Note |
|---|---|---|
| Twilio inbound, US local number | $0.0085/min | UK $0.010, AU $0.010, CA $0.0085 |
| Twilio Media Streams | $0.0044/min | on every phone minute |
| Twilio number rental | $1.15/mo US, $3.50 UK, $3.00 AU | UAE: not sold by Twilio; licensed carrier/SIP reseller, budget ~$15/mo and ~$0.03–0.06/min inbound (unverified) |
| Deepgram nova-3 streaming | $0.0077/min | Growth tier $0.0065 |
| ElevenLabs Flash v2.5 | 0.5 credits/char; ~400 chars per call-minute | Scale plan → $0.033/min; Business → $0.024; Creator → $0.044 |
| Claude Sonnet 5 | $2 / $10 per M tokens, cache read $0.20 | ≈ $0.009 per voice minute with the cache warm |
| Claude Haiku 4.5 | $1 / $5, cache read $0.10 | ≈ $0.005 per voice minute; $0.015 per chat conversation |
| Claude Opus 5 | $5 / $25 | ≈ $0.023 per voice minute — 2.5× Sonnet, the README's 0.02–0.03 |
| Meta WhatsApp | service-window replies free; utility template UAE $0.0285, UK $0.0171, US $0.004 | a booking confirmation sent outside the 24-hour window is a utility template |
| Whisper (voice notes) | $0.006/min | |

The `.env.example` planning figure `ELEVENLABS_COST_PER_1K_CHARS=0.18` is a Creator-plan overage rate and overstates TTS by 2–4×; at any real volume you will be on Scale or Business.

### 1.3 Cost per unit, per channel

Call shape assumed: 3 minutes, 6 agent turns, ~5k cached tokens per turn. Chat shape: 8 turns plus one honesty pass.

| Channel | Unit | Lean (US number, Sonnet voice, Haiku text) | Conservative (UAE line, Sonnet everywhere, ElevenLabs Pro) |
|---|---|---|---|
| Phone receptionist | per connected minute | **$0.063 / AED 0.23** | **$0.101 / AED 0.37** |
| Website voice button | per minute | $0.050 / AED 0.18 | $0.060 / AED 0.22 |
| Website chat receptionist | per conversation | $0.015 / AED 0.06 | $0.031 / AED 0.11 |
| WhatsApp receptionist | per conversation | $0.027 / AED 0.10 | $0.049 / AED 0.18 |

Reconciliation: `clients.ts` and `projection.ts` carry `VENDOR_COST_PER_MINUTE_FILS = 40` (AED 0.40). That sits just above my conservative UAE figure and well above the lean one, so the margin the internal dashboard reports is a floor, not an estimate. I would keep 40 fils as the planning constant until you have three months of real Railway plus vendor invoices, then replace it with a measured number per channel (the prompt below asks Claude Code to meter it).

What moves the number most, in order: the UAE telephony leg (≈ +$0.03–0.05/min, the largest single line), the ElevenLabs plan tier (Creator → Business halves TTS), and the model (Opus adds $0.014/min over Sonnet with no evidence yet that a receptionist needs it). Prompt caching is already the reason the model line is flat; without it the Sonnet line would be 4–6× higher on a long call.

### 1.4 Fixed costs

Railway (app + worker + Postgres) ~$60–120/mo, Vercel free/Pro $20, ElevenLabs plan $99–330, Deepgram and Anthropic pay-as-you-go, one demo number, domains, an email provider for outreach ~$50–100. Call it **$300–600/mo** before any salary — which at AED 300 ARPA is 4–8 paying venues to break even on fixed costs.

---

## 2. Pricing structure — modular, aggressive, still profitable

### 2.1 What the market charges, so you know what "aggressive" means

| Competitor | Entry price | What you get |
|---|---|---|
| Dialzara | $29 / $99 / $199 | 60 / 220 / 500 min; $0.35–0.48 overage |
| Rosie | $49 / $149 / $299 | 250 / 1,000 / 2,000 min |
| Goodcall | $79 / $129 / $249 per agent | unlimited minutes, capped at 100/250/500 unique callers |
| My AI Front Desk | $99 | 200 voice min + 100 chat + 400 SMS, $0.25/min over |
| Smith.ai (AI) | $150 → $500 | 75 → 300 calls (~$1.70–2.00 a call) |
| Tidio Lyro (chat only) | $32.50 per 50 conversations | ~$0.58 a conversation |
| Intercom Fin (chat only) | $0.99 per resolution | |
| Wati / Respond.io (WhatsApp) | $29–79 entry | plus Meta fees |
| Human receptionist, Dubai | AED 3,800–6,900/mo fully loaded | |
| Ruby (human, US) | $250 / 50 min | $3.45–5.00 a minute |

Belline today: AED 179 (~$49) for 60 minutes. On minutes-per-dollar you are the most expensive AI receptionist in the table above, and Rosie gives four times the allowance for the same money. The plan *prices* are fine — they read as software prices and sit under a fifth of a human — the *allowances* are what is uncompetitive.

### 2.2 The recommended ladder

Principles: four channels sold as modules so a restaurant that only wants WhatsApp can start at AED 99 and a clinic that wants everything sees one bundle; keep your "no overage, ever" promise — it is a genuine differentiator against Dialzara's $0.48 overage and it is already enforced in `usage.ts`; price the near-zero-cost channels (chat, WhatsApp) as wedges and let voice carry the margin; a free chat tier as the distribution engine; and no "unlimited" anywhere, because the only accounts that would use it are on the UAE line where your cost is highest.

**Modules, priced in AED (UAE), with the USD anchor for other markets**

| Module | Price | Included | Cost at full use (lean / conservative) | GM at full / at typical 60% use |
|---|---|---|---|---|
| **Chat Receptionist — Free** | AED 0 | 100 conversations/mo, "Answered by Belline" badge, no inbox takeover | $1.5 / $3 | wedge, ~$1.50/mo per free account |
| **Chat Receptionist** | AED 49 ($13) | 150 conversations, badge off, inbox, handover | $2.3 / $4.6 | 83% / 90% |
| **WhatsApp Receptionist** | AED 99 ($27) | 300 conversations, self-serve number, booking confirmations via template | $10 / $15 | 63% / 78% |
| **Website Voice Button** | AED 99 ($27) | 150 minutes, the bell on their site | $7.5 / $9 | 72% / 83% |
| **Phone Receptionist — Starter** | AED 149 ($41) | 200 minutes, one number | $14 / $35 | 66% / 79% lean; 13% / 33% on a UAE line |
| **Phone Receptionist — Business** | AED 349 ($95) | 600 minutes, house rules, versioning, waitlist | $39 / $76 | 59% / 75% lean; 20% / 46% UAE |
| **Phone Receptionist — Pro** | AED 799 ($218) | 1,500 minutes, named contact | $96 / $167 | 56% / 73% lean; 23% / 51% UAE |

**Bundles ("Everything" — the card you want them to pick)**

| Bundle | Price | Phone | Web voice | Chat | WhatsApp | GM typical (lean / UAE) |
|---|---|---|---|---|---|---|
| Everything Starter | AED 249 ($68) | 200 min | 100 min | 150 conv | 300 conv | 72% / 38% |
| Everything Business | AED 499 ($136) | 600 min | 200 min | 400 conv | 800 conv | 63% / 34% |
| Everything Pro | AED 999 ($272) | 1,500 min | 300 min | 1,000 conv | 1,500 conv | 61% / 34% |

Everything Starter at AED 249 is the anchor: the four modules bought separately cost AED 396, so the bundle is "save 37%" and it is still 72% margin at typical usage. At *full* allowance on a UAE line the Business and Pro bundles run to roughly break-even (−2% and −6%), which is acceptable only because full use of every channel at once is rare and because the "upgrade, never overage" rule means a venue that heavy is on the next tier within a month; the check script in the prompt fails the build if typical-usage margin falls under 30%. Annual stays at ten months for twelve.

Two things the numbers force. First, UAE margins on the phone product are thin at the Starter tier until the local telephony cost is known — the unverified $0.03–0.06/min on a licensed SIP trunk is the single number most worth pinning down this month, because it decides whether Starter is 66% or 13% at full use. Second, the free chat tier costs you roughly $1.50 per account per month; 500 free accounts is $750/mo, which is affordable only because every one of them carries your badge on a live business website and a one-click "add the phone" upsell in their dashboard. Cap it (100 conversations, Haiku, no voice) and it is the cheapest distribution you will ever buy.

### 2.3 The trial

Move from "14 days, 30 minutes, phone only" to **14 days, 60 phone minutes, all four channels switched on**, no card. The cost of a trial that uses all of it is about $8; a prospect who has had the chat widget on their site and a WhatsApp number answering for two weeks has switched on something their customers already noticed, and that is the conversion.

### 2.4 Per-market price points

Keep one USD anchor and round to local software prices; do not convert at runtime (the comment in `plans.ts` is right). Suggested: UAE AED 149/349/799; UK £35/£79/£179; Australia A$59/A$139/A$319; Canada C$55/C$129/C$299; US $39/$95/$219; Singapore S$55/S$129/S$299; Ireland €39/€89/€199. Tax (UAE VAT 5%, UK VAT 20%, AU GST 10%) should be handled by Stripe Tax rather than baked into the price.

---

## 3. Which markets after the UAE pilot

### 3.1 How to think about it

The product is English-only, and the sales motion is now agents doing personalised email with a recorded demo plus a live "ring it yourself" line. That makes a market attractive when: businesses in your four verticals are dense and pay a receptionist salary you can undercut; Twilio sells local numbers self-serve so a venue can be live the same day; WhatsApp Business is available and used; the regulatory friction on *inbound* AI answering is low; cold email is lawful with an opt-out; and nobody owns the vertical yet. Cost of telephony barely matters between these markets — a UK minute is $0.010, a US minute $0.0085.

### 3.2 The ranking

Scored 1–5 on each criterion; the last column is the recommendation.

| Market | Density × WTP | Telephony (self-serve local number) | WhatsApp use | Inbound-AI regulation | Cold-email posture | Competition | Verdict |
|---|---|---|---|---|---|---|---|
| **UK** | 5 — 5.7M businesses, dental and salons dense, receptionist £24–28k | 5 — Twilio local numbers with address proof | 4 — pervasive in SMB | 4 — no AI-disclosure statute; UK GDPR for transcripts | 4 — B2B email lawful under PECR with opt-out | 3 — many generic tools, no vertical owner | **First** |
| **Australia + NZ** | 4 — 2.7M / 0.6M businesses, very high wages, dental/physio/vet strong | 5 — Twilio local numbers; AU needs address | 3 — WhatsApp moderate, SMS strong | 5 — inbound outside DNCR; no AI law | 4 — Spam Act allows B2B with opt-out and inferred consent | 2 — thin | **Second** |
| **Canada** | 4 — 1.1M employer businesses, high wages | 5 — cheapest numbers | 3 | 4 — CRTC covers outbound only | 3 — CASL is strict: implied consent for B2B only with a published address, 2-year window; keep sequences short | 2 | **Third (English provinces)** |
| **Ireland** | 3 — small (~300k SMEs) but same product, EUR, adjacent to UK | 4 | 4 | 3 — EU AI Act Art. 50 disclosure applies from 2 Aug 2026: disclose in the greeting and you are compliant | 3 — ePrivacy B2B tolerated with opt-out | 2 | **Bundle with UK** |
| **Singapore** | 4 — small but wealthy, clinics and aesthetic dense | 3 — Twilio numbers need business documents | 5 — WhatsApp is the phone | 4 | 3 — PDPA DNC applies to outbound calls/SMS, not B2B email | 2 | **Fourth; WhatsApp-led** |
| **USA** | 5 — biggest and richest | 5 | 2 — SMS not WhatsApp | 3 — California AB 2905 and a growing patchwork require AI disclosure at call start; TCPA irrelevant for inbound | 4 — CAN-SPAM | 5 — Slang.ai (restaurants), Goodcall, Rosie, Dialzara, Smith.ai, My AI Front Desk | **Fifth, dental/med-aesthetic only, after proof points** |
| South Africa | 3 — English, large SMME count, low ARPU | 4 | 5 | 4 | 3 — POPIA s.69 opt-out | 2 | Later; price-sensitive |
| Saudi Arabia | 5 — bigger than UAE, Vision 2030 venue formation | 2 — licensed carriers only | 5 | 3 | 3 — PDPL consent-forward | 3 — early Arabic-first players | **When Arabic ships** — biggest prize in the region |
| India | 2 — 79M MSMEs, ARPU a tenth of yours | 3 | 5 | 3 | 3 | 4 — very cheap local players | Skip |

Your own market study reached UAE clinics → UAE restaurants → Switzerland → DACH. The Swiss step is where I would push back: UWG Art. 3(1)(o) consent-gates the very channel your agents run on (the code already reflects this — Switzerland gets a two-step LinkedIn-first sequence), the product is English-only, and Parloa and Fonio are already in the German-speaking room. The UK gives you the same "we know the customer" comfort without those three handicaps, and one language.

### 3.3 The sequence I would run

Pilot proves the UAE. In parallel, from month two, run three low-budget outreach agents — UK dental, UK salons, Australia dental — at $250/mo each, exactly as the `sales.agent` config was designed for. Let reply and trial rates choose the second country rather than deciding it now. Canada and Ireland come free once the UK machinery exists (same language, same sequences, different frames and compliance profiles). Singapore is a WhatsApp-first entry. The US is a deliberate later move into dental and medical-aesthetic only, where Slang.ai does not play. Saudi waits on Arabic, but it is the largest single prize after the UK and the one your competitors cannot follow you into.

### 3.4 What actually gates a new market

Not the agent, not the prompt. Four things: a local number a venue can get inside the signup flow (Twilio's Regulatory Compliance API with an address bundle per country, plus the UAE exception handled by a reseller); local currency pricing with Stripe Tax; STT locale (`language=en-GB`, `en-AU`, `en-IN` on Deepgram — one parameter); and a warmed sending domain per market for outreach (`EMAIL_SENDING_DOMAINS` already anticipates several). Automate those four and a country is a config row, which is what §5 says about scaling.

---

## 4. Belle as a sales agent, not a booker of sales calls

Yes — and the codebase is closer than the current prompt admits. Belle already runs the real engine, already has honest FAQs, already knows the plan prices (`seed-belline.ts`), and the sales engine already has a reply classifier, a briefing agent, a personalised demo generator and a suppression list. What Belle lacks is *tools that close*: she can only book a Zoom slot.

The upgrade is to give her, on every channel she answers (phone, web bell, web chat, WhatsApp, and inbound email replies), five things she can actually do:

1. **Qualify and record.** Vertical, city, how many lines, how they lose calls today, current booking system, WhatsApp usage. Written to the sales CRM as a lead with a score, not to a notes field.
2. **Quote list prices for the caller's market and channel mix.** "Phone plus WhatsApp for a two-chair clinic in Manchester is £79 plus £27 a month, 600 minutes, no overage." List prices only; anything that smells of a discount or a contract goes to a person — that rule already exists in AGENTS.md §4 and should stay.
3. **Build their demo while they are talking.** Take the website URL, call `createProspectDemo()`, and send the link by SMS, WhatsApp or email in the same conversation. Today this happens only inside cold email.
4. **Start the trial for them.** Collect business name, email, vertical, website; call `signUp()` + `draftFromWebsite()`; email a magic sign-in link. The prospect ends the conversation with an account that has already read their website. This is the single largest conversion lever in the plan, because it collapses "book a call → wait → be onboarded" into one conversation.
5. **Send a checkout link with the plan pre-selected** when they are ready to pay — Stripe Checkout, no card taken by voice, ever.

The demo *call* stays as a fallback for people who ask for a human, and for prospects the qualifier scores as enterprise (multi-branch groups). The "book a call" CTA leaves the homepage and the emails; the demo link and "start today" replace it. Your instinct about the demo button over the demo call is right and the data will show it: every step that requires your calendar is a step that costs a day.

Guardrails to keep: Belle never claims a capability that is `not-yet` in `plans.ts` (the same gate that already protects the pricing page should feed her prompt); disclosure that she is AI in the greeting on every market where that is required (US states, EU/Ireland) and by default everywhere — it costs nothing and it is your best proof point; the 600-second cap; and a human notified the moment a trial is created from a conversation, so the first 24 hours get a personal email.

---

## 5. Onboarding: guide or assistant?

Both, in that order of importance reversed: the assistant is the product, the guide is the fallback and the SEO page.

What the flow needs, judged against what exists:

**Already built and good:** signup with a trial in one step; `/setup` reads the website and asks only about gaps; readiness check; forwarding codes on `/golive`; WhatsApp self-serve number provisioning (needs `WHATSAPP_BUSINESS_ACCOUNT_ID`); the widget snippet; Google Calendar one-way sync (needs credentials).

**Where a customer stalls today, in order of damage:**

1. **"Ask for my number" is a mailto.** The venue cannot go live without you reading an email. Provision the number from Twilio inside the flow (buy a local number, attach the regulatory bundle, write it to `location.phone`), and for the UAE assign from a pool you hold with the local carrier. Until that exists, nothing else in this list matters.
2. **Nobody verifies forwarding worked.** Add a "test my line" button: Belline rings the venue's real number from its own number, lets it ring out, and reports whether the call landed on the diary. A per-carrier table (du, e&, EE, O2, Vodafone, Telstra, Optus, Bell, Rogers) replaces the generic GSM codes.
3. **The widget is a snippet in a box.** Detect the site platform from the URL fetched at setup (Squarespace, Wix, WordPress, Shopify, GoDaddy) and show that platform's three steps; offer "email this to whoever does your website".
4. **Setup asks the gaps by text box.** Make Belle the onboarding assistant: the same agent, with tools that write to the Business Brain (`ensureBaseline` / the venue config gate), asks the gap questions conversationally — by chat in the dashboard or by voice — and can take a menu or price list as a photo or PDF and extract it with the reader already used for websites. The owner can also just *ring their new number and be interviewed*, which is the most on-brand onboarding a voice product could have.
5. **No first week.** A readiness score on the dashboard home, three emails (day 1 "ring it", day 3 "here is what it handled", day 10 "pick a plan"), and the first-7-days report STATUS lists as item 38.

A written guide still earns its place: one page per country and carrier for forwarding, one page per website platform for the widget, and the WhatsApp page you already have. Generate them from the same tables the assistant uses so they cannot drift.

---

## 6. Can this scale into every English-speaking market at once? My take

Technically the product does not care which country it is in. The things that actually break at breadth are operational: number provisioning per country, tax and currency, sending-domain reputation per market, support hours across ten time zones, and the ability to notice when a market's STT accuracy or booking behaviour is quietly worse (Indian and Scottish accents are a known nova-3 weak spot; test before promising). Every one of those is automatable and the prompt below asks for all of them.

So the answer is: yes, but "at once" should mean *agents running in parallel with tiny budgets*, not launching everywhere with the same intensity. Run UK, Australia and Canada agents from month two for about $750/mo total; whichever market produces trials at under $100 CAC gets the budget and the localised pricing page; the others idle at $50/mo. The acquisition arithmetic supports it — $250 of agent budget buys roughly 800 personalised emails, and at a 4% reply, 50% demo, 60% trial and 35% conversion rate that is three to four customers, a CAC near $75 and payback inside two months against AED 300 ARPA. Those funnel rates are the honest priors for cold B2B, not measurements, and the first 500 emails in each market will replace them.

The one place I would slow down is the US. It is the biggest market and the most crowded, and it is where a self-serve competitor with a $79 unlimited plan and a Yelp integration already exists. Go there with dental and aesthetic clinics once you have UK case studies, not before.

---

## 7. Decisions only you can make before Claude Code starts

Whether the trial stays card-free once Stripe is switched on (the audit flagged this; the recommendation above assumes yes). Whether the free chat tier ships with the badge (recommended). The UAE telephony partner and its per-minute rate. The Meta business verification and `WHATSAPP_BUSINESS_ACCOUNT_ID`. Google OAuth credentials. And which of the "we do it with you" promises you will personally keep — the assistant is designed so that none of them is needed, but the copy should match.

The execution prompt is in `belline-claude-code-prompt.md`.

---

## 8. How this compares with the earlier "Belline Positioning Review"

The two analyses agree on more than they disagree: the per-location subscription is the right model; WhatsApp and chat cost almost nothing and should be the front door in the Gulf; "unlimited" must go; 60 minutes on Starter is an extended trial, not a plan; dental and clinics lead, salons second, restaurants kept but not led; integrations are the moat; the live demo belongs above the fold; and the cost floor is about $0.06–0.10 a minute.

They disagree on price direction because they assume different sales motions. The review benchmarks against vertical outcome sellers (Slang at $379, SmartReception at AED 1,000–1,500 plus setup) and proposes AED 499/999/1,999 with an onboarding fee and AED 1.50/min overage — a founder-led sale with a setup call, which is the only way a venue pays AED 999 for a product that today has no Fresha integration and no Arabic. This document benchmarks against the self-serve long tail (Rosie, Dialzara, Goodcall) because you asked for an agent-driven, demo-link, no-sales-call funnel and maximum share; that motion cannot carry a setup fee, and "no overage ever" is a genuine differentiator that is already enforced in the code. The resolution is not to pick one: run the self-serve ladder as the volume engine and add the review's Professional/Premium as a managed track that becomes visible only when the integrations and Arabic it promises are `live` — the codebase's own rule against selling the roadmap decides the timing. On markets, the review's Switzerland-next rests on the Baidas network, which is a founder channel, not an agent channel, and on Swiss German voice, which is not built; keep it as a warm-intro track with a CHF list while the agents run the UK and Australia.

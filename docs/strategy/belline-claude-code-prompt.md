# Claude Code prompt — Belline commercial build-out (pricing, channels, sales agent, onboarding, markets)

Paste everything below this line into Claude Code, run from the `concierge` repo root.

---

You are working in the Belline repo (`concierge/`). Read `README.md`, `docs/STATUS.md`, `docs/marketing-audit-2026-09-12.md` and `docs/strategy/belline-commercial-strategy-2026-09-14.md` before writing anything. The strategy document is the source of the numbers and decisions below; where this prompt and that document disagree, ask me.

House rules that already exist in this codebase and must survive every change you make:

- Money is integer fils/pence/cents, never floats (`src/lib/billing/plans.ts`). Every feature on a plan carries `status: "live" | "not-yet"` and `not-yet` never renders on a public page; `scripts/check-billing.ts` pins the website's wording to the billing engine. Extend that pattern, do not bypass it.
- **There is no per-minute overage anywhere in the product.** An allowance that runs out is an upgrade prompt, not a line on an invoice (`src/lib/billing/usage.ts`). Keep it.
- Nothing the model produces reaches a live venue or a customer unreviewed unless the code validates it first (forced tool choice + schema, post-checks in code). No agent may quote a discount, contract term or SLA; list prices only. No agent may claim a capability that is not `live`.
- Every check script under `scripts/check-*.ts` must stay green; add a check script for every new module in the same style. `npm run typecheck`, `npm run check`, `npm run check:engine`, `npm run check:config`, `npm run audit` all pass before you report a phase done.
- Write files without a UTF-8 BOM (see STATUS.md). If you add an asset type, update the regex in `scripts/build-site.ts`.
- Commit at the end of each phase with a message that names the phase. Do not deploy.

Work through the phases in order. At the end of each phase, run the checks, then write a short entry to `docs/STATUS.md` in its existing format (Live / Built / Not started) saying what changed and what still needs a credential or a decision from me. Stop and ask before any step marked **[decision]**.

---

## Phase 1 — Cost metering per channel (so the pricing has a floor we measured)

Goal: replace the single planning constant `VENDOR_COST_PER_MINUTE_FILS = 40` with measured cost per unit, per channel, per venue, from what the vendors actually bill.

1. Create `src/lib/billing/cost.ts`. Define a `CostEvent` (`{ venueId, callId|conversationId, channel: "phone"|"embed_voice"|"webchat"|"whatsapp", vendor: "twilio"|"deepgram"|"elevenlabs"|"anthropic"|"meta"|"openai", units, unit: "min"|"chars"|"tokens_in"|"tokens_out"|"tokens_cache_read"|"tokens_cache_write"|"messages"|"templates", usd: number }`) and a `RATE_CARD` constant with the list prices in §1.2 of the strategy doc, dated, with a comment per line naming the source page. Make the rate card overridable from env (`RATE_TWILIO_INBOUND_US`, etc.) so a UAE SIP-trunk rate can be set the day we have one.
2. Emit cost events from the places that already know the numbers: `src/lib/voice/session.ts` (call seconds by transport, so telephony + media streams + Deepgram minutes), `src/lib/providers/tts.ts` (characters sent per request, by model), `src/lib/agent/runtime.ts` (token usage from every Anthropic response incl. cache read/write — the `usage` object is already there), `src/lib/reception/channel/meta.ts` (messages sent, and whether a template was used outside the 24-hour window), Whisper in the voice-note path.
3. Persist events in the store (JSON store today; keep the narrow `store.ts` interface). Add `costOfCall(callId)`, `costOfConversation(id)`, `costPerVenuePeriod(venueId, period)` and a per-channel `unitCost` rollup (USD per phone minute, per embed-voice minute, per chat conversation, per WhatsApp conversation), each with the sample size.
4. Replace `VENDOR_COST_PER_MINUTE_FILS` in `src/lib/sales/clients.ts` and `src/lib/sales/projection.ts` with the measured per-channel rollups, falling back to the 40-fils constant while a channel has fewer than 50 samples. Show the measured figures, the sample size and the fallback state on `/sales/clients`.
5. `scripts/check-cost.ts`: a synthetic 3-minute phone call and an 8-turn chat produce cost events whose sum is within 5% of the hand-computed figures in the strategy doc (phone lean ≈ $0.063/min; chat Haiku ≈ $0.015/conversation).

## Phase 2 — Products, plans and entitlements per channel

Goal: four sellable modules and three bundles, priced per market, replacing the single three-plan ladder. All the numbers come from §2.2 and §2.4 of the strategy doc.

1. Rework `src/lib/billing/plans.ts` around **modules** and **bundles**:
   - Modules: `chat_free` (100 conversations, badge on, Haiku only, no inbox takeover), `chat` (150 conv), `whatsapp` (300 conv), `web_voice` (150 min), `phone_starter` (200 min), `phone_business` (600 min), `phone_pro` (1,500 min). Each module declares its channel, its allowance and its unit (`minutes` or `conversations`).
   - Bundles: `everything_starter`, `everything_business`, `everything_pro` with the allowances in the table. A bundle is a set of module allowances at one price; do not model it as a discount.
   - Prices as a `Record<Market, number>` in minor units, for markets `AE, GB, AU, CA, US, SG, IE`, using the per-market price points in §2.4. Keep the "priced in local money, never converted at runtime" rule. `annual` remains ten months for twelve. No plan is unlimited.
   - Features keep `status: "live" | "not-yet"`; anything that depends on a credential we do not have (`WHATSAPP_BUSINESS_ACCOUNT_ID`, Google OAuth, Stripe Connect) stays `not-yet` and must not render.
2. Generalise `src/lib/billing/usage.ts` from "minutes" to allowances per channel: `billableUnits(call|conversation)` per channel with the same exclusions (test console, demo lines, calls we broke), a per-channel `Usage`, per-channel projection and upgrade recommendation (`planFor` becomes "the cheapest module or bundle that would carry this venue's usage across all channels"). The invoice is still the plan fee and nothing else. Update `MINUTE_DEFINITION` into per-unit definitions the website quotes verbatim (what counts as a conversation: a thread with at least one Belline reply, one thread per customer per 24 hours).
3. Entitlements: extend `src/lib/billing/entitlement.ts` and `src/lib/voice/entitlement.ts` so each channel is gated by whether the venue's plan includes it, not only by trial state. A venue on `chat` alone must not answer a phone call or a web bell; `checkEmbedGate` in `src/lib/embed.ts` and the WhatsApp webhook must consult it. Past-allowance never stops service; missing-module does.
4. Trial: `TRIAL_DAYS = 14`, phone minutes 60, and **all four channels on** during the trial (`src/lib/onboarding/index.ts`). **[decision]** before you touch checkout: confirm with me that the trial stays card-free after Stripe goes live; then make `CheckoutForm` collect the card only at plan selection, never at signup.
5. Free tier: `chat_free` is selectable without a card, forever; the widget renders "Answered by Belline" with a link to `belline.ai` when the venue is on `chat_free` (`src/lib/embed-look.ts` / `widgetConfig`), and the dashboard shows a one-click "add the phone" upsell. Cap it hard: 100 conversations, Haiku, `maxMessagesPerChat` 20.
6. Stripe: one Price per module × market × cycle plus one per bundle; a subscription is a set of items; `src/lib/billing/stripe.ts` maps webhook events back to modules. Enable Stripe Tax on Checkout sessions. Localise currency from the venue's market.
7. Checkout and billing pages: `/checkout` shows the bundle first, then modules as toggles with a live total, in the venue's currency; `/billing` shows per-channel usage bars.
8. Website: regenerate pricing in `scripts/site-content.ts` / `build-site.ts` from `plans.ts` only, per market (a `?market=` build flag or one page per market under `/uk`, `/au`, …; pick the simplest that keeps one source of truth). Extend `scripts/check-billing.ts` to pin every module, bundle, allowance and per-unit definition on every market's page to the engine.
9. Belle's knowledge: `src/lib/seed-belline.ts` FAQs on price and trial must read from `plans.ts` at boot rather than carrying hand-typed sentences, and must state prices for the caller's market (Phase 4 gives her the market).
10. `scripts/check-plans.ts`: margins. For every module and bundle, at full allowance and at 60% usage, compute gross margin with the Phase 1 rate card under the lean and conservative bases in the strategy doc and fail the build if any bundle's typical-usage margin is under 30% or any module's under 45%. Print the table.

## Phase 3 — Belle sells (every inbound channel, including email)

Goal: Belle is a sales agent that qualifies, quotes list prices, builds a demo, starts the trial and sends a checkout link — on phone, web bell, web chat, WhatsApp, and in replies to inbound email. The 20-minute call becomes a fallback.

1. New tools in `src/lib/agent/tools.ts`, available only on the Belline venue (`location.internal`), with the same validation-and-recovery style as the booking tools:
   - `record_lead({ business, vertical, city, market, lines, currentBooking, whatsappUsed, pain, contact })` → writes a lead into the sales engine (`src/lib/sales/db/repo/lead.ts`; create the company via the discovery dedup path so it cannot duplicate an outreach lead) with source `inbound:<channel>` and applies the `demo_used`-style score bump.
   - `quote({ market, modules }) ` → returns list prices from `plans.ts` for that market and the allowances; never a discount. If the caller asks for a discount, contract or SLA the tool returns a refusal text that hands to a human and the lead is flagged `WANTS_PRICING`.
   - `build_demo({ websiteUrl, sendTo: { sms?|whatsapp?|email? } })` → `createProspectDemo()` from `src/lib/prospect.ts`, then sends the link on the channel the caller is on (SMS via `providers/sms.ts`, WhatsApp via the Meta adapter, email via `providers/email.ts`). Rate-limit per caller; refuse non-public URLs (the SSRF guard already exists).
   - `start_trial({ businessName, email, vertical, websiteUrl, market, timezone })` → `signUp()` + `draftFromWebsite()` from `src/lib/onboarding`, emails a magic sign-in link (add a signed one-time login token to `src/lib/auth.ts`, 24h, single use), and notifies a human (email to `hello@`) with the transcript. Belle must read the email address back letter by letter before calling it — reuse the spelling policy already in the seed.
   - `send_checkout({ email, market, modulesOrBundle })` → a Stripe Checkout link with the selection pre-filled, sent by email/WhatsApp/SMS. Never takes card details by voice or chat.
   - `book_human_call()` stays as the existing diary booking; Belle offers it only when asked, when the qualifier scores enterprise (multi-branch, >5 lines), or after two closes have been declined.
2. Rewrite the Belle persona and policies in `src/lib/seed-belline.ts`: lead with `start_trial` ("I can set that up now, takes a minute — what's the website?"), then `build_demo` for the undecided, then the human call. Keep the honesty policies. Add: disclose being AI in the greeting by default; never claim a `not-yet` feature (generate the "what does not work yet" list from `plans.ts` at boot, exactly as `notYetLive()` does for the pricing page); state prices only via `quote`.
3. Channel parity: the same tools must be available to Belle on web chat (`src/lib/webchat*.ts`), WhatsApp (`src/lib/reception/respond.ts`) and the web bell — the sales tools follow the venue, not the transport.
4. Inbound email: extend the reply classifier route (`src/lib/sales/outreach` + `classify_reply`) so that on `HAS_QUESTION` in MODE 3 Belle drafts an answer from `SERVICES.proof` + `plans.ts` and includes the demo link and the trial link; `WANTS_PRICING` still goes to a human. Inbound leads from the website form (`src/lib/leads/email.ts`) get the same auto-reply within five minutes, with the personalised demo already built from the URL they gave.
5. Outreach CTA: change `outreach_strategy.cta` default to `demo_link` and rewrite the frames in `src/lib/sales/outreach/templates.ts` so the primary CTA is "hear your demo" + "start today (14 days, no card)", and the call is the secondary line. Keep the guards.
6. Marketing site: replace "book a call" with "Hear your demo" (URL field → personalised demo) and "Start today"; keep "Speak to Belle" as the live proof. Adopt the copy corrections in `docs/marketing-audit-2026-09-12.md` that are still open.
7. `scripts/check-belle-sales.ts`: scripted conversations (text console, no keys) covering: qualify → quote for GB → start trial → magic link sent; discount request → refusal + human flag; non-business caller → no selling; a `not-yet` capability question → honest refusal; email spelled back before `start_trial`. Extend `check-honesty.ts` accordingly.

## Phase 4 — Self-serve onboarding with Belle as the assistant

Goal: a venue goes from signup to a real answered call with no email to us. Replace every "ask for my number"/mailto step.

1. **Numbers.** `src/lib/telephony/numbers.ts`: buy a local Twilio number for the venue's market at signup (or at first "go live"), attach the regulatory bundle/address (Twilio Regulatory Compliance API; collect the address in setup), set the voice webhook, write `location.phone`. Markets: US, CA, GB, AU, IE, SG (document per-country requirements in the file). UAE: assign from a pool table (`data/number-pool.json`) I fill by hand from the local carrier, with a clear "no UAE number available — we will email you" fallback that creates a task in `/sales/enquiries` rather than a mailto. Release the number when a venue cancels and the period ends. Cost events for number rental into Phase 1.
2. **Forwarding.** Replace the generic GSM table on `src/app/(app)/golive/page.tsx` with a per-country, per-carrier table (`src/lib/telephony/forwarding.ts`: du, e&, EE, O2, Vodafone UK, Three, Telstra, Optus, Bell, Rogers, Telus, Verizon, AT&T, T-Mobile, Singtel, Eir, Vodafone IE; landline/PBX note per country). Add **"Test my line"**: Belline dials the venue's own number from its Twilio number, lets it ring out, and reports whether the call arrived on the diary (a call with `origin: "linecheck"` that is never billed and never counted as a customer call).
3. **Widget install.** At `/setup`, detect the site platform from the fetched HTML (Squarespace, Wix, WordPress, Shopify, GoDaddy, Webflow, custom) and show that platform's exact steps on `/website`; add "email these steps to my web person" using `providers/email.ts`. Verify install: fetch the venue's site and confirm the snippet is present; show a green tick.
4. **Belle as onboarder.** A conversational setup mode for the venue's own agent (`location.agent` on a trial venue), with tools that write through the config gate in `src/lib/booking/config.ts`: `set_hours`, `add_service`, `add_staff`, `set_policy`, `add_faq`, `set_address`, `set_transfer_number`. Two entry points: the dashboard chat (reuse the webchat component) and **ringing the new number in the first 24 hours**, where Belline recognises the owner's mobile (collected at signup) and offers to be interviewed. Every write is a versioned Business Brain change with "set up by Belline from your answers on <date>" as the author, revertible.
5. **Documents in.** Accept a photo or PDF of a menu or price list on `/setup` and in the onboarding chat; extract services/prices with the same forced-schema reader as `extractBusiness`; always show for confirmation before saving.
6. **WhatsApp and Google Calendar** stay behind their credentials; the Integrations page keeps saying "not available" until the env is set — do not soften it.
7. **First week.** Readiness score on the dashboard home; scheduled emails on day 1 ("ring it"), day 3 ("what it handled"), day 10 ("pick a plan") from `src/lib/reminders.ts`-style scheduling; the first-7-days report (STATUS item 38) as one page and one email.
8. **Guides.** Generate `public/guides/forwarding/<country>-<carrier>.html` and `public/guides/widget/<platform>.html` from the same tables the assistant uses (build step in `build-site.ts`), plus an index page. They must never disagree with the assistant.
9. `scripts/check-onboarding.ts`: signup → number assigned (mock Twilio) → forwarding table for GB/EE → line check recorded → widget detection on a fixture Squarespace page → Belle sets hours and two services via tools through the gate, with a rejected invalid service (stage that does not add up) surfacing as a spoken correction rather than a crash.

## Phase 5 — Markets as configuration

Goal: adding a country is a row, not a deploy. Markets: AE (live), GB, IE, AU, NZ, CA, US, SG.

1. `src/lib/markets.ts`: per market — currency, tax handling, Twilio number availability and bundle requirements, default STT locale (`en-GB`, `en-AU`, `en-IE`, `en-NZ`, `en-CA`, `en-US`, `en-SG`; keep `en` for AE), emergency-services wording for the authority rule (`999`/`112`/`000`/`111`/`911`/`995`; UAE `998` per the audit), AI-disclosure requirement (`always` — and note the legal basis where one exists: EU AI Act Art. 50 for IE from 2 Aug 2026; California AB 2905 and state laws for US), WhatsApp availability, default timezone, and the outreach compliance profile. Move the `COUNTRIES` seed in `src/lib/sales/config/defaults.ts` to read from it so sales and product share one definition.
2. Thread the market through: signup picks it (from the website's TLD/address, confirmed by the owner), `plans.ts` prices by it, `providers/stt.ts` sets the locale from it, the authority rule in `src/lib/agent/authority.ts` speaks the right emergency number, the greeting includes the disclosure where required, the website builds a page per market.
3. Outreach agents: seed country managers and vertical agents for GB dental, GB salons, AU dental, CA dental, IE dental, SG clinics with the compliance profiles in the strategy doc (CASL: implied-consent B2B only, short sequences; Australia: Spam Act, opt-out; UK: PECR B2B, opt-out; Ireland: ePrivacy, opt-out; Singapore: PDPA DNC does not cover B2B email) and `budget.monthly_usd: 250` for GB/AU, `50` for the rest. Frames per market in `templates.ts` (en-GB spelling and tone, en-AU, en-CA). One sending domain per market in `EMAIL_SENDING_DOMAINS` with warm-up state tracked.
4. Demo lines: one demo venue per market is unnecessary; instead the Belline venue answers in the caller's market (from the dialled number or the site's `?market=`), so prices and the emergency number are right.
5. Sales dashboard: `/sales` gains a per-market column (leads, replies, demos, trials, customers, CAC from cost events and agent budgets) so the market ranking in the strategy doc can be replaced by measured funnel numbers after the first 500 emails per market.
6. `scripts/check-markets.ts`: every market has every field; GB venue gets `en-GB` STT and `999`; US greeting carries the disclosure; prices render in the right currency on each page; a CA agent cannot be configured with more than the compliance profile's sequence steps.

## Phase 6 — Observability for the promises above

1. Per-channel latency and failure panels on the health page (calls dropped by us, TTS errors, Meta send failures, cost per unit trend), and a daily email to me with: trials started (by source and market), conversions, MRR, measured unit costs, and any bundle whose measured margin fell below the Phase 2 thresholds.
2. Alerts when a venue's channel is entitled but broken (number unreachable, widget snippet gone from the site, WhatsApp token expired).

---

When all six phases are done, update `README.md` ("Roughly what a call costs" becomes "What each channel costs, measured", pointing at Phase 1) and `docs/STATUS.md`, and give me a one-page list of the credentials and decisions still outstanding, in the order they unblock revenue.

---

## Addendum (14 Sep 2026) — reconciliation with the "Belline Positioning Review"

The earlier review (`claude.ai` artifact "Belline Positioning Review") proposed AED 499 / 999 / 1,999 tiers, an onboarding fee, AED 1.50/min overage, WhatsApp unlimited, Fresha first, Switzerland next. The strategy doc proposes a cheaper modular self-serve ladder with no overage and a free chat tier. Both are right for a different sales motion, so build **two tracks** and keep them in one catalogue:

1. **Self-serve track** (Phase 2 as written): modules + Everything bundles, no overage, no setup fee, free chat tier, sold by the agents and by Belle. This is what the outreach funnel lands on.
2. **Managed track**: `professional` (AED 999, 500 min + WhatsApp/chat unlimited fair-use 2,000 conv + booking-system integration + Arabic) and `premium` (AED 1,999, 1,500 min, up to 3 locations, outbound no-show chasing, named contact). Add them to `plans.ts` now, with every feature that depends on Fresha/Treatwell/SevenRooms/OpenTable, Arabic or outbound marked `not-yet`, so **they do not render publicly until those are live**. Belle may mention them only as "for groups, we quote" and route to a human. An optional paid **white-glove setup** service item (AED 750) belongs to this track only. Do not add a per-minute overage anywhere; `usage.ts`'s promise stands on both tracks.
3. Grandfather existing pilot venues at their current plan for 90 days from the day the new catalogue ships (a `grandfatheredUntil` date on the subscription, respected by entitlements and the billing page).
4. Website proof (from the review's §8): "Speak to Belle" and a WhatsApp QR side by side in the hero, a 20-second audio sample, a dashboard screenshot, and a testimonials block that renders only when at least three real pilot venues have consented (a `testimonials.json` gated exactly like `status: "live"`).
5. Switzerland is a founder-network track, not an agent track: add `CH` to `markets.ts` with a CHF list (149/349/699 mapped onto the self-serve ladder), Swiss German STT marked `not-yet`, and the consent-gated two-step sequence already in `defaults.ts`; do not seed a CH outreach agent with budget.
6. The review's "Fresha in week 2–3" is not an engineering task — the partner applications are mine to file. Leave `BookingBackend` as the seam and add a "request integration" button on `/integrations` that records which system each venue uses (this is also the data that decides which partner to chase first).

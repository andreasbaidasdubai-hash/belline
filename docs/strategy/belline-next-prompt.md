# Claude Code prompt — Belline: demo-led acquisition, Belle as the salesperson, AI-guided onboarding (UAE first)

Paste everything below this line into Claude Code, run from the `concierge` repo root.

---

You are working in the Belline repo (`concierge/`). Read `README.md`, `docs/STATUS.md` (especially "Commercial build-out"), `docs/strategy/belline-commercial-strategy-2026-09-14.md` and `docs/strategy/belline-claude-code-prompt.md` before writing anything. This prompt **supersedes Phases 3–5 of that earlier prompt** where they disagree. Phases 1–2 are done. Pricing has since been simplified to three all-in plans. If this prompt and the code disagree about what exists, trust the code and tell me.

## Where things stand (do not redo)

- **Pricing** (`src/lib/billing/plans.ts`): three plans — Starter AED 299, Business AED 599, Pro AED 1,199.
  - Every live channel (phone, website voice button, website chat) is in every plan; WhatsApp is `not-yet`.
  - No free tier, no per-minute charges.
  - 14-day card-free trial with 60 phone minutes.
  - Stripe checkout exists and is not yet keyed.
  - The website pricing and Belle's price answers are generated from `plans.ts`.
- **Markets:** only the UAE is open. Other markets are priced and marked provisional, planned for 2–3 months after the UAE launch. **Do not open another market in this work.** Keep everything market-aware through `src/lib/markets.ts`, so opening one later is configuration.
- **Sales engine** (`src/lib/sales/`): discovery, scoring, outreach templates, reply classification, and prospect demos built from a website (`createProspectDemo` in `src/lib/prospect.ts`, `/demo/[slug]`).
  - Outreach CTA defaults are `reply_question` and `demo_call`.
- **Belle** (`src/lib/seed-belline.ts`) today sells a 20-minute call. Her only tools are the booking tools.

## House rules (must survive every change)

- Money in integer minor units. Every feature, product, channel and market carries `status: "live" | "not-yet"`, and `not-yet` never renders publicly or is claimed by any agent.
- No per-minute overage anywhere. No agent quotes a discount, contract term, SLA or any price not in `plans.ts`. No agent takes card details by voice or chat.
- Nothing a model produces reaches a customer or a live venue unless code validates it first (forced tool choice + schema, post-checks in code).
- Every `scripts/check-*.ts` stays green; add one per new module in the same style. `npm run typecheck`, `npm run check:all` and `npm run audit` pass before a phase is reported done.
- No UTF-8 BOM. New asset types go into the regex in `scripts/build-site.ts`.
- At the end of each phase: run the checks, add a `docs/STATUS.md` entry in its existing format, and commit with the phase name. **Do not deploy.** Stop and ask me at every **[decision]**.

---

## Phase A — The personalised demo link replaces the demo call

**Goal.** An outreach email lands with a link to *their own* Belline. On that page the prospect can type to it or talk to it, and it answers as their business from their public website. The link is the primary CTA; the call becomes the fallback.

1. **The demo page** (`/demo/[slug]`).
   - Show the prospect's own venue running with the real website widget: chat *and* voice button, using the same `embed` and web chat code paths as a customer site. No recording or player as the main surface.
   - Header line: "A demo Belline built from <their website> — not connected to your diary; nothing booked here is real."
   - Two CTAs: "Start my 14-day trial" (pre-fills business name, website and vertical into `/checkout`) and "Talk to a person" (the existing call booking).
2. **Guards.**
   - Demo venues keep `prospect` and the existing expiry.
   - Per-demo caps: conversations per day, voice seconds per day, and messages per chat. Enforce them in the same gates as `checkEmbedGate` and `chatGate`, charged to us and never to a customer.
   - Refuse non-public URLs (the SSRF guard exists).
   - Never invent a price, service or person the site does not state. The existing honesty guard applies to written replies too.
3. **Tracking.**
   - Record `demo_opened`, `demo_chatted`, `demo_spoke` and `demo_trial_clicked` against the lead.
   - Bump the lead score (the `demo_used` pattern).
   - Notify a human (email to hello@) when a prospect chats or speaks for more than one exchange.
4. **Outreach.**
   - Add a `demo_link` CTA, make it the default in `src/lib/sales/config/defaults.ts`, and build the demo before the first email is queued so the link is live when it lands.
   - Rewrite the frames in `src/lib/sales/outreach/templates.ts`: primary CTA "Try your own receptionist" (the link), secondary "or start a 14-day trial, no card", and the call only as a PS.
   - Keep every existing guard: no invented facts, opt-out, send limits.
   - **[decision]** Confirm the daily send cap and the sending domain before any real email leaves.
5. **`scripts/check-demo-link.ts`.**
   - A fixture website → demo built → chat reply names only facts on the page.
   - The caps refuse the next conversation.
   - Tracking events are recorded.
   - An expired demo is gone.
   - The email body carries the demo URL and no price that is not in `plans.ts`.

## Phase B — Belle is the salesperson, on every inbound channel

**Goal.** On belline.ai (web chat, voice button, phone, and WhatsApp once live), Belle answers every question, qualifies, shows the prospect their own demo, and takes them to a trial or a checkout. A call with a person is offered only when asked, when the lead is a multi-venue group, or after two declined closes.

1. **Tools** in `src/lib/agent/tools.ts`, available only on `location.internal` (the Belline venue), in the same validate-and-recover style as the booking tools:
   - **`record_lead({ business, vertical, city, website, contact, pain, channelsTheyNeed })`**
     - Writes a sales lead through the discovery dedup path with source `inbound:<channel>`.
   - **`quote({ plan? })`**
     - Returns the three plans, their allowances and prices from `plans.ts` for the UAE.
     - A request for a discount, contract or SLA returns a fixed refusal, flags the lead `WANTS_PRICING` and offers a person.
     - A group with several venues gets "we price groups properly — let me get someone to you".
   - **`build_demo({ websiteUrl })`**
     - Runs `createProspectDemo` and returns the link.
     - On chat, shows the link. On voice or phone, sends it by SMS (or email if given) after reading the destination back.
     - Rate-limited per conversation.
   - **`start_trial({ businessName, email, vertical, websiteUrl })`**
     - Runs `signUp` + `draftFromWebsite`.
     - Emails a signed one-time sign-in link: add a 24-hour, single-use login token to `src/lib/auth.ts`.
     - Notifies hello@ with the transcript.
     - Belle must spell the email back letter by letter before calling it (the policy exists in the seed).
   - **`send_checkout({ email, plan, cycle })`**
     - Emails a checkout link for the chosen plan.
     - Never collects card details.
   - **`book_human_call()`**
     - The existing diary booking, now the fallback.
2. **Persona and policies** (`src/lib/seed-belline.ts`).
   - Rewrite the persona as a warm, direct salesperson who is useful first.
   - Order of moves:
     1. Answer the question.
     2. Ask what they run and how calls get missed today.
     3. Offer their own demo ("what's your website? I'll build it while we talk").
     4. Offer to start the trial.
     5. Offer checkout for a decided buyer.
     6. Offer the call as the fallback.
   - Disclose that she is an AI in the greeting.
   - Generate the "what does not work yet" list from `notYetLive()` at boot and forbid claiming any of it. Remove the hand-typed list, which currently contradicts the live-transfer FAQ.
3. **Channel parity.** The same tools and policies on web chat (`src/lib/webchat*.ts`), the voice button and phone (`AgentSession`), and WhatsApp (`src/lib/reception/respond.ts`). The tools follow the venue, not the transport.
4. **Inbound email and the website form.**
   - A `HAS_QUESTION` reply, or a form submission (`src/lib/leads/email.ts`), gets an auto-drafted answer within five minutes, built from `plans.ts` + the FAQ.
   - It carries the prospect's demo link, already built from the URL they gave, and the trial link.
   - `WANTS_PRICING` beyond list price, complaints and legal questions go to a human.
   - **[decision]** Whether these send automatically or wait for my one-click approval for the first 30 days.
5. **Website.**
   - Replace "book a call" with two buttons: "Build my demo" (a URL field → the personalised demo page) and "Start free — 14 days, no card".
   - Keep "Speak to Belle" as live proof.
6. **`scripts/check-belle-sales.ts`**: scripted text-console conversations, no keys.
   - Qualify → quote → demo link returned.
   - Qualify → trial started → magic link sent.
   - A discount request → refusal and `WANTS_PRICING` flag.
   - A not-yet capability question (WhatsApp, Arabic, Fresha) → honest refusal.
   - The email is spelled back before `start_trial`.
   - A non-business caller → no selling.
   - A group of 5 venues → handed to a person.
   - Extend `check-honesty.ts` for sales replies.

## Phase C — Onboarding with an AI assistant, backed by generated guides

**Goal.** A new venue goes from signup to its first real answered call with no email to us.

- **The assistant is the primary path.** Every step works without it, and the guides are generated from the same data the assistant uses, so the two never disagree.
- **What to collect:** only what the website does not already say, and only when it is needed.

1. **What we ask, and when.**
   - **At signup:** business name, email, password, vertical and website.
   - **The draft is read off the site** (`draftFromWebsite`): hours, services with prices and durations, staff, address, policies, FAQs. The owner confirms every field; nothing goes live unconfirmed.
   - **Then the assistant asks only about the gaps**, in this order, because each unblocks the next:
     - opening hours
     - services and durations
     - who takes bookings
     - transfer number for urgent calls
     - cancellation and deposit policy
     - languages the customers use
   - **Documents in:** accept a photo or PDF of a price list or menu. Extract it with a forced schema; always confirm before saving.
2. **The assistant.**
   - A setup chat on `/setup` and the dashboard, reusing the web chat component.
   - Its tools write through the config gate in `src/lib/booking/config.ts`: `set_hours`, `add_service`, `add_staff`, `set_policy`, `add_faq`, `set_address`, `set_transfer_number`.
   - Every write is a versioned Business Brain change authored "set up by Belline from your answers", and revertible.
   - A rejected write (a service whose stages don't add up) is explained in plain words, never a crash.
   - Also available by ringing the venue's new number in its first 24 hours, recognising the owner's mobile collected at signup.
3. **The technical steps, per venue.**
   - **Phone number:** assign a UAE number from a pool table (`data/number-pool.json`, filled by hand). With none free, create a task in `/sales/enquiries` and tell the owner a person will set it up within one working day. No mailto.
   - **Forwarding:** a per-carrier table (`src/lib/telephony/forwarding.ts`) — UAE first (du, e&, landlines/PBX), other countries added later as data — with exact codes.
   - **"Test my line":** Belline dials the venue's own number and reports whether the forwarded call arrived. Record it as `origin: "linecheck"`, never billed and never counted.
   - **Website widget:**
     - Detect the platform from the site's HTML (Squarespace, Wix, WordPress, Shopify, Webflow, GoDaddy, custom) and show that platform's exact steps.
     - "Email these steps to my web person."
     - Verify the snippet is live with a green tick.
   - **Integrations:** a "Request an integration" button on `/integrations` records which booking system the venue uses (Fresha, Treatwell, SevenRooms, OpenTable, other). Google Calendar stays behind its credentials; do not soften "not available".
4. **Readiness and the first week.**
   - A readiness score on the dashboard home, with the next step as one link.
   - Emails on day 1 ("ring it now"), day 3 ("what it handled") and day 10 ("choose a plan — trial ends in 4 days"), scheduled like `src/lib/reminders.ts`.
   - A first-7-days report as one page and one email.
5. **Guides.**
   - Generate `public/guides/forwarding/<carrier>.html` and `public/guides/widget/<platform>.html`, plus an index, from the same tables, in `build-site.ts`.
   - Add them to `PAGES` handling so they publish.
   - They are the fallback and the SEO surface, not the main path.
6. **`scripts/check-onboarding.ts`.**
   - Signup → draft from a fixture site → assistant sets hours and two services through the gate.
   - One invalid service is rejected with a spoken correction.
   - Number assigned from the pool, and the empty pool creates a task.
   - Forwarding codes for du and e&.
   - Line check recorded and not billed.
   - Widget detected on a fixture Squarespace page.
   - Readiness score moves.

## Phase D — Proof on the website, and the look

1. **[decision] Competitor review first.**
   - Read the public sites of Rosie, Dialzara, Goodcall, My AI Front Desk and Smith.ai.
   - Write `docs/strategy/competitor-site-review.md`: hero, proof (audio, demos, logos, reviews), pricing layout, CTA wording, trust signals. Say what to adopt and what to avoid for a UAE, premium-positioned brand.
   - Do not copy text or imagery.
   - Show me a side-by-side hero mockup (current vs proposed) before changing `public/landing.html`.
2. **Proof blocks**, each gated like `status: "live"`:
   - "Build my demo" and "Speak to Belle" side by side in the hero, plus a WhatsApp QR once WhatsApp is live.
   - A 20-second audio sample of a real booking call (consented, or the demo line).
   - A dashboard screenshot.
   - A testimonials block that renders only when `testimonials.json` has at least three entries with recorded consent.
3. Mobile first: less text per section, tap targets at least 44px. `npm run audit` must pass at every breakpoint.

## Phase E — Running it: operations the owner can trust

1. **Daily email to me:**
   - trials started by source
   - demos built, opened and used
   - conversions and MRR
   - measured unit costs (Phase 1)
   - any plan whose measured margin fell under 30% on the UAE line
2. **Alerts** when a paying venue's channel is entitled but broken: number unreachable, widget snippet gone, WhatsApp token expired.
3. **Operations agents**, internal only, drafting rather than acting:
   - triage the support inbox into categories with a suggested reply
   - flag trials that stalled at a setup step, and draft the nudge
   - summarise the week's lost calls per venue
   - Nothing here sends to a customer without my approval until **[decision]**.

---

When all phases are done:
- Update `README.md` and `docs/STATUS.md`.
- Give me one page listing the credentials and decisions still outstanding, in the order they unblock revenue: business email → Stripe (keys, tax settings, portal) → Meta Business verification and WhatsApp → UAE number pool and carrier rates → company details for the legal pages → sending domain for outreach.

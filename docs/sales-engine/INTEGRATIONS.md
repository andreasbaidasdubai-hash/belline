# Belline Sales Engine — Integrations

Every external service sits behind an interface with a mock implementation, the
convention already used by `src/lib/providers/{tts,stt,sms}.ts`: **missing key →
mock → the app still runs and says so.** `npm run sales-doctor` checks each key
against its provider and prints what is live.

Secrets live in environment variables. `sales.integration.config` holds the
*name* of the env var and non-secret settings, never a credential.

> Prices below are order-of-magnitude planning figures gathered before this
> document was written and are **not** current quotes. Verify each on the
> provider's own pricing page before committing budget — several of these
> changed pricing model in the last year.

---

## Already in the repo

| Provider | Key | Used for |
| --- | --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` | Every LLM agent. Live. |
| Deepgram | `DEEPGRAM_API_KEY` | Voice STT. Live. Phase 3 for outbound. |
| ElevenLabs | `ELEVENLABS_API_KEY` | Voice TTS. Live. |
| Twilio | `TWILIO_*` | Not configured yet. Needed for the demo number and Phase 3 outbound. |

Nothing new is needed for research, scoring, personalisation or the approval
queue — that whole path runs on the Anthropic key you already have.

---

## 1. Lead discovery

### Google Places API (New) — Phase 1

The only lawful way to get Google Maps business data at volume. Scraping Maps
violates Google's terms and is not an option the design considers.

- `searchText` / `searchNearby` for discovery, `place details` for hours,
  rating, review count, website, phone.
- Field masks matter enormously: Essentials/Pro/Enterprise SKUs bill
  differently, and requesting review text moves you to the expensive tier.
  Request only what the ICP and scoring model actually use.
- Ballpark $17–35 per 1,000 requests depending on SKU; a monthly free
  allowance exists. Budget ~$0.04 per discovered company including detail
  lookups.
- `place_id` → `company_location.external_id` gives free, exact dedup.
- Env: `GOOGLE_PLACES_API_KEY`. Restrict the key by API and by IP.

### CSV import — Phase 1

The zero-integration path, and genuinely useful: it lets you run the whole
pipeline on a hand-built list of 50 Dubai dental clinics on day one, before any
discovery key exists. Column mapping UI, same dedup, same normalisation.

### Later connectors

Apollo.io (search + enrichment, ~$0.02–0.10/contact on a seat plan), local
directories (Yellow Pages UAE, `local.ae`, `search.ch` and `local.ch` for
Switzerland, Maroof for KSA), professional registries (DHA/DoH/MOH clinic
listings in the UAE, SCFHS in Saudi, FMH/SSO in Switzerland — high-quality,
low-noise sources for medical verticals specifically).

---

## 2. Email — the decision that matters most

**Do not send cold outbound from `belline.ai`, and do not use a transactional
provider for it.** Resend, Postmark, SendGrid and Mailgun all prohibit cold
outreach in their terms and terminate accounts for it; more importantly, a
spam-complaint rate on your primary domain damages the deliverability of
customer and investor email you cannot afford to lose.

The required setup, regardless of provider:

1. **Separate sending domains.** Register 2–3 (`getbelline.com`,
   `belline-hq.com`), each redirecting to `belline.ai`.
2. **SPF, DKIM, DMARC** on every sending domain. DMARC starts at `p=none` and
   moves to `quarantine`.
3. **2–3 mailboxes per domain**, 30–50 sends/day each at steady state.
4. **4–6 weeks of warmup** before the first real campaign. This is a calendar
   constraint on Phase 1, not an engineering one — start it the day you pick a
   provider, in parallel with the build.
5. Custom tracking domain; open-tracking off or minimal (it hurts deliverability
   and reply rate is the metric that matters anyway).

### Provider options

| Option | Fit | Notes |
| --- | --- | --- |
| **Instantly / Smartlead** | Best Phase-1 fit | Purpose-built for cold outbound: inbox rotation, warmup, reply detection, unsubscribe. Both have APIs. ~$40–100/mo. Lets you send while you build. |
| **Amazon SES + own sending logic** | Best long-term economics | ~$0.10 per 1,000 emails. You own rotation, warmup, bounce/complaint handling, suppression. Real work, and SES will suspend you for complaint rates too. |
| **Google Workspace mailboxes via SMTP/Gmail API** | Highest deliverability per mailbox | Low volume ceiling; how most small outbound teams actually operate. |

**Recommendation:** build against the `EmailProvider` interface, ship the
Instantly/Smartlead adapter first (fastest path to a sent email, warmup
included), keep SES as the second adapter once volume justifies owning it.

```ts
export interface EmailProvider {
  send(m: OutboundEmail): Promise<{ providerMessageId: string; costUsd: number }>;
  listMailboxes(): Promise<Mailbox[]>;      // for rotation + daily caps
  verifyWebhook(req: Request): boolean;
  parseEvent(body: unknown): EmailEvent;    // delivered|opened|replied|bounced|complained
}
```

### Reply ingestion

Provider webhook where available; IMAP poll (`imapflow`) otherwise. Threading by
`References`/`In-Reply-To`. `List-Unsubscribe` and `List-Unsubscribe-Post`
headers on every message — one-click unsubscribe is now effectively mandatory
for bulk senders at Gmail and Yahoo, and it is also simply correct.

### Email verification

ZeroBounce / NeverBounce / MillionVerifier, ~$0.001–0.004 per address. Verify
before first send; a bounce rate above 2–3% is what gets a domain blocked.
Treat `catch_all` as risky, not valid.

---

## 3. Decision-maker enrichment

| Provider | Notes |
| --- | --- |
| Apollo.io | Broadest, weakest in the Gulf. Good for Switzerland. |
| Lusha / Cognism | Cognism has genuinely better EMEA/DACH coverage and does compliance work (notification requirements) that matters for Switzerland. |
| Dropcontact | GDPR-native, EU-hosted, no personal-data database — finds and verifies rather than resells. Good fit for the Swiss agent specifically. |
| LinkedIn Sales Navigator | Best data, **manual only**. Automating it risks the account. |

Gulf coverage is weak across all of them. For UAE and Saudi, the practical
source is the company's own website team page plus Instagram — which the
research crawler already reads — with providers as a supplement rather than the
primary path. Plan for company-level contact being the norm in the Gulf and
person-level being the norm in Switzerland.

---

## 4. Meetings

**Cal.com** (self-hostable, API-first, good webhooks) or **Google Calendar**
direct. Requirements: create a booking link scoped to a lead, receive a webhook
on book/reschedule/cancel, push the briefing into the event body, and handle
four timezones (`Asia/Dubai`, `Asia/Riyadh`, `Europe/Zurich`, plus yours).

```ts
export interface CalendarProvider {
  bookingLink(lead: Lead): Promise<string>;
  slots(from: Date, to: Date, tz: string): Promise<Slot[]>;
  parseEvent(body: unknown): MeetingEvent;
}
```

---

## 5. Voice — Phase 3

The strongest differentiator, and mostly built. Outbound prospecting reuses
`VoiceSession`, `runtime.ts` and the provider stack; what is missing is a
dialler and an outbound-specific prompt.

- Twilio programmable voice for origination. **Local numbers matter**: a +971
  number for the UAE, +966 for Saudi, +41 for Switzerland.
- Regulatory: the UAE TDRA and Saudi CITC both regulate telemarketing, and
  Switzerland has a mandatory do-not-call star (`*`) in the phone directory that
  must be honoured. Country rules gate this channel; see COMPLIANCE.md.
- Cost ≈ $0.07–0.09/minute all-in, per the figure already established in the
  main README.

### Demo lines — Phase 1/2, already built

`createProspectDemo()`, `/demo/[slug]`, `/ws/demo`, `signStreamToken()` and the
`DemoConfig` caps exist and work. The sales engine adds:

- A `sales.demo` row per issue, with the vertical-specific script hint.
- Usage tracking back from the voice product's call log into `activity`.
- Per-vertical demo numbers once Twilio is configured — the webhook already
  routes by dialled number, so one number per vertical needs configuration, not
  code.

---

## 6. WhatsApp — Phase 3, conditionally

Meta Cloud API via Twilio or 360dialog. Cold WhatsApp outreach is **not**
compliant in the general case: business-initiated messages require an approved
template and, in practice and under Gulf data-protection law, prior opt-in.

Defensible uses: continuing a conversation a prospect started, and messaging a
number the business publishes as a contact channel where local rules permit.
The channel is off by default per country and is enabled only with a documented
basis recorded in `consent_record`.

---

## 7. Cost model per lead

Planning figures for one lead taken from discovery through first contact:

| Step | Cost |
| --- | --- |
| Discovery (Places search + details) | ~$0.04 |
| Email verification | ~$0.003 |
| Research crawl (6 fetches) | ~$0 |
| Research LLM (~15k in / 1k out, Sonnet) | ~$0.05 |
| Decision-maker LLM | ~$0.01 |
| Personalisation LLM (~4k in / 400 out) | ~$0.015 |
| Email send | ~$0.001 |
| **Subtotal, first touch** | **≈ $0.12** |
| 3 follow-ups (personalised) | ~$0.04 |
| Reply classification, if any | ~$0.005 |
| **Full sequence** | **≈ $0.17** |

At 500 companies/month per agent that is roughly **$85/agent/month**, or about
**$1,000/month across twelve agents** — before enrichment seats and email
infrastructure. Add ~$100–200/month for sending infrastructure and enrichment.

Sensitivities worth knowing before you tune anything:

- Research is ~60% of per-lead LLM cost. Dropping to Haiku for research on
  `low`-priority verticals roughly halves it; test quality first, because a bad
  research record produces a bad email, which costs a prospect.
- Discovery costs are dominated by field masks. Requesting review *text*
  instead of review *count* can multiply the Places bill severalfold.
- Enrichment seats are usually the largest fixed line and the easiest to defer:
  Phase 1 does not need one.

Budgets are enforced, not just reported: `cost/budget.ts` sums `cost_event` per
agent per day and per month, refuses new LLM and paid-provider calls past the
cap, and sets `agent.status = 'paused'` with `paused_reason`.

---

## 8. Environment variables

```bash
# Sales engine — all optional; unset means that capability is mocked/off
DATABASE_URL=                       # postgres://…  unset = /sales disabled entirely

GOOGLE_PLACES_API_KEY=              # lead discovery

EMAIL_PROVIDER=                     # instantly | smartlead | ses | smtp
EMAIL_API_KEY=
EMAIL_SENDING_DOMAINS=              # getbelline.com,belline-hq.com
EMAIL_WEBHOOK_SECRET=

EMAIL_VERIFY_PROVIDER=              # zerobounce | neverbounce | millionverifier
EMAIL_VERIFY_API_KEY=

ENRICH_PROVIDER=                    # apollo | cognism | dropcontact
ENRICH_API_KEY=

CALENDAR_PROVIDER=                  # cal | google
CALENDAR_API_KEY=
CALENDAR_WEBHOOK_SECRET=

SALES_WORKER_CONCURRENCY=4
SALES_DEFAULT_MODEL=claude-sonnet-5
```

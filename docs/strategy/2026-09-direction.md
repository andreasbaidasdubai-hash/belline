# Belline strategic direction — September 2026

Saved 2026-09-15 from the founder's brief. This is the reference document the
audit and implementation prompts (1b design/UX, 1c copy/marketing, 1d
funnel/analytics, and the CTO master prompt) point to.

---

You are acting as Belline's combined CTO, principal product engineer, integration architect, UX/CRO lead, QA lead and commercially rigorous SaaS operator.

This is a strategic product-direction change. Your task is to inspect the complete existing Belline repository, assess the impact of the new direction, create a safe implementation plan and then execute the highest-priority frontend, backend, database, billing, onboarding, integration, analytics and testing changes.

Do not stop after producing recommendations. Continue into implementation unless an external credential, commercial provider approval or genuinely irreversible decision blocks safe work.

Do not deploy, send external communications, modify live provider accounts, push commits or perform destructive production migrations without explicit authorization.

## New strategic direction

Belline is no longer intended to become a full calendar or booking-management platform.

Belline should become:

**"The AI receptionist that works with the tools a business already uses."**

The core customer promise is:

**"Keep your number. Keep your calendar. Keep your booking system. Belline simply answers and books for you."**

Belline is an omnichannel AI reception and communication layer across:

- telephone;
- website chat;
- WhatsApp.

Belline should:

- answer calls and messages;
- answer questions from verified business information;
- capture leads;
- take messages;
- identify customer intent;
- check availability through connected systems;
- create, modify and cancel bookings through connected systems;
- send confirmations and reminders where supported;
- transfer important calls or conversations;
- escalate uncertain or prohibited requests;
- display transcripts and outcomes;
- measure enquiries and bookings attributable to Belline.

Belline should not try to replace:

- Google Calendar;
- Microsoft Outlook;
- Fresha;
- SevenRooms;
- OpenTable;
- clinic-management systems;
- restaurant table-management systems;
- staff scheduling;
- payment/deposit platforms;
- full CRM platforms.

## Primary customer segments

Belline must serve three principal routes.

### Route A: Existing booking-platform customer

The business uses Fresha, SevenRooms, OpenTable or another specialist system.

Belline connects to that system if and only if an authorized, tested integration exists. The external system remains the source of truth.

Sales proposition:
"Add an AI receptionist without changing your booking system."

### Route B: Simple calendar customer

The business uses Google Calendar or Microsoft Outlook.

Belline connects to the existing calendar and uses a small set of Belline booking rules for service duration, staff/resource selection, buffers, minimum notice and escalation.

Sales proposition:
"Turn your existing calendar into a receptionist that answers and books 24/7."

### Route C: No supported booking connection

The business has no digital calendar or uses an unsupported system.

Belline must still be useful. It should:

- answer FAQs;
- capture the customer's details and request;
- take a message;
- transfer the call where appropriate;
- send the customer the business's existing booking link where supported;
- create a follow-up item;
- request manual confirmation from the business.

If a basic scheduling option is required, assess using established infrastructure such as Cal.com instead of continuing to build a full proprietary calendar.

Sales proposition:
"Belline answers every enquiry and makes sure the right person follows up."

## Product architecture requirement

Build or refactor toward a provider-independent booking abstraction.

The telephone, website-chat and WhatsApp channels must all call the same deterministic booking interface.

Create an interface conceptually equivalent to:

- getServices()
- getStaffOrResources()
- getAvailability()
- createBooking()
- modifyBooking()
- cancelBooking()
- getBooking()
- getBookingLink()
- verifyConnection()
- processWebhook()

Potential adapters include:

- GoogleCalendarProvider
- MicrosoftCalendarProvider
- BellineSimpleProvider
- FreshaProvider
- SevenRoomsProvider
- OpenTableProvider
- UnsupportedProviderFallback

Use names and patterns appropriate to the existing codebase rather than forcing these exact names.

Requirements:

- The LLM may interpret natural-language intent.
- The LLM must never invent availability.
- The LLM must never mark a booking as confirmed without deterministic confirmation from the provider.
- Booking creation must be idempotent.
- Prevent double-booking and race conditions.
- Preserve time-zone information.
- Webhook processing must be authenticated and idempotent.
- Provider failures must produce safe customer-facing fallbacks.
- Store external provider IDs and synchronization state appropriately.
- Tokens must be encrypted and never exposed to the client or logs.
- Use minimum required OAuth scopes.
- Disconnection and expired credentials must be handled clearly.
- Never claim an integration is available unless it is operational and enabled.

## Native calendar decision

Audit the existing Belline calendar and booking code.

Categorize every part as:

1. retain;
2. refactor into shared booking logic;
3. freeze;
4. deprecate later;
5. remove only after safe migration.

Do not delete existing bookings or break current accounts.

Stop expanding Belline into a sophisticated calendar interface. Retain only the minimum UI needed to:

- view bookings created or handled by Belline;
- view booking status;
- see the connected provider;
- open the record in the external provider;
- identify failed synchronization;
- request follow-up;
- understand Belline-attributed value.

The connected booking platform should remain the operational source of truth.

## Integration priority

Implement integrations in this order unless the audit provides a strong technical reason to change it:

1. Google Calendar;
2. Microsoft Outlook/365;
3. provider-neutral architecture and unsupported-system fallback;
4. Cal.com or Nylas assessment for broader calendar coverage;
5. Fresha;
6. SevenRooms;
7. OpenTable;
8. additional systems requested repeatedly by real customers.

Before representing Fresha, SevenRooms, OpenTable or any similar platform:

- verify whether public API access exists;
- verify whether partner approval is required;
- verify permitted use;
- verify authentication;
- verify whether availability and booking creation are supported;
- verify rate limits;
- verify webhooks;
- verify fees;
- verify logo and trademark permissions.

If access is unavailable, create a disabled adapter or documented integration specification, not fake functionality.

## Channel setup

### Telephone

Audit and improve:

- existing-number call forwarding;
- local UAE telephone-number support;
- busy/no-answer/after-hours forwarding modes;
- live transfers;
- fallback numbers;
- forwarding instructions by provider;
- call testing;
- provider failure handling;
- call duration and billing events;
- fraud and abuse controls.

The onboarding UI should not claim setup is complete until a successful test call has been made.

### Website chat

Create or verify:

- one copyable installation snippet;
- clear WordPress, Wix, Shopify and Google Tag Manager instructions where applicable;
- domain allowlisting;
- configurable branding;
- mobile responsiveness;
- human takeover;
- safe fallback;
- installation verification;
- conversation tracking.

Do not fabricate native plugins if they do not exist. Label copy-paste instructions honestly.

### WhatsApp

Create or verify a proper architecture for:

- Meta WhatsApp Business Platform;
- embedded signup where supported;
- business/account verification;
- number ownership;
- existing-number compatibility or coexistence;
- webhook verification;
- inbound messages;
- approved outbound templates;
- 24-hour service-window rules;
- human takeover;
- opt-outs;
- template and Meta fees;
- connection status;
- failure recovery.

Do not display WhatsApp as live or included until the complete flow works safely. Put incomplete functionality behind a feature flag.

## Revised onboarding

Design and implement onboarding around this sequence:

1. Business identity
2. Import business information
3. Review extracted information
4. Choose business type/template
5. Connect booking destination
6. Confirm booking and escalation rules
7. Connect communication channels
8. Run test conversations
9. Resolve detected problems
10. Explicitly approve activation
11. Monitor the first week

### Business-information import

Allow the customer to provide:

- website;
- Google Maps/profile URL;
- Instagram/profile information where permitted;
- uploaded menu or price list;
- manual information.

Extract and structure:

- business name;
- description;
- location;
- contact details;
- operating hours;
- services;
- prices;
- staff;
- FAQs;
- policies;
- booking links.

Show confidence and source information where practical. Require the owner to confirm critical facts.

### Booking configuration

If Google or Outlook is selected, collect only necessary information:

- services;
- duration;
- relevant staff/calendar;
- buffers;
- minimum notice;
- maximum advance booking;
- operating hours;
- cancellation rules;
- required customer details.

If a specialist provider is connected, import these details where the provider permits it and ask the owner only about unresolved rules.

### Testing

Before activation:

- require test calls/chats;
- test common FAQs;
- test booking;
- test unavailable times;
- test cancellation;
- test uncertainty;
- test escalation;
- test prohibited requests;
- verify that external bookings were actually created;
- cleanly identify test data.

## New website narrative

Audit and update the public site around this positioning:

Primary headline:
"Someone always answers."

Recommended supporting proposition:
"Belline answers your phone, website and WhatsApp—and books customers into the calendar you already use."

Supporting reassurance:
"Keep your number. Keep your booking system. Get started in approximately 30 minutes."

Use "approximately 30 minutes" only if the implemented onboarding can reasonably support it. Otherwise use an honest alternative.

Primary CTA:
"Connect your business"

Secondary CTA:
"Speak to Belline"

Key website sections:

1. Hero and live demonstration
2. The missed-enquiry problem
3. Phone, website and WhatsApp channels
4. "Works with how you already work"
5. Integrations
6. Customer routes
7. How setup works
8. Booking and safe handover
9. Measurable value
10. Pricing
11. Security/trust
12. FAQ

Only show integration logos for production-ready integrations. Use states such as:

- Available
- Beta
- Coming soon
- Request this integration

The website must clearly explain:

- connected-system booking;
- Google/Outlook option;
- unsupported-system fallback;
- customer keeps their existing number;
- AI uncertainty and human handover;
- channel availability;
- what is and is not currently operational.

Remove or rewrite claims implying that Belline's proprietary calendar is a required part of the product.

## Revised sales segmentation

Design the product/data model so acquisition can eventually segment prospects by:

- booking provider;
- business type;
- location;
- channels offered publicly;
- presence of online booking;
- call-based booking language;
- existing booking link;
- business size indicators.

Prepare templates for:

**Existing platform**
"Already using [provider]? Belline answers enquiries and books into the system your team already uses. No migration and no second calendar."
Only use this language when the provider integration is operational.

**Google/Outlook**
"Your calendar already knows when you are free. Belline turns it into a receptionist that answers and books 24/7."

**Unsupported/no system**
"Belline answers every enquiry, captures the customer's request and makes sure your team knows what to do next."

Do not scrape prohibited sources or send any real outbound campaigns.

## Revised pricing

Implement a centralized, versioned pricing catalogue with UAE pricing as follows.

### Starter — AED 199 per location/month

Positioning:
"For a small business that wants every enquiry answered."

Include:

- one location;
- two users;
- telephone receptionist;
- website chat;
- 75 telephone minutes/month;
- 200 website-chat conversations/month;
- one Google Calendar or Microsoft Outlook connection;
- FAQ answering;
- lead and message capture;
- simple appointment creation where supported;
- existing booking-link handoff;
- transcripts and summaries;
- basic dashboard;
- standard support;
- 30-day history.

Annual:
AED 1,990 billed yearly.

### Growth — AED 399 per location/month

Mark as "Most popular."

Positioning:
"For a business that wants Belline answering and booking across every available channel."

Include:

- one location;
- five users;
- telephone;
- website chat;
- WhatsApp when production-ready;
- 300 telephone minutes/month;
- 750 text conversations/month shared across website chat and WhatsApp where technically appropriate;
- Google or Outlook connection;
- one supported specialist booking integration;
- booking creation, modification and cancellation where provider-supported;
- reminders;
- live transfer and human handover;
- configurable escalation rules;
- booking and estimated-value analytics;
- 12-month history;
- faster support.

Annual:
AED 3,990 billed yearly.

### Scale — AED 799 per location/month

Positioning:
"For higher-volume teams with more complex reception rules."

Include:

- one location;
- 15 users;
- all active channels;
- 750 telephone minutes/month;
- 2,000 text conversations/month;
- multiple supported booking/calendar connections where technically valid;
- advanced routing;
- advanced staff/resource rules;
- configurable call flows;
- advanced analytics;
- assisted onboarding;
- priority support;
- longer history;
- API/webhook access only if securely implemented.

Annual:
AED 7,990 billed yearly.

### Additional usage

- 100 additional telephone minutes: AED 99
- 250 additional text conversations: AED 49
- assisted setup for Starter or Growth: AED 399 once
- each additional location requires a separate subscription
- 5–19 locations: 10% volume discount
- 20+ locations: custom pricing

### Trial

Fourteen days, no card:

- approximately 30 telephone minutes;
- approximately 50 text conversations;
- one calendar connection;
- website-chat test;
- telephone test;
- booking test where supported.

Centralize these values so product entitlements, checkout, website and billing cannot diverge.

## Usage and billing safety

Remove any economically dangerous promise that Belline will continue providing unlimited voice or text usage for no additional charge after plan allowances are consumed.

Implement:

- usage metering;
- usage display;
- alerts at 70%, 90% and 100%;
- optional automatic usage packs;
- customer-defined monthly spending caps;
- invoices showing usage clearly;
- upgrade recommendations;
- graceful behaviour when limits are reached;
- admin visibility into cost and gross margin.

The customer must choose whether to:

1. automatically purchase usage packs;
2. upgrade;
3. apply a hard spending cap.

Do not surprise customers with open-ended invoices.

Before finalizing allowances, calculate expected gross margin using the actual configured providers. Report:

- voice cost per minute;
- telephony cost;
- LLM cost;
- TTS/STT cost;
- chat cost;
- WhatsApp/Meta cost;
- SMS cost;
- provider subscription costs;
- payment fees;
- expected gross margin per plan at 25%, 50%, 75% and 100% allowance utilization.

If actual costs make any plan unsafe, do not silently change the strategic price. Flag the issue prominently and recommend revised allowances.

## Billing migration

Audit the current billing provider and subscription implementation.

Requirements:

- do not overwrite existing provider price IDs;
- version the plan catalogue;
- grandfather existing paid subscriptions unless explicitly migrated;
- preserve subscription status;
- make database migrations additive and reversible;
- support monthly and annual billing;
- validate webhook signatures;
- ensure idempotent webhook processing;
- prevent entitlement drift;
- test upgrade, downgrade, cancellation, failed payment, renewal and trial conversion;
- ensure the public pricing table matches checkout exactly.

Do not modify live Stripe or other billing-provider products without authorization. Prepare scripts/configuration and document the exact external action required.

## Dashboard changes

Refocus the dashboard away from calendar management and toward Belline's value.

Show where data supports it:

- calls answered;
- calls outside business hours;
- chat and WhatsApp enquiries;
- leads captured;
- booking requests;
- confirmed bookings;
- modified/cancelled bookings;
- transfers;
- messages requiring follow-up;
- unresolved questions;
- provider synchronization failures;
- estimated booking value;
- trends;
- usage against plan limits.

Clearly distinguish:

- enquiry;
- booking request;
- provider-confirmed booking;
- completed booking;
- estimated value;
- verified revenue.

Never represent estimates as confirmed revenue.

## Security and reliability

Audit and strengthen:

- tenant isolation;
- OAuth token encryption;
- authorization;
- provider scope minimization;
- prompt injection;
- business-knowledge grounding;
- PII logging;
- data retention;
- transcript access;
- webhook authentication;
- idempotency;
- booking race conditions;
- time zones;
- provider outages;
- voice-provider outages;
- WhatsApp replay/duplicate events;
- failed reminders;
- usage fraud;
- rate limiting;
- configuration audit trails;
- rollback;
- test versus production data.

## Analytics

Track this funnel:

- landing-page visit;
- live demo started;
- pricing viewed;
- checkout started;
- account created;
- onboarding started;
- business information imported;
- booking provider selected;
- provider connected;
- website chat installed;
- WhatsApp connected;
- phone forwarding configured;
- test call completed;
- test booking confirmed;
- account activated;
- first real enquiry;
- first confirmed booking;
- trial converted;
- subscription upgraded;
- cancellation and reason;
- support intervention.

Critical metrics:

- onboarding completion rate;
- time to activation;
- human-assistance minutes per activated customer;
- integration success rate;
- trial-to-paid conversion;
- 30/60/90-day retention;
- churn;
- support time per location;
- gross margin by plan;
- resolution rate;
- booking conversion;
- meaningful error rate;
- recovered-booking estimate.

Use the existing analytics stack where possible.

## Required working process

### Phase 1: Complete audit

Produce:

- architecture map;
- current customer journey;
- current billing model;
- calendar/booking audit;
- integration inventory;
- frontend and backend feature matrix;
- security and reliability risks;
- tests/build baseline;
- commercial inconsistencies;
- exact files affected by the strategy change.

### Phase 2: Plan

Create a dependency-aware backlog:

- P0: security, data, billing, reliability or activation blocker;
- P1: required for new positioning and initial customers;
- P2: required after customer validation;
- P3: premature.

Each item must include:

- customer problem;
- proposed implementation;
- affected systems;
- risk;
- complexity;
- acceptance criteria;
- tests.

### Phase 3: Execute

Implement safe P0 and P1 items.

Prioritize:

1. provider-independent booking architecture;
2. preservation/migration of existing booking data;
3. Google Calendar connection or completion;
4. Outlook integration foundation;
5. unsupported-provider fallback;
6. versioned pricing and entitlements;
7. onboarding changes;
8. website narrative;
9. dashboard value metrics;
10. usage metering and limits;
11. analytics;
12. tests and reliability.

Do not create fake integrations or non-functional interface elements.

Use feature flags for incomplete integrations.

### Phase 4: Verify

Run:

- formatting;
- linting;
- type checking;
- unit tests;
- integration tests;
- end-to-end tests where available;
- database migration tests;
- billing webhook tests;
- production build;
- security/dependency checks available in the repository;
- mobile and desktop visual checks;
- accessibility checks;
- empty/loading/success/error-state checks.

Review the final diff for accidental changes, unsupported claims, secrets and dead code.

## Final report

Provide:

1. Brutally honest readiness assessment.
2. Architecture before and after.
3. What was implemented.
4. What could not be implemented and why.
5. Files and systems changed.
6. Database and billing migrations.
7. Test results.
8. External credentials or provider approvals still required.
9. Current live integrations versus beta and planned integrations.
10. Gross-margin assessment for each plan.
11. Remaining risks.
12. Next five actions in strict priority order.
13. Readiness for 10, 100 and 1,000 customers.
14. A clear go, modify or stop recommendation.

## Non-negotiable principles

- Inspect before modifying.
- Preserve working functionality and data.
- Do not invent provider capabilities.
- Do not claim integrations before they work.
- Do not let the LLM invent availability.
- Do not expose provider tokens.
- Do not hard-code pricing in multiple places.
- Do not perform destructive migrations.
- Do not modify live billing products without authorization.
- Do not send emails, calls or WhatsApp messages.
- Do not deploy or push without authorization.
- Do not over-engineer the calendar.
- Do not stop at a strategy document.
- Ask questions only when genuinely blocked.
- Make reversible, documented decisions and continue.

Begin with Phase 1, show the concise audit and implementation plan, and then proceed directly into the safe local implementation.

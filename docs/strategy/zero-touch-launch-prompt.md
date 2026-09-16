# Prompt: zero-touch onboarding, go-live and launch readiness

Paste this into a new Claude Code session in the concierge folder. It relies on
`docs/strategy/2026-09-direction.md` and on the launch documents in
`docs/launch/` (legal, data protection, integrations, email, payments,
operations, LAUNCH-CHECKLIST.md).

---

```
Read docs/strategy/2026-09-direction.md and everything in docs/launch/ first (LAUNCH-CHECKLIST.md, legal/, data-protection/, integrations/, email/, payments/, whatsapp/, operations/). Use a workflow. Act as head of product, principal engineer, QA lead, compliance lead and a demanding first-time customer.

Goal: a UAE clinic, salon or restaurant owner can go from belline.ai to a live, working AI receptionist with no human from Belline involved — Amazon-style: one obvious next step at every moment, minimal typing, fast, forgiving, and impossible to get stuck. Behind it, the business itself must be legally, technically and operationally ready to run without constant founder intervention.

Phase 1 — Prove the current state end to end (read-only, no real payments or messages):
1. Customer journey: walk the complete journey as three fresh customers (Route A existing booking platform, Route B Google/Outlook, Route C no system) with playwright at 375px and 1440px: landing → Speak to Belline → pricing → signup → import business info → review → booking destination → rules → phone forwarding → website chat install → WhatsApp → test conversations → activation → first-week view → billing → upgrade → cancellation → data export or deletion. For every step record time, clicks, fields typed, anything needing a Belline staff member, missing credentials, dead ends, unclear wording, missing error/empty/loading states, and behaviour when a step fails (OAuth declined, forwarding wrong, widget not detected, payment failed, provider down).
2. Staff side: sales console, leads, clients, approvals, inbox takeover. For each task decide: automate, customer self-service, AI assistant, or human only as an exception.
3. Legal documents: compare docs/launch/legal/ (terms of service, data processing agreement, acceptable use policy, privacy policy updates, sub-processors) with what the product and website actually do and say. Check the signup and checkout flows capture acceptance of terms and the DPA with version and timestamp, that the legal pages are reachable from signup, checkout, the widget and emails, and that no placeholder text would ship.
4. Data protection: verify the P0 items in docs/launch/data-protection/assessment.md against the code — personal data in logs, retention per plan, deletion and export, encryption of credentials, tenant isolation, consent and AI disclosure in greetings and the chat widget, clinic-specific health-data handling, sub-processor list matching reality.
5. Calendar and booking integrations: check the provider-independent booking interface, Google Calendar and Microsoft Outlook OAuth flows (minimum scopes, encrypted tokens, refresh and expiry handling, disconnect, webhook or polling sync), Route C fallback, and that integration status labels (Available / Beta / Coming soon / Request) match what really works. List every missing env var or route named in docs/launch/integrations/.
6. Email and communication: transactional email wiring (Resend, sending domain, templates, bounces), what is sent to customers and to their end users (confirmations, reminders, trial, usage alerts, failed payment, security notices), SMS and WhatsApp templates and the 24-hour window rules, support channels (support@, in-app help, AI setup assistant), and unsubscribe/opt-out handling.
7. Product and operations: run all checks, type check and build; confirm every automated job (reminders, usage metering, trial expiry, Stripe/Meta/Twilio webhooks) runs, is idempotent and alerts on failure; compare with docs/launch/operations/readiness.md for backups and restore, monitoring and alerting, CI, secrets rotation, rate limiting and fraud controls, feature flags, incident runbooks, and analytics/funnel tracking.

Phase 2 — Design the zero-touch flow and launch plan:
- A single onboarding path with smart defaults, website import that pre-fills everything, one-click OAuth for Google and Outlook, copy-paste widget with automatic install detection, carrier-specific forwarding codes with an automatic test call, WhatsApp setup that works without Meta paperwork for the customer, a built-in test conversation that checks FAQs, booking, cancellation and escalation automatically, and an explicit "Go live" button that only appears when every check passes.
- Terms, DPA and privacy acceptance built into signup without friction; data export and deletion as self-service; AI disclosure configured by default.
- An in-product AI setup assistant (Belle) that guides, fixes common problems, answers "how do I" questions and only escalates to a human ticket when truly blocked.
- Self-service for everything after launch: plans, usage packs, spending caps, invoices, users, integrations, pausing, cancelling, exporting and deleting data.
- Automated lifecycle messages (welcome, stuck in setup, test not completed, first enquiry, usage alerts at 70/90/100%, trial ending, failed payment, cancellation survey) — drafted and wired, not sent.
- A staff exceptions queue so a human only sees what automation could not solve, with the reason.
- Operations: backups with a tested restore, uptime and error alerts, CI on every push, secrets rotation, fraud limits, status page.
Rank everything P0 (blocks a customer going live alone, or blocks lawful/safe operation), P1, P2, with acceptance criteria and tests. Show me the plan.

Phase 3 — Build the P0 items locally with tests, feature flags for anything that depends on missing credentials or provider approvals, and an end-to-end playwright test that completes the full self-serve journey against staging-safe test data. One commit per batch. Do not deploy, push, charge cards, create provider accounts, change DNS, or send real emails, SMS, calls or WhatsApp messages.

Final report: time to live and number of human touches today vs after; every remaining step that still needs a human and why; every external account, credential, legal or provider approval still missing (update docs/launch/LAUNCH-CHECKLIST.md); a go / modify / stop recommendation.
```

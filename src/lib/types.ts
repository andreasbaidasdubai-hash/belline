import type { BrainVersion } from "./brain";
import type { GoogleLink } from "./integrations/google";
import type { OutlookLink } from "./integrations/outlook";
import type { BillingCycle, LegacyPlanId, ProductId } from "./billing/plans";
import type { Market } from "./markets";

// Domain model.
//
// Two deliberate choices shape everything below:
//
// 1. Times are stored as `minutes from local midnight` plus a `YYYY-MM-DD`
//    date string, never as UTC instants. A 19:30 dinner booking is 19:30 in
//    the venue's own wall clock regardless of DST, server region, or where
//    the caller is. This is how real reservation systems model it and it
//    removes an entire category of off-by-an-hour bugs.
//
// 2. Everything a caller can change lives in the same shape whether the
//    tenant is a restaurant or a salon. The verticals differ only in how
//    availability is *computed* (tables + pacing vs. staff + resources), so
//    only the config and the search function are vertical-specific.

/**
 * `salon` and `clinic` share one engine: both are a diary of qualified people,
 * timed services, shared rooms and cleanup buffers. Only the vocabulary and
 * the house rules differ, so they differ in configuration rather than code.
 */
export type Vertical = "restaurant" | "salon" | "clinic";

/** A language Belline can answer a venue's customers in. See language.ts. */
export type VenueLanguage = "en" | "de";

/** Minutes from local midnight, e.g. 19 * 60 + 30 === 1170 for 19:30. */
export type Minutes = number;

/** `YYYY-MM-DD` in the location's own timezone. */
export type DateStr = string;

export interface TimeRange {
  start: Minutes;
  end: Minutes;
}

/** Index 0 = Sunday, matching `Date.getDay()`. */
export type WeeklyHours = Record<number, TimeRange[]>;

// ---------------------------------------------------------------------------
// Tenant
// ---------------------------------------------------------------------------

/**
 * A customer of Belline's.
 *
 * Everything a tenant owns carries its id, and every query in the data layer
 * takes one. That is not belt-and-braces — it is the only property a business
 * buying multi-tenant software will actually ask about, and the failure being
 * designed against is not an attack but a developer in six months writing a
 * query that forgets. A signature that makes forgetting impossible is worth
 * more than a review that catches it most of the time.
 *
 * Introduced after the fact, in 2026-09, because the product started as one
 * venue group and grew into SaaS. Existing data was migrated into a single
 * tenant, so nothing observable changed the day it landed — see
 * `ensureTenancy` in seed.ts.
 */
export interface Tenant {
  id: string;
  name: string;
  status: "active" | "suspended";
  createdAt: string;
  /**
   * Ours, not a customer's. Holds Belline's own demo venue, which runs on the
   * same engine as everybody else's and must never appear in anybody's data.
   */
  internal?: boolean;
  /** What happened when the account was opened. */
  onboarding?: {
    /** The legal versions the owner agreed to at signup (legal.ts). */
    terms?: TermsAcceptance;
  };
}

export interface TermsAcceptance {
  tosVersion: string;
  dpaVersion: string;
  acceptedAt: string;
  /** The email address that ticked the box. */
  acceptedBy: string;
}

/**
 * One business, which may have several locations.
 *
 * The layer the old model skipped. "Dental Group" with branches in Marina,
 * Jumeirah and Downtown is one business and three diaries: the services, the
 * staff and the hours differ per branch, the name, the category and the
 * policies do not. Without this, "which of your branches is closest?" has
 * nowhere to be answered from.
 */
export interface Business {
  id: string;
  tenantId: string;
  name: string;
  /** What the business is, in a word: "Dental practice", "Salon", "Restaurant". */
  category?: string;
  description?: string;
  phone?: string;
  email?: string;
  website?: string;
  /**
   * Whether this business may appear in a consumer search.
   *
   * Off unless a merchant turns it on, and off is the value a business gets by
   * existing. The future consumer product reads businesses with this set and
   * nothing else; a business that has never heard of it is not in it.
   */
  discoverable?: boolean;
  createdAt: string;
}

export interface Location {
  id: string;
  /**
   * Who owns this venue, and which of their businesses it belongs to.
   *
   * Both are backfilled for data that predates tenancy, so they can be relied
   * on everywhere rather than defended against at each call site.
   */
  tenantId: string;
  businessId: string;
  name: string;
  vertical: Vertical;
  /**
   * What the owner said they do, from the checkout's list (signup-rules.ts
   * `TRADES`). The engine reads `vertical`; this is the finer answer, kept so
   * a report can tell a vet from a car garage when both are the same diary.
   * Absent on venues that signed up before the list existed, and on anyone
   * who chose "Something else".
   */
  tradeKey?: string;
  timezone: string;
  /**
   * The business's own phone number, E.164, or "" when not given: the number
   * its customers already dial. Saved on the setup review and the venue's
   * details, and what the agent and every message give out ("Please ring us
   * on …"). Never a number calls are forwarded to — that is `bellineNumber`,
   * and nothing that assigns one may touch this.
   *
   * Both used to share one `phone` field, so assigning a Belline number
   * overwrote the owner's own line and setup told an owner to forward calls
   * to their own mobile. seed.ts `splitVenuePhones` moved stored venues across.
   */
  businessPhone: string;
  /**
   * The Belline number: where the business forwards its calls, and the number
   * /api/twilio/voice finds this venue by. Absent until one is assigned. See
   * telephony/pool.ts and the staff "Record a number" route.
   */
  bellineNumber?: BellineNumber;
  address: string;
  currency: string;
  /**
   * The language customers are answered in: calls, the website button, web
   * chat, WhatsApp and every system message they see. "en" unless the owner
   * chose otherwise, and German only counts while the `language.de` flag is
   * on — read it through language.ts `answersIn`, never directly. Absent on
   * venues saved before it existed; seed.ts `ensureLanguage` fills "en".
   */
  language?: VenueLanguage;
  hours: WeeklyHours;
  /** Dates the venue is fully closed (holidays, private hire). */
  closures: DateStr[];
  agent: AgentConfig;
  restaurant?: RestaurantConfig;
  salon?: SalonConfig;
  /**
   * The house rules about *when* and *on what terms*, as opposed to what is
   * physically free. Absent means the engine only answers the physical
   * question, which is what it did before this existed.
   */
  policy?: BookingPolicy;
  /** Set when this venue is a public showcase rather than a real business. */
  demo?: DemoConfig;
  /** Set when this venue was read off a prospect's website for a sales demo. */
  prospect?: ProspectConfig;
  /**
   * Every published configuration this venue has had, oldest first.
   *
   * The live fields above are what the agent reads on the next call; this is
   * the record of how they got that way. See `brain.ts` — the questions asked
   * after something goes wrong are who changed it, when, why, and which
   * version handled the call being complained about, and a prompt cannot
   * answer any of them.
   */
  brainHistory?: BrainVersion[];
  /** A connected Google Calendar, mirrored to one-way. */
  google?: GoogleLink;
  /**
   * When a "Connect Google Calendar" was started and never came back from
   * Google. Cleared by the next connection that does. See integrations/google.ts.
   */
  googleConnectAbandonedAt?: string;
  /** A connected Outlook calendar (Microsoft 365 or Outlook.com). See integrations/outlook.ts. */
  outlook?: OutlookLink;
  /** As `googleConnectAbandonedAt`, for Outlook: a connection that never came back from Microsoft. */
  outlookConnectAbandonedAt?: string;
  /** When Microsoft last said the owner's organisation must approve Belline first. Cleared by a connection. */
  outlookAdminApprovalAt?: string;
  /**
   * What one booking is typically worth here.
   *
   * Entered by the venue or left alone. Belline never guesses it: an invented
   * ROI figure is the fastest way to lose an operator who knows their own
   * numbers better than we do, and unset shows no estimate rather than zero.
   */
  averageBookingValue?: number;
  /** Reminder texts to this venue's guests. Absent means on, 24 hours before. */
  reminders?: { enabled: boolean; hoursBefore: number };
  /**
   * The venue's own Stripe account, for deposits.
   *
   * The venue's, not ours: a deposit is the venue's money, and Belline is never
   * the merchant for it. Set by Connect onboarding; see billing/deposits.ts.
   */
  payments?: { stripeAccountId?: string; chargesEnabled?: boolean; updatedAt?: string };
  /** What this venue pays, and what it is owed. Absent until it signs up. */
  subscription?: Subscription;
  /**
   * The handles Stripe knows this venue by.
   *
   * Two ids and nothing else. Belline stores what it needs to open a customer
   * portal and to match a webhook to a diary; everything else about the
   * subscription — the card, the invoices, the retry schedule — is Stripe's to
   * be authoritative about, and mirroring it here would be a second source of
   * truth for somebody else's data.
   */
  stripe?: { customerId?: string; subscriptionId?: string };
  /**
   * The booking is not complete without an email address.
   *
   * True for a venue whose booking *is* something sent — a video call, a link,
   * a joining instruction. Where it is set the agent must take an address,
   * spell it back, and have it confirmed before booking, because an address
   * misheard over a phone line fails silently: nothing bounces that anybody
   * reads, and the guest simply never hears from us again.
   */
  requiresEmail?: boolean;
  /**
   * Ours, not a customer's.
   *
   * Belline's own venue — the diary of demo calls behind the bell on the
   * website — runs on the same engine as everybody else's, which is the whole
   * point of it. But it is not a venue anybody signed up for, and it must
   * never appear in a customer's venue switcher, their call list or their
   * bookings. `listLocations()` leaves it out unless asked for it directly.
   */
  internal?: boolean;
  /**
   * Belline on this venue's own website.
   *
   * Absent means the widget is off, which is the state every venue starts in:
   * a public button that spends money is a decision somebody has to make, not
   * a default they discover.
   */
  embed?: EmbedConfig;
  /**
   * The shareable Belline chat link: a public page, /c/<key>, that opens the
   * venue's chat full-screen, for an Instagram bio, a Google Business Profile
   * or a WhatsApp status. The channel for a business with no website. Created
   * by the owner; answers only once the venue is live. See chat-link.ts.
   */
  chatLink?: { key: string; createdAt: string; createdBy?: string };
  /** A WhatsApp number waiting for its code — see whatsapp-provision.ts. */
  whatsappPending?: WhatsAppPending;
  /**
   * A logo to show behind the call.
   *
   * The voice widget is the one place a venue's own customer sees Belline
   * rather than the venue, so it carries the venue's mark, not ours. Unset
   * falls back to the Belline bell — on our own line that is the right
   * answer, and on a venue with no logo to hand it is at least a bell rather
   * than an empty rectangle.
   */
  logoUrl?: string;
  /**
   * The logo the owner uploaded, as a record of it: the bytes live beside the
   * store in DATA_DIR/logos, never in this row — see logo-store.ts for why.
   * `id` is random per upload and is the public URL (/api/logo/<id>), so a
   * new logo is a new URL and the old one can be cached forever.
   */
  logo?: { id: string; mime: import("./logo").LogoMime; size: number; updatedAt: string };
  /**
   * Set when an owner archived this location. It keeps every booking, call
   * and version, and leaves every list, switcher and call route until
   * restored — see locations.ts.
   */
  archivedAt?: string;
  /**
   * How far the owner has got from signup to answering real calls.
   *
   * Facts, not a current-step pointer: journey.ts derives the step from these
   * and the venue's own data, so a step cannot say "done" about something that
   * was undone later. Absent only on venues that predate it, and seed.ts fills
   * it on boot — see `backfillOnboarding`.
   */
  onboarding?: OnboardingState;
}

/**
 * A Belline number on a venue, and how it got there.
 *
 *   pool    handed out by code from the number pool (telephony/pool.ts)
 *   staff   recorded by a person at Belline on the sales console
 *   legacy  the number a demo, internal or pre-journey venue already answered
 *           on when the phone fields were split (seed.ts `splitVenuePhones`)
 */
export interface BellineNumber {
  /** E.164. */
  number: string;
  via: "pool" | "staff" | "legacy";
  assignedAt: string;
  /** The staff user id, for `staff`. */
  by?: string;
}

export type DestinationKind ="requests" | "belline" | "google" | "outlook" | "partner";

export interface RequestRules {
  /** Details a request needs besides a name and a number. */
  askFor: ("partySize" | "service")[];
  /** Outside opening hours: take the request as usual, or only a message. */
  afterHours: "request" | "message";
  /** Things the agent must never say, in the owner's words. */
  neverSay: string[];
}

/**
 * A booking somebody asked for at a business that confirms bookings itself.
 * Nothing is reserved: the team reads this in the Inbox and gets back to them.
 */
export interface BookingRequest {
  id: string;
  /** The conversation and the requested slot, hashed, so asking twice records once. */
  key: string;
  at: string;
  guestName: string;
  guestPhone: string;
  /** What they want, as they put it: a service, "a table". */
  what?: string;
  partySize?: number;
  /** When they would like it, in their words: "Friday 8pm, or Saturday". */
  preferred: string;
  date?: string;
  startMin?: number;
  notes?: string;
}

/** One automatic check, as the owner sees it. */
export interface SelftestResult {
  scenario: string;
  title: string;
  passed: boolean;
  /** What the check said, as a customer would. */
  prompt?: string;
  /** Belline's exact reply, with any card number taken out. */
  reply?: string;
  /** The likely cause, in the owner's words. Failures only. */
  detail?: string;
  /** Where to fix it. */
  fix?: string;
}

export interface OnboardingState {
  version: 1;
  importedAt?: string;
  /** When the owner saved the review form. */
  reviewedAt?: string;
  /** The facts they confirmed on it. */
  reviewedFields?: string[];
  destination?: { kind: DestinationKind; partner?: string; bookingLink?: string; setAt: string };
  rulesConfirmedAt?: string;
  escalation?: { transferNumber?: string; notifyEmail?: string; notifyWhatsApp?: string };
  /** How Belline takes a booking request, set on the rules step. */
  requestRules?: RequestRules;
  /**
   * Systems the owner asked Belline to connect to ("fresha", "google"). A
   * request is recorded, never a connection: nothing here is built yet.
   */
  integrationRequests?: string[];
  channels: {
    web?: { domains: string[]; detectedAt?: string; lastCheckAt?: string };
    phone?: {
      numberAssignedAt?: string;
      forwardingVerifiedAt?: string;
      carrier?: "du" | "eand" | "virgin" | "landline" | "pbx";
      modes?: ("noanswer" | "busy" | "unreachable" | "all")[];
      /** The open "I've set it — test it" window, if any. See telephony/verify.ts. */
      verification?: { nonce: string; openedAt: string; expiresAt: string; callSid?: string };
      /** Windows that closed with no call arriving. Two opens a ticket. */
      failedWindows?: number;
    };
    whatsapp?: {
      status: "none" | "pending_code" | "pending_name" | "live" | "rejected";
      since: string;
      number?: string;
      /** Meta's id for the number, which the name-review check asks about. */
      phoneNumberId?: string;
      /** Meta's reason, in words, when the name or number was refused. */
      reason?: string;
      /** Refusals so far. The second opens a ticket. */
      rejections?: number;
      /** Our side is broken (Meta token expired); nothing for the owner to do. */
      blocked?: "token";
      checkedAt?: string;
    };
  };
  /** The last run of the automatic checks. See onboarding/selftest.ts. */
  tests?: {
    runId: string;
    at: string;
    /** configDigest() of the venue the checks ran against. A different digest now means stale. */
    digest?: string;
    results: SelftestResult[];
    passed: boolean;
  };
  /** Runs today, for the daily limit. `date` is the venue's local date. */
  selftestRuns?: { date: string; count: number };
  activatedAt?: string;
  /** A user id, or "backfill" for a venue that was live before the journey existed. */
  activatedBy?: string;
  pausedAt?: string;
  pauseReason?: string;
  /** Set when seed.ts wrote this record for a venue that predates it. */
  backfilledAt?: string;
}

/**
 * A venue's plan.
 *
 * Per venue, not per company: the pricing card says "one Belline
 * receptionist", and a second venue is a second line, a second diary and a
 * second set of rules. Anything else would need a rewrite the moment somebody
 * with two branches asked an obvious question.
 *
 * `startedOn` anchors every billing period that follows — see `periodFor` in
 * billing/usage.ts, which remembers the anchor day rather than clamping it.
 */
export interface Subscription {
  /**
   * What the venue pays for: one bundle, or a set of modules (see
   * `checkSelection` in billing/plans.ts). Read through `productsOf`, which
   * also understands the legacy field below.
   */
  products?: ProductId[];
  /**
   * The single plan a venue bought before the modular catalogue shipped.
   * Never written any more; kept so a grandfathered venue is read correctly.
   */
  planId?: LegacyPlanId;
  /** Which market's prices apply. Absent means the UAE, which is all there was. */
  market?: Market;
  /**
   * A venue on a legacy plan keeps it, exactly as sold, until this date — 90
   * days from the day the new catalogue shipped (addendum §3). Stamped once, on
   * boot, by billing/grandfather.ts.
   */
  grandfatheredUntil?: DateStr;
  cycle: BillingCycle;
  /** `YYYY-MM-DD`. The billing anniversary, for as long as the plan lasts. */
  startedOn: DateStr;
  status: "trialing" | "active" | "cancelled";
  /** Set when someone cancels. Service runs to the end of the paid period. */
  cancelledAt?: string;
  /**
   * The last time Stripe told us a charge failed. Cleared when one succeeds.
   *
   * Not a status of its own: the receptionist keeps answering while Stripe
   * retries for a fortnight, and switching a venue off over one declined card
   * would do more damage than the unpaid invoice. But the webhook used to
   * "note" this and store nothing, so the customer whose card had expired found
   * out when the retries ran out. Now the dashboard can say so.
   */
  paymentFailedAt?: string;
  /** Trialing only. Nothing is charged, and the allowance is its own. */
  trial?: {
    endsOn: DateStr;
    /**
     * Voice minutes, pooled across the phone and the voice button. A trial
     * without `conversations` began before catalogue 2026-10, and this is a
     * phone-only cap, kept as it was given.
     */
    minutes: number;
    /** Text conversations (catalogue 2026-10 onwards). */
    conversations?: number;
    /**
     * The original end date, when the trial reached it while card payments
     * were closed and was extended once (billing/trial-end.ts). Present means
     * the one extension has been used.
     */
    extendedFrom?: DateStr;
    extendedAt?: string;
  };
  /**
   * What one billing period was sold at, in the market's minor unit — the
   * monthly fee, or the annual one. Stamped by the webhook from the checkout.
   * When present, the invoice is this and never the catalogue's current
   * figure, so a customer's fee cannot move because a catalogue did.
   */
  priceMinor?: number;
  /** The catalogue version the subscription was bought under (billing/plans.ts `CATALOGUE_VERSION`). */
  catalogueVersion?: string;
  /**
   * What the owner chose to happen at 100% of an allowance (billing/usage-policy.ts).
   * Absent: nothing chosen yet, which behaves as `cap` and is never charged.
   */
  usagePolicy?: UsagePolicy;
  /**
   * Usage alerts this period, per pool, so each goes once. `sent` only once
   * the email actually went; `pending` while it has not (email off, or it
   * failed), retried by the billing sweep.
   */
  alerts?: {
    periodStart: DateStr;
    sent: Partial<Record<"minutes" | "conversations", UsageAlertThreshold[]>>;
    pending?: Partial<Record<"minutes" | "conversations", UsageAlertThreshold[]>>;
    /** When the oldest pending alert was raised. Absent when nothing is pending. */
    pendingSince?: string;
  };
  /** Packs added under a `packs` policy. Never written without one. */
  packs?: UsagePack[];
}

export type UsageAlertThreshold = 70 | 90 | 100;

export interface UsagePolicy {
  /**
   * `packs` — add a pack automatically at 100%, up to `monthlyCapMinor`.
   * `upgrade` — recommend the next plan; behaves as `cap` until the owner confirms.
   * `cap` — stop answering on that unit's channels at 100% until the next period.
   */
  mode: "packs" | "upgrade" | "cap";
  /** Packs mode: the most packs may add in one period, minor units. Absent: no cap. */
  monthlyCapMinor?: number;
  chosenAt?: string;
  /** The user id of the owner who chose it. */
  chosenBy?: string;
}

export interface UsagePack {
  periodStart: DateStr;
  pool: "minutes" | "conversations";
  units: number;
  priceMinor: number;
  /** `${locationId}:${periodStart}:${pool}:${n}` — also the Stripe idempotency key. */
  key: string;
  at: string;
  /** Set once Stripe has the invoice item. */
  invoiceItemId?: string;
  /**
   * Added while card payments were switched off. The units count; the pack is
   * never charged, and the owner is told so.
   */
  pending?: true;
}

/**
 * A demo built from a prospect's public website.
 *
 * Everything in a venue carrying this was read off a web page by a model. It
 * is unverified by definition, it impersonates a real business by design, and
 * so it expires — a personalised demo that outlives the conversation it was
 * built for is just a page on the internet pretending to be somebody.
 */
export interface ProspectConfig {
  /** The public URL segment: /demo/<slug>. */
  slug: string;
  /** The website it was read from, shown on the demo so the source is plain. */
  sourceUrl: string;
  createdAt: string;
  /** After this, the page is gone. Not hidden — gone. */
  expiresAt: string;
}

/**
 * A demo line is a number strangers can dial, and every minute of it spends
 * real money with three vendors. So it is capped, disclosed, and self-cleaning
 * — none of which a private test number needs.
 */
export interface DemoConfig {
  enabled: boolean;
  /** Hard stop on spend. Calls beyond this hear a polite message and end. */
  maxCallsPerDay: number;
  /** Shorter than a real call: a demo makes its point in three minutes. */
  maxCallSeconds: number;
  /** Delete bookings this demo took before today, so the diary stays legible. */
  clearBookingsDaily: boolean;
  /** Appended to the greeting so nobody thinks they booked a real table. */
  disclosure: string;
}

/**
 * Belline on the venue's own website.
 *
 * A public widget spends real money on every tap, so the shape here is mostly
 * brakes: the key is public by design, the origin allowlist is what actually
 * controls who can open it, and the two caps are the backstop for an
 * allowlisted page being refreshed by somebody bored on a slow afternoon.
 */
/**
 * How the widget looks and what its buttons say — the venue's choices,
 * within the guidelines.
 *
 * What may change: the words on the buttons, the colour of the filled one,
 * pill or circle, which corner, whether it rings, and whether the main button
 * shows the bell or the venue's own uploaded logo. What may not: any other
 * mark. No drawing comes from the settings — the only picture the button can
 * carry instead of the bell is a logo Belline itself checked and serves.
 */
export interface EmbedAppearance {
  voiceLabel?: string;
  chatLabel?: string;
  whatsappLabel?: string;
  /** A name from the palette, or a hex the contrast rule allows. */
  accent?: string;
  shape?: "pill" | "round";
  corner?: "right" | "left";
  /** Show the WhatsApp button when the venue has a number. Default on. */
  whatsapp?: boolean;
  /**
   * What the main button shows: Belline's bell (the default) or the venue's
   * own uploaded logo. "logo" with no logo uploaded draws the bell — see
   * resolveAppearance.
   */
  buttonMark?: "bell" | "logo";
  /** Ring the main button now and then to draw the eye, as belline.ai's does. Default off. */
  ring?: boolean;
}

/**
 * A WhatsApp number half-way to being Belle's.
 *
 * Self-serve provisioning is two steps a minute apart — Meta texts a code to
 * the SIM, the owner types it — and this is what survives between them. It is
 * cleared the moment the number is registered or the owner gives up.
 */
export interface WhatsAppPending {
  number: string;
  phoneNumberId: string;
  displayName: string;
  startedAt: string;
}

export interface EmbedConfig {
  /** Public. It sits in the customer's page source; see embed.ts. */
  key: string;
  appearance?: EmbedAppearance;
  enabled: boolean;
  /** Origins allowed to frame it, scheme and host only. Empty allows nothing. */
  allowedOrigins: string[];
  maxCallsPerDay: number;
  maxCallSeconds: number;
  /**
   * What the widget offers a visitor: the bell, the chat, or both.
   *
   * The venue's choice, not the page's. `embed.js` takes a `data-mode`
   * attribute so a business can put the bell on one page and the chat on
   * another, but the attribute cannot turn on something this field has off —
   * otherwise the entitlement would live in the customer's HTML, where anybody
   * could edit it.
   *
   * Unset means `voice`, which is what every venue that switched the widget on
   * before chat existed actually asked for. Adding a chat bubble to somebody's
   * live website because we shipped a feature would be a change they did not
   * make.
   */
  mode?: EmbedMode;
  /** Web chat conversations a day. Its own ceiling; see the note on Call.channel. */
  maxChatsPerDay?: number;
  /**
   * Messages one visitor may send in one conversation.
   *
   * The cap that matters on a public widget. A bored visitor with a keyboard is
   * cheaper than a bot but not free, and a conversation that has run past this
   * is one a person should be reading anyway.
   */
  maxMessagesPerChat?: number;
}

export type EmbedMode = "voice" | "chat" | "both";

export interface AgentConfig {
  /** The name the agent introduces itself with. */
  displayName: string;
  greeting: string;
  /**
   * Spoken instead of `greeting` when the caller's number matches a past
   * guest. `{name}` is replaced with the name they booked under. Left blank,
   * returning guests get the standard greeting.
   */
  returningGreeting?: string;
  /** ElevenLabs voice id. */
  voiceId: string;
  /**
   * ElevenLabs model id — the latency/warmth trade. Unset falls back to
   * `DEFAULT_VOICE_MODEL`; see `VOICE_MODELS` for what is worth offering.
   */
  voiceModel?: string;
  /** Delivery pace, 0.8–1.2. Unset falls back to `DEFAULT_VOICE_SPEED`. */
  voiceSpeed?: number;
  model: string;
  /** Free-text tone/personality guidance folded into the system prompt. */
  persona: string;
  /** Hard rules the agent must not break (deposit policy, cut-off times...). */
  policies: string[];
  faqs: Faq[];
  /** Number to warm-transfer to when the agent escalates. */
  transferNumber?: string;
  maxCallSeconds: number;
  /** How far ahead the agent is allowed to book. */
  bookingHorizonDays: number;
}

export interface Faq {
  q: string;
  a: string;
}

// ---------------------------------------------------------------------------
// Restaurant
// ---------------------------------------------------------------------------

export interface Table {
  id: string;
  name: string;
  minSeats: number;
  maxSeats: number;
  section: string;
  /**
   * Tables this one can physically be pushed against.
   *
   * Absent means "anything else in the same section", which is what the engine
   * assumed before a floor plan could say otherwise. It is wrong often enough
   * to matter — a banquette does not join the window two-top, and a host who
   * arrives to find the agent has promised it stops trusting the agent.
   */
  combinesWith?: string[];
  /**
   * May be given away without a person in the loop.
   *
   * Off for the tables a venue sells rather than seats: the chef's counter,
   * the private room, table one by the window. They exist in the diary and a
   * manager can put anybody there; the agent may not.
   */
  online?: boolean;
  /** Preference between tables that fit equally well. Higher goes first. */
  priority?: number;
  /**
   * Where the table sits on the floor plan, in plan units (the plan is 1000
   * wide). Absent tables are laid out in a grid by section until somebody
   * arranges the room — see floor.ts.
   */
  layout?: { x: number; y: number; shape?: "round" | "square" };
}

/**
 * A named part of the room.
 *
 * Sections already existed as a string on each table, which was enough to stop
 * the engine pushing the terrace into the dining room and nothing else. A real
 * floor is run section by section: the terrace closes when it rains, the bar
 * paces differently from the dining room because the kitchen barely touches
 * it, and the private room is not something a caller may simply take.
 *
 * Absent entirely, every section behaves the way it did before this existed.
 */
export interface Section {
  /** Matches the `section` string on the tables in it. */
  id: string;
  name?: string;
  /** Covers this section may seat per slot, under the house cap. */
  maxCoversPerSlot?: number;
  /** Whether tables here may be combined at all. Default true. */
  combinable?: boolean;
  /** Whether the agent may seat here unasked. Default true. */
  online?: boolean;
  /** Order sections are tried in. Higher first — fill the bar before the terrace. */
  priority?: number;
  /** Dates this section is not in use: weather, a private hire, a refit. */
  closedOn?: DateStr[];
}

/**
 * A table out of play for part of a day.
 *
 * Not a booking and not a closure: a wobbly leg, a supplier delivery across
 * the terrace, four tables held back for a party that has not confirmed. Every
 * real reservation book has this, and a venue that cannot express it ends up
 * entering fake bookings named "DO NOT BOOK" — which then count as covers.
 */
export interface TableBlock {
  id: string;
  date: DateStr;
  tableIds: string[];
  startMin: Minutes;
  endMin: Minutes;
  reason: string;
}

export interface ServiceWindow {
  id: string;
  name: string;
  /** Weekdays this service runs, 0 = Sunday. */
  days: number[];
  start: Minutes;
  end: Minutes;
  /** Latest time a party may be seated in this service. */
  lastSeating: Minutes;
  /** Turn time by party size: first entry whose `upTo` >= party size wins. */
  turnTimes: { upTo: number; minutes: number }[];
  /**
   * Pacing for this service alone, overriding the house cap.
   *
   * Saturday brunch and a Tuesday lunch put very different pressure on the
   * same kitchen, and one number for both is a number that is wrong twice.
   */
  maxCoversPerSlot?: number;
  /** Notice this service needs, in minutes. A tasting menu is not a walk-in. */
  minNoticeMin?: number;
  /** Covers held back for walk-ins and never offered on the phone. */
  walkInHoldback?: number;
}

export interface RestaurantConfig {
  tables: Table[];
  services: ServiceWindow[];
  /**
   * Pacing. Kitchens fall over when twelve tables are seated at 20:00 even if
   * twelve tables are physically free, so we cap covers seated per slot.
   */
  maxCoversPerSlot: number;
  slotMinutes: number;
  maxPartySize: number;
  /** What the agent should say when a party exceeds `maxPartySize`. */
  largePartyPolicy: string;
  /**
   * Covers a manager may seat beyond the pacing cap, by hand.
   *
   * Never available to the agent — pacing exists so the pass survives eight
   * o'clock, and a caller is the last person who should be able to override
   * it. But a manager who knows two tables are about to leave, or that the
   * kitchen has a spare pair of hands tonight, is making a judgement the
   * software cannot. Zero means the cap is absolute.
   */
  overbookPerSlot?: number;
  /** The room, section by section. Absent leaves every section unrestricted. */
  sections?: Section[];
  /**
   * Minutes a table is held after a party is due to leave.
   *
   * The single most common way a booking system embarrasses a venue: the turn
   * ends at 21:30, the next party is promised 21:30, and nobody has cleared,
   * reset or re-laid the table. Every real system holds a few minutes back.
   * Zero or absent keeps the old behaviour — back-to-back to the minute.
   */
  resetMinutes?: number;
  /** Most tables that may be pushed together. Default 2. */
  maxCombine?: number;
  /** Tables out of play for part of a day. */
  blocks?: TableBlock[];
}

// ---------------------------------------------------------------------------
// Salon / clinic
// ---------------------------------------------------------------------------

/**
 * One stretch of a service, from the diary's point of view.
 *
 * This is the feature that separates a salon system from a calendar, and the
 * reason a colourist can take three clients in the time a generic scheduler
 * gives them two. A full head of highlights is not 180 solid minutes of a
 * stylist: it is 45 minutes applying, 40 minutes of the colour developing with
 * the client sitting under a lamp reading a magazine, then 60 minutes washing,
 * cutting and finishing. During the middle stretch the *chair* is occupied and
 * the *stylist is not* — and that gap is where the day's third client goes.
 *
 * Fresha calls it processing time, Boulevard calls it gap time, and a clinic
 * has the same shape whenever something has to take effect before the
 * practitioner comes back. Modelled once, here.
 */
export interface ServicePhase {
  /** For the diary: "Apply", "Develop", "Finish". */
  name: string;
  durationMin: number;
  /**
   * True where the guest is occupied but the person doing the work is free.
   * The room, chair or machine stays held either way — the client is sitting
   * in it.
   */
  staffFree?: boolean;
}

/**
 * A second person needed for part of an appointment.
 *
 * Dental scheduling turns on this: a hygiene visit is an hour of the
 * hygienist's time containing ten minutes of the dentist's, for the exam. A
 * practice that cannot express it either blocks a whole hour of dentist time
 * per cleaning — which is why their dentist looks fully booked while sitting
 * idle — or schedules the exam by shouting down the corridor. Salons have the
 * same shape for a double-up blow-dry on a bridal party.
 */
export interface SecondaryStaffNeed {
  /** The role the second person must hold, matched against `StaffMember.role`. */
  role: string;
  /** Minutes into the appointment when they are needed. */
  atMin: number;
  durationMin: number;
}

export interface SalonService {
  id: string;
  name: string;
  durationMin: number;
  /** Cleanup/reset time held after the appointment but not shown to guests. */
  bufferMin: number;
  price: number;
  /** Optional shared equipment this service needs (colour room, basin...). */
  resourceType?: string;
  /**
   * Everything this service needs at once.
   *
   * `resourceType` handles the common case of one thing; a treatment that ties
   * up both a room and a machine needs both held, and the old single field
   * silently checked whichever one happened to come first in the chain.
   */
  /**
   * What it is, in the owner's words, one line: "Two-hour site visit with an
   * architect". A service called "Consultation" means nothing to a caller who
   * asks what they would get, and the agent may only say what it was told.
   */
  description?: string;
  resourceTypes?: string[];
  /**
   * The shape of the appointment, when it is not one solid block.
   *
   * Durations must add up to `durationMin`; `serviceShape` in booking/services.ts
   * is the only thing that should read this, and it falls back to a single
   * busy phase when the field is absent.
   */
  phases?: ServicePhase[];
  /** A second person needed partway through — see `SecondaryStaffNeed`. */
  secondary?: SecondaryStaffNeed;
  /**
   * How long this takes the first time.
   *
   * A new patient exam is not a returning patient exam, and a first colour
   * starts with a consultation and a skin test. Absent means the same either
   * way, which is true of a haircut and of almost nothing in a clinic.
   */
  newGuestDurationMin?: number;
  /** Only bookable alongside something else: a treatment add-on, not a visit. */
  addOnOnly?: boolean;
  /** Role required to perform it, where a qualification list is not enough. */
  role?: string;
  /** May the agent book it at all? Off for anything needing a consultation first. */
  online?: boolean;
  /**
   * Days until this brings the guest back.
   *
   * A cleaning is six months, a root touch-up is six weeks, a filling is
   * nothing. This single number is the whole of dental recall and the whole of
   * a salon's rebooking list — see booking/recall.ts, which turns it into the
   * outbound call the venue is actually paying for.
   */
  recallDays?: number;
}

export interface StaffMember {
  id: string;
  name: string;
  /** Services this person is qualified to perform. */
  serviceIds: string[];
  hours: WeeklyHours;
  timeOff: { date: DateStr; start: Minutes; end: Minutes }[];
  /** "dentist", "hygienist", "senior stylist" — matched by `SecondaryStaffNeed`. */
  role?: string;
  /** Lunch and the rest of it, weekly. Subtracted from the shift like time off. */
  breaks?: WeeklyHours;
  /**
   * A rota, which beats the weekly pattern on the dates it covers.
   *
   * Weekly hours describe a stable week and almost nobody works one. An empty
   * `ranges` is a day off, and is not the same as having no entry — that
   * distinction is the difference between "not scheduled" and "unknown".
   */
  shifts?: { date: DateStr; ranges: TimeRange[] }[];
  /** This person's own timing, by service id. A senior colourist is quicker. */
  durationOverrides?: Record<string, number>;
  /** This person's own prices, by service id. Level-based pricing, as sold. */
  priceOverrides?: Record<string, number>;
  /** Never offered by the engine; bookable only when a guest asks by name. */
  requestOnly?: boolean;
}

export interface Resource {
  id: string;
  name: string;
  type: string;
  /** How many appointments it can hold at once. Default 1. */
  capacity?: number;
  /** Out of service: a machine being serviced, a surgery being deep-cleaned. */
  outOfService?: { date: DateStr; start: Minutes; end: Minutes }[];
}

export interface SalonConfig {
  services: SalonService[];
  staff: StaffMember[];
  resources: Resource[];
  slotMinutes: number;
  /**
   * How the engine fills the diary when the guest has not asked for anybody.
   *
   * `spread` gives the next appointment to whoever is least busy, which is
   * fair, keeps a team happy, and is what this engine did before there was a
   * choice. `pack` gives it to whoever it leaves the fewest dead minutes with
   * — the whole team's day closes up, one person may go home early, and the
   * salon sells more hours. Fresha's automatic assignment is the second; a
   * commission-based team will want the first. It is the owner's call, not
   * ours. Default `spread`.
   */
  assignment?: "spread" | "pack";
  /**
   * May a second guest be booked into the gap in someone's appointment?
   *
   * The pay-off of `ServicePhase`, and off by default on purpose: a salon that
   * has never done it will see a stylist double-booked and panic. Turn it on
   * once the owner understands what it is doing.
   */
  dovetail?: boolean;
}

// ---------------------------------------------------------------------------
// House rules
// ---------------------------------------------------------------------------

/**
 * When a booking may be taken, and on what terms.
 *
 * Separate from availability on purpose. "Is a chair free at nine tomorrow" is
 * a question about the room; "will we take a booking for nine tomorrow from
 * someone ringing at half past eight tonight" is a question about the
 * business, and conflating the two is why an agent books a two-hour treatment
 * for twenty minutes' time and the practice finds out when the patient
 * arrives.
 *
 * Every field is optional and every absent field means "no rule", so a venue
 * that has said nothing gets exactly the behaviour it had before.
 */
export interface BookingPolicy {
  /**
   * Notice required, in minutes, between now and the start of the booking.
   *
   * A restaurant may want twenty minutes so the host can see it coming. A
   * clinic wants a day, because the chart has to be pulled and the surgery
   * prepared. This is enforced against the venue's own clock, not the server's.
   */
  minNoticeMin?: number;
  /** Furthest ahead a booking may be taken, in days. Beyond it, the agent says so. */
  maxHorizonDays?: number;
  /**
   * After this time of day, nothing more is taken for today.
   *
   * Distinct from notice: a kitchen that stops taking same-day bookings at
   * 4pm is not saying "four hours' notice", it is saying the ordering is done.
   */
  sameDayCutoffMin?: Minutes;
  /**
   * Hours before the start inside which cancelling is late.
   *
   * Belline never charges anybody. What this does is let the agent *say* the
   * policy at the moment it applies, and mark the booking so the venue can
   * decide — which is the honest version of a cancellation fee and the only
   * version a phone agent should be trusted with.
   */
  cancellationWindowHours?: number;
  /** What the venue charges for a late cancellation, in its own currency. */
  lateCancelFee?: number;
  /** What the venue charges for a no-show. */
  noShowFee?: number;
  /** When a card or a deposit is wanted before the booking stands. */
  deposit?: DepositRule;
  /**
   * Guests with this many no-shows are not given a booking by the agent alone.
   *
   * The agent takes the request and hands it to a person rather than refusing
   * it — an automated system telling somebody they are barred is a review the
   * venue will be reading for years. Zero or absent disables the rule.
   */
  noShowsBeforeReview?: number;
  /** Bookings the agent may hold at one time for one number. Stops a jammed line. */
  maxOpenPerGuest?: number;
}

/**
 * When money is asked for up front.
 *
 * Deliberately a description rather than a charge. Belline works out that a
 * deposit *applies*, says so on the call, and writes it on the booking; taking
 * the money is the venue's payment provider's job and putting a card number
 * through a voice agent is not something this product will ever do.
 */
export interface DepositRule {
  amount: number;
  /** A flat sum for the booking, or a sum per head. */
  per: "booking" | "person";
  /** Only for parties at least this large. */
  minPartySize?: number;
  /** Only when the services booked come to at least this much. */
  minValue?: number;
  /** Only for a caller with no completed visit here. */
  newGuestsOnly?: boolean;
  /** Only on these weekdays, 0 = Sunday. Absent means every day. */
  weekdays?: number[];
  /** What the agent says about it, in the venue's own words. */
  wording?: string;
}

// ---------------------------------------------------------------------------
// Waitlist
// ---------------------------------------------------------------------------

export type WaitStatus = "waiting" | "offered" | "converted" | "expired" | "cancelled";

/**
 * Somebody who wanted a time that was gone.
 *
 * A full Friday is not a lost caller, it is a caller nobody wrote down. The
 * difference between a restaurant that keeps a waitlist and one that does not
 * is entirely in what happens when a table frees at five o'clock — and the
 * thing Belline can do that a booking system cannot is ring them back itself.
 */
export interface WaitlistEntry {
  id: string;
  locationId: string;
  guestName: string;
  guestPhone: string;
  date: DateStr;
  /** The window they would accept, not a single time. */
  earliestMin: Minutes;
  latestMin: Minutes;
  partySize?: number;
  serviceIds?: string[];
  /** Named a particular person, and will not take anyone else. */
  staffId?: string;
  status: WaitStatus;
  notes: string;
  /** The call this came from, so the conversation is one click away. */
  callId?: string;
  createdAt: string;
  updatedAt: string;
  /** When a slot was found and they were told about it. */
  offeredAt?: string;
  /** The booking this turned into. */
  bookingId?: string;
}

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------

export type BookingStatus =
  | "confirmed"
  | "cancelled"
  | "completed"
  | "no_show";

export interface Booking {
  id: string;
  /** Short human-readable code the agent reads out loud, e.g. "R7K2". */
  ref: string;
  locationId: string;
  vertical: Vertical;
  status: BookingStatus;
  date: DateStr;
  startMin: Minutes;
  endMin: Minutes;
  guestName: string;
  guestPhone: string;
  /**
   * Only where the venue needs one — see `Location.requiresEmail`.
   *
   * A restaurant booking a table has no use for an email and should not be
   * asking a caller to spell one out loud. A venue whose whole booking *is* an
   * email (a video call, a link to send) cannot do without it.
   */
  guestEmail?: string;
  notes: string;
  // Restaurant
  partySize?: number;
  tableIds?: string[];
  // Salon
  serviceIds?: string[];
  staffId?: string;
  resourceId?: string;
  /**
   * Every resource this booking holds.
   *
   * `resourceId` stays for the single-resource case that every existing
   * booking has, and is the first of these. A treatment needing a room *and* a
   * laser holds two, and checking only one of them is how two clients end up
   * in front of the same machine.
   */
  resourceIds?: string[];
  /** The second person, where the service needs one — the dentist on a hygiene visit. */
  secondaryStaffId?: string;
  /**
   * Front-of-house progress, which is not the same question as whether the
   * booking is on. A seated party and a booked party both hold their table;
   * only one of them can be chased for running twenty minutes late.
   */
  service?: { arrivedAt?: string; seatedAt?: string; leftAt?: string };
  /** Worked out at booking time from the venue's `DepositRule`. Never charged here. */
  deposit?: {
    amount: number;
    currency: string;
    status: "required" | "paid" | "waived";
    /** The Stripe payment page, once card payments are on. See billing/deposits.ts. */
    link?: string;
    checkoutId?: string;
    requestedAt?: string;
    paidAt?: string;
    linkExpiredAt?: string;
  };
  /** The text the day before. Set before sending, so it can never go twice. */
  reminder?: { sentAt?: string; failedAt?: string; reason?: string };
  /** Set when it was cancelled inside the venue's own cancellation window. */
  lateCancel?: boolean;
  cancelledAt?: string;
  cancelReason?: string;
  /**
   * The calendar event this booking is, and the calendar it is in. For Google
   * the id is derived from the idempotency key, so a second create finds the
   * first. For Outlook it is the id Microsoft assigned.
   */
  calendarEventId?: string;
  calendarId?: string;
  /**
   * Outlook only: the key written on the event (integrations/calendar-connector.ts),
   * by which it is found again whatever id Microsoft gave it. Google's key is its id.
   */
  calendarEventKey?: string;
  /**
   * Where the venue's connected calendar stands with this booking.
   * Absent when the venue has no connection. See integrations/calendar-sync.ts.
   */
  calendarSync?: CalendarSync;
  /**
   * When this guest is due back, and for what.
   *
   * Written at booking time from the service's `recallDays` so that the recall
   * list is a query rather than a nightly job that can fail silently. See
   * booking/recall.ts.
   */
  recallDueOn?: DateStr;
  recallServiceId?: string;
  /** The recall this booking answered, so a due list can close itself out. */
  recallOf?: string;
  /**
   * When somebody last reached out about this recall, and until when it should
   * stay off the list.
   *
   * The only part of a recall that is not derived. Everything else — who is
   * due, how overdue, what it is worth, whether they have rebooked — falls out
   * of the bookings themselves, which is why there is no recall table to fall
   * out of sync. But "we rang them and they said ring back in March" is a fact
   * about the outreach, not about the visit, and it has to be written down
   * somewhere or the same patient is rung every week until they stop answering.
   *
   * Held on the visit that raised the recall, because that is what the item is
   * derived from.
   */
  recallContactedAt?: string;
  recallSnoozedUntil?: DateStr;
  source: "voice" | "manual" | "web" | "whatsapp";
  callId?: string;
  /**
   * Fingerprint of what this booking *is* — venue, day, time, guest, party or
   * services. A second request carrying the same fingerprint is the same
   * booking arriving twice, whatever the transport did, and returns this one
   * instead of holding a second table. See `booking/idempotency.ts`.
   */
  idempotencyKey?: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export type CallOutcome =
  | "booking_created"
  | "booking_changed"
  | "booking_cancelled"
  | "answered_question"
  | "message_taken"
  | "transferred"
  /**
   * Sent somewhere else entirely — emergency care, most importantly. Distinct
   * from "transferred" on purpose: nobody at the venue picked this call up,
   * and counting it as a handled transfer would overstate what happened.
   */
  | "escalated"
  | "abandoned";

export interface TranscriptTurn {
  role: "caller" | "agent" | "system";
  text: string;
  at: string;
  /** For agent turns: ms from end of caller speech to first audio out. */
  latencyMs?: number;
}

export interface ToolTrace {
  at: string;
  name: string;
  input: unknown;
  output: unknown;
  ms: number;
  ok: boolean;
}

export interface Call {
  id: string;
  locationId: string;
  /**
   * Which way Belline dealt with this person.
   *
   * A "call" here means an episode, not a telephone line — a WhatsApp
   * conversation produces one too. The dashboard's whole premise is "what did
   * Belline do for me this week", and that question must not have two answers
   * depending on which channel somebody happened to use.
   *
   * `browser` is the bell on a venue's own site — a spoken conversation.
   * `webchat` is the same site, typed. Separate values because they consume
   * different things and have separate daily ceilings: one costs speech
   * synthesis by the second, the other costs tokens by the message, and a busy
   * afternoon on one must not switch the other off.
   *
   * `embed` is the bell on a customer's own website — a stranger, spending
   * under that venue's widget ceilings. `browser` is the venue's own test
   * console and our own demo pages. They were one value for a day, and in that
   * day a member of staff testing their agent forty times switched their
   * website widget off, and the widget screen reported the staff's calls as
   * visitors'. Different budgets, different values.
   *
   * Only `phone` is billable; see billing/usage.ts, which checks this.
   */
  channel: "browser" | "embed" | "phone" | "whatsapp" | "webchat";
  from: string;
  startedAt: string;
  endedAt?: string;
  status: "active" | "completed" | "failed";
  outcome: CallOutcome | null;
  transcript: TranscriptTurn[];
  toolCalls: ToolTrace[];
  /** Per-turn response latency, first-audio-out minus end-of-speech. */
  latenciesMs: number[];
  bookingId?: string;
  summary?: string;
  /** Kept out of the venue's real analytics. */
  isDemo?: boolean;
  /** Set when the caller asked for something the agent could not do. */
  escalation?: string;
  /**
   * The authority rule that decided this call, when one did.
   *
   * "Why did it say that?" is the question asked afterwards, and on the calls
   * where it matters most the answer is a named, versioned rule rather than a
   * sentence in a prompt — which is the difference between a control you can
   * show someone and a claim you can only make.
   */
  authorityRuleId?: string;
  /** A live transfer attempted on this call, and whether Twilio took it. */
  transfer?: { to: string; at: string; ok: boolean; detail?: string };
  /**
   * The Business Brain version that handled this call.
   *
   * "Which configuration said that?" is unanswerable once a venue has edited
   * its policies twice, unless it was written down at the time. Recorded here
   * so a complaint about a call from three weeks ago can be read against the
   * rules that were actually live when it happened.
   */
  brainVersion?: number;
  /**
   * When somebody dealt with what this call needed.
   *
   * Only ever set by a person clearing it from the Action Inbox — an item is
   * derived from the call's own properties, so nothing else can decide it no
   * longer needs attention.
   */
  attentionResolvedAt?: string;
  attentionResolvedBy?: string;
  /** Booking requests taken in this conversation, at a request-only business. */
  bookingRequests?: BookingRequest[];
  /**
   * The forwarding test call the owner made during a verification window.
   * Answered with a short script, never billed and kept out of every count.
   */
  isTest?: boolean;
  /** Twilio's id for a phone call, so a retried webhook cannot record it twice. */
  callSid?: string;
  /**
   * A voicemail the caller chose to leave on a venue that had not gone live.
   *
   * No agent, no stream and no speech-to-text: Twilio played a greeting and
   * recorded the message. Only Twilio's handles are kept — the recording
   * itself stays with Twilio and is played to the owner through
   * /api/voicemail/<callId> — and nothing transcribes it. Never billed as
   * minutes (billing/usage.ts). See telephony/voicemail.ts.
   */
  voicemail?: {
    /** Twilio's RecordingSid. One recording is one inbox item, however often Twilio calls back. */
    recordingSid: string;
    /** Twilio's RecordingUrl, fetched with our Twilio credentials, never linked to directly. */
    recordingUrl: string;
    durationSeconds: number;
    /** Left before the owner pressed Go live. The only case voicemail is offered in. */
    beforeLive: true;
  };
}

/** A pre-bought Belline number waiting in, or taken from, the pool. See telephony/pool.ts. */
export interface PoolNumber {
  /** E.164. */
  number: string;
  status: "free" | "assigned" | "quarantine";
  locationId?: string;
  addedAt: string;
  assignedAt?: string;
  /** When it was given back. It stays out of the pool for 30 days after. */
  releasedAt?: string;
  /** "pool" when code assigned it, or the staff user who did it by hand. */
  assignedBy?: string;
}

// ---------------------------------------------------------------------------
// People who can open the dashboard
// ---------------------------------------------------------------------------

/**
 * `owner` runs the business: every venue, plus user management.
 * `manager` runs one or more venues: can change how the agent behaves there.
 * `staff` works the floor: can read the book and the calls, nothing else.
 */
export type Role = "owner" | "manager" | "staff";

export interface User {
  id: string;
  /**
   * The one tenant this person belongs to.
   *
   * Checked before `locationIds` and before any route-level rule: a venue id
   * from another tenant is refused even if it somehow appears in this user's
   * list. The list narrows access within a tenant; it cannot widen it across
   * one.
   */
  tenantId: string;
  email: string;
  name: string;
  role: Role;
  /** Empty means every venue in the tenant — only meaningful for an owner. */
  locationIds: string[];
  /** scrypt digest; never leaves the server. */
  passwordHash: string;
  createdAt: string;
  lastSeenAt?: string;
  disabled?: boolean;
  /**
   * The one sign-in link currently outstanding for this person, by nonce.
   * Cleared when used, so a link works once; replaced when a new one is sent,
   * so only the latest works. See `signLoginToken` in auth.ts.
   */
  loginNonce?: string;
  /**
   * The one password-reset link outstanding, by nonce. Kept apart from
   * `loginNonce` so asking for a reset does not cancel a sign-in link Belle
   * sent, and cleared on use. See `signResetToken` in auth.ts.
   */
  resetNonce?: string;
}

/** An event in a calendar, by calendar and key (for Google the key is the id). */
export interface CalendarEventRef {
  calendarId: string;
  eventId: string;
}

/**
 * A booking's standing with the venue's Google Calendar.
 *
 * Written before Google is asked and updated after, so a failure, a restart or
 * a second change arriving mid-write always leaves enough on the booking for
 * the sweep to finish the job. See integrations/google-sync.ts.
 */
export interface CalendarSync {
  /** `pending`: a change not yet in Google. `failed`: Google refused it; retried. */
  state: "pending" | "synced" | "failed";
  /** Consecutive failures. Back to 0 once Google has it. */
  attempts: number;
  /** Bumped by every change, so a run that started before one cannot mark it done. */
  rev?: number;
  lastTriedAt?: string;
  nextAttemptAt?: string;
  syncedAt?: string;
  /** Ours, for the log and the dashboard. Never Google's text. */
  lastError?: string;
  /** Events this booking left behind on another calendar, still to be removed. */
  stale?: CalendarEventRef[];
  /** A write that was started and not confirmed: it may exist in the calendar. */
  inflight?: CalendarEventRef;
  /** Which calendar service the event fields belong to. Absent: Google. */
  provider?: "outlook";
}

/** Why a person at Belline has to step in. See exceptions.ts. */
export type ExceptionKind =
  | "pool_empty"
  | "number_assign_failed"
  | "forwarding_unverified_2x"
  | "whatsapp_rejected"
  | "whatsapp_token_expired"
  | "import_failed_3x"
  | "payment_failed_final"
  | "stripe_off_trial_end"
  | "trial_cap_reached"
  | "packs_held_payments_off"
  | "whatsapp_assisted_setup"
  | "deletion_legal_hold"
  | "owner_requested_human"
  | "vendor_balance_low"
  | "webhook_failures"
  | "billing_dispute"
  | "account_recovery"
  | "handoff_requested"
  | "google_sync_failed"
  | "google_token_expired"
  | "google_misconfigured"
  | "google_connect_abandoned"
  | "outlook_sync_failed"
  | "outlook_token_expired"
  | "outlook_misconfigured"
  | "outlook_connect_abandoned"
  | "outlook_admin_approval";

export interface SupportException {
  id: string;
  /** Short and readable, said to the owner: "B-7K2Q". */
  ticket: string;
  tenantId: string;
  locationId?: string;
  kind: ExceptionKind;
  reason: string;
  context: Record<string, unknown>;
  source: "belle" | "system" | "owner";
  status: "open" | "waiting_customer" | "resolved";
  /** How many times the same thing was raised while this was open. */
  count: number;
  openedAt: string;
  lastRaisedAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resolution?: string;
  /** Minutes a person spent on it: the human-touch metric. */
  humanMinutes?: number;
}

export interface Session {
  /** The opaque value held in the cookie. */
  id: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  userAgent?: string;
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

export interface Slot {
  date: DateStr;
  startMin: Minutes;
  endMin: Minutes;
  /** Restaurant: tables that would be used. Salon: the staff member. */
  tableIds?: string[];
  staffId?: string;
  staffName?: string;
  resourceId?: string;
  resourceIds?: string[];
  /** What it would cost at this time, with this person. Level pricing moves it. */
  price?: number;
  /** Restaurant: the part of the room this would be. */
  section?: string;
  /**
   * Why the engine put this slot in front of the others, 0–1.
   *
   * Not shown to a guest and not a probability. It exists so the agent can
   * offer three times in an order that is good for the venue as well as
   * convenient for the caller — see `rankSlots` in booking/ranking.ts.
   */
  score?: number;
}

export interface AvailabilityQuery {
  locationId: string;
  date: DateStr;
  /** Preferred time; results are ranked by distance from it. */
  preferredMin?: Minutes;
  partySize?: number;
  serviceIds?: string[];
  staffId?: string;
  /** Minutes either side of `preferredMin` to search. */
  windowMin?: number;
  /** Ignore this booking when checking conflicts (used when modifying). */
  excludeBookingId?: string;
  /**
   * Who is asking.
   *
   * Optional, and the engine works without it — but a first visit can be a
   * longer appointment and a returning guest can be offered the person they
   * always see, and neither is possible from a date and a party size alone.
   */
  guestPhone?: string;
  newGuest?: boolean;
  /**
   * A manager working the book rather than a caller on the line.
   *
   * Lifts the rules that exist to stop the *agent* doing something — a
   * request-only stylist, a section that is not sold online, a pacing cap —
   * and none of the rules that exist to stop anyone double-booking a room.
   */
  staffOverride?: boolean;
}

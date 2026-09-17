/**
 * What Belline costs.
 *
 * One catalogue, read by the billing engine, the checkout, Stripe, the
 * website and Belle, and checked against all of them by
 * `scripts/check-billing.ts` and `scripts/check-plans.ts`. Four rules hold it
 * together:
 *
 *   Money is integer minor units — fils, pence, cents — never a float. An
 *   invoice that reads "AED 246.60000000000002" destroys more trust than a
 *   whole outage.
 *
 *   Every feature carries whether it actually works. `status: "not-yet"` never
 *   reaches a public page; the test suite fails the build if it does. The same
 *   rule applies one level up — a whole product, channel, pack or market can
 *   be `not-yet` — because the temptation to list a roadmap item on a pricing
 *   card is strongest precisely when someone is deciding whether to pay.
 *
 *   A product id, once sold, is never repriced and its allowances never
 *   change. Usage and fees are read live from this file by id, so changing a
 *   sold id silently changes what an existing customer gets. A new price is a
 *   new id in a new catalogue version; the old id becomes `legacy`.
 *
 *   Nothing is unlimited and nothing is charged that the owner did not
 *   choose. When an allowance runs out, the owner's usage policy decides —
 *   add a pack, move up, or stop at the allowance (billing/usage-policy.ts).
 *
 * Versions:
 *   "original" — Starter / Business / Enterprise, sold until September 2026,
 *                grandfathered for 90 days.
 *   "2026-09"  — the everything_* bundles, per-channel allowances. Sold for a
 *                few weeks; the venues on them keep them indefinitely.
 *   "2026-10"  — v2: Starter / Growth / Scale, per location, pooled voice
 *                minutes and text conversations. Sold in the UAE only;
 *                provisionally priced for Germany, Austria and Switzerland.
 */

import { MARKETS, MARKET_CODES, formatMoney, type Market } from "../markets";
import { calendarConnectionText, publicFlag } from "../site-flags";

export type { Market } from "../markets";

/** The catalogue being sold today. Stamped on Stripe metadata and on the subscription. */
export const CATALOGUE_VERSION = "2026-10";

/** 1 AED = 100 fils. Every amount in this module is a minor unit. */
export const FILS = 100;

export type BillingCycle = "monthly" | "annual";

/**
 * Months of the year the computed annual cycle does not charge for. Only
 * products without a stored annual price use it — the 2026-09 bundles, whose
 * customers were sold ten months for twelve.
 */
export const ANNUAL_MONTHS_FREE = 2;

// ---------------------------------------------------------------------------
// Channels and pools
// ---------------------------------------------------------------------------

export type Channel = "phone" | "web_voice" | "chat" | "whatsapp";
/** A unit is also a pool: every channel counting minutes shares one, and every channel counting conversations the other. */
export type Unit = "minutes" | "conversations";
export type Pool = Unit;

export const CHANNEL_ORDER: Channel[] = ["phone", "web_voice", "chat", "whatsapp"];
export const POOL_ORDER: Pool[] = ["minutes", "conversations"];

export interface ChannelInfo {
  channel: Channel;
  name: string;
  unit: Unit;
  status: "live" | "not-yet";
  gap?: string;
}

export const CHANNELS: Record<Channel, ChannelInfo> = {
  phone: { channel: "phone", name: "Phone", unit: "minutes", status: "live" },
  web_voice: { channel: "web_voice", name: "Website voice button", unit: "minutes", status: "live" },
  chat: { channel: "chat", name: "Website chat", unit: "conversations", status: "live" },
  // Live on the second-number model: the owner registers a new number they
  // own on /integrations (whatsapp-provision.ts), Meta texts it a code, and
  // Belline answers it under Belline's own WhatsApp Business account. Their
  // existing WhatsApp is never touched or answered. English only; voice notes
  // are refused (reception/respond.ts). Internal note: Meta business
  // verification for Belline's account is still pending, which limits how many
  // numbers and conversations the account gets. Not for a public page.
  whatsapp: { channel: "whatsapp", name: "WhatsApp", unit: "conversations", status: "live" },
};

/** The pool a channel draws on: phone and the voice button share minutes; chat and WhatsApp share conversations. */
export function poolOf(channel: Channel): Pool {
  return CHANNELS[channel].unit;
}

export const POOL_CHANNELS: Record<Pool, Channel[]> = {
  minutes: CHANNEL_ORDER.filter((c) => poolOf(c) === "minutes"),
  conversations: CHANNEL_ORDER.filter((c) => poolOf(c) === "conversations"),
};

export const POOL_NAMES: Record<Pool, string> = {
  minutes: "Voice minutes",
  conversations: "Text conversations",
};

/**
 * One per-channel allowance, in the words the website and the checkout both
 * use. Kept for the 2026-09 bundles, which were sold per channel.
 */
export function allowanceText(channel: Channel, amount: number): string {
  const n = amount.toLocaleString("en-GB");
  switch (channel) {
    case "phone":
      return `${n} phone minutes a month`;
    case "web_voice":
      return `${n} minutes a month on your website's voice button`;
    case "chat":
      return `${n} website chat conversations a month`;
    case "whatsapp":
      return `${n} WhatsApp conversations a month`;
  }
}

const POOL_PLACES: Record<Channel, string> = {
  phone: "your phone line",
  web_voice: "your website's voice button",
  chat: "your website chat",
  whatsapp: "WhatsApp",
};

function joinList(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The live channels a pool covers, as a phrase: "your phone line and your website's voice button". */
export function poolPlaces(pool: Pool): string {
  return joinList(POOL_CHANNELS[pool].filter((c) => CHANNELS[c].status === "live").map((c) => POOL_PLACES[c]));
}

/**
 * One pooled allowance, naming only the channels that work today: a channel
 * joins its sentence the day it is live, and not before.
 */
export function poolText(pool: Pool, amount: number): string {
  const n = amount.toLocaleString("en-GB");
  const unit = pool === "minutes" ? "voice minutes" : "text conversations";
  return `${n} ${unit} a month, shared across ${poolPlaces(pool)}`;
}

// ---------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------

/**
 * How many voice minutes one minute of the video receptionist uses.
 *
 * Video is included in every plan and draws on the voice-minute pool. 2.5
 * because it costs about that much more: Tavus Business is $975 for 4,000
 * minutes, about $0.24 a minute for the avatar ($0.26 all-in with our model
 * turns), against about $0.10 for a voice minute. Lowered when an enterprise
 * rate with Tavus is signed — this one setting moves the meter, the caps,
 * the alerts and every line that quotes video minutes.
 */
export const VIDEO_VOICE_MINUTE_RATIO = 2.5;

/** Whole video minutes a number of voice minutes buys, rounded down: 75 → 30. For display everywhere. */
export function videoMinutesFor(voiceMinutes: number): number {
  if (!(voiceMinutes > 0)) return 0;
  return Math.floor(voiceMinutes / VIDEO_VOICE_MINUTE_RATIO);
}

/**
 * Voice minutes a video call uses: its seconds at the ratio, rounded up to the
 * next whole minute once, the way every voice minute is (billing/usage.ts).
 */
export function voiceMinutesForVideoSeconds(seconds: number): number {
  if (!(seconds > 0)) return 0;
  return Math.ceil((seconds * VIDEO_VOICE_MINUTE_RATIO) / 60);
}

/**
 * Whether the video receptionist may be described as working, the way the
 * calendar lines follow theirs: the `video.avatar` flag, read when the
 * catalogue is read.
 */
export const videoLive = () => publicFlag("video.avatar");

const VIDEO_GAP =
  "Built and running on staging behind the video.avatar flag (TAVUS_API_KEY, TAVUS_FACE_ID, VIDEO_LLM_SECRET); " +
  "described as working once that flag is on in production.";

/** "30 video minutes (each uses 2.5 voice minutes)", from a voice-minute pool. */
export function videoAllowanceText(voiceMinutes: number): string {
  return `${videoMinutesFor(voiceMinutes).toLocaleString("en-GB")} video minutes (each uses ${VIDEO_VOICE_MINUTE_RATIO} voice minutes)`;
}

/** The video feature's line. The pricing page says it in each card's own video row instead (scripts/site-pricing.ts). */
export const VIDEO_RECEPTIONIST_TEXT = "Video receptionist on your website";

const VIDEO_RECEPTIONIST: Feature = {
  text: VIDEO_RECEPTIONIST_TEXT,
  get status(): Feature["status"] {
    return videoLive() ? "live" : "not-yet";
  },
  get gap() {
    return videoLive() ? undefined : VIDEO_GAP;
  },
};

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

/** What the website sells today (catalogue 2026-10). */
export type PlanId = "v2_starter" | "v2_growth" | "v2_scale";
/** The September 2026 bundles. Legacy: never sold again, kept indefinitely for the venues on them. */
export type BundleId = "everything_starter" | "everything_business" | "everything_pro";
export type ManagedId = "professional" | "premium";
/** The single-plan ladder sold until September 2026. Kept for grandfathered venues only. */
export type LegacyPlanId = "starter" | "business" | "enterprise";
export type ProductId = PlanId | BundleId | ManagedId | LegacyPlanId;

export interface Feature {
  text: string;
  /**
   * `live` — works end to end today, for a real customer.
   * `not-yet` — real intent, not built. Never rendered on a public page.
   */
  status: "live" | "not-yet";
  /** What is missing. Read by the internal gaps report, never by a visitor. */
  gap?: string;
}

/**
 * How long a legacy product is kept for the venues on it. `indefinite` never
 * lapses; `{ days }` is stamped as `grandfatheredUntil` by billing/grandfather.ts.
 */
export type Grandfather = "indefinite" | { days: number };

export interface Product {
  id: ProductId;
  /**
   * `plan` is what the website sells. `managed` is quoted and sold by a
   * person. `legacy` is never sold — it exists so a venue that bought an
   * older catalogue is billed and answered exactly as it was sold.
   */
  kind: "plan" | "managed" | "legacy";
  /** The catalogue version this product was sold under. */
  version: string;
  name: string;
  summary: string;
  /** A whole product can be not-yet: then it is neither shown nor sold. */
  status: "live" | "not-yet";
  gap?: string;
  /**
   * Per-channel allowances (2026-09 and older). A channel that is absent is
   * not part of the product. `null` is uncounted, and only the original
   * ladder has it — check-plans fails the build if anything sellable does.
   */
  allowances: Partial<Record<Channel, number | null>>;
  /**
   * Pooled allowances (2026-10). Every channel of a pool is included and
   * draws on the one number.
   */
  pools?: Partial<Record<Pool, number>>;
  /** Users on the dashboard. Stored as a limit; see the report on enforcement. */
  users?: number;
  /** Monthly, in the market's minor unit. Absent: not sold in that market. */
  prices: Partial<Record<Market, number>>;
  /**
   * Annual, billed once, in the market's minor unit — stored, never derived,
   * for every product from 2026-10. Absent: ten months of the monthly price
   * (how the 2026-09 bundles were sold).
   */
  annualPrices?: Partial<Record<Market, number>>;
  /** Markets whose price is a planning figure, not a decision. Listed in STATUS.md. */
  provisional?: Market[];
  features: Feature[];
  recommended?: boolean;
  /** Legacy only. */
  grandfather?: Grandfather;
}

/** Major units in, minor units out, in the MARKETS order. */
function price(ae: number, gb: number, au: number, ca: number, us: number, sg: number, ie: number, nz: number, ch: number, de: number, at: number) {
  const major: Record<Market, number> = { AE: ae, GB: gb, AU: au, CA: ca, US: us, SG: sg, IE: ie, NZ: nz, CH: ch, DE: de, AT: at };
  return Object.fromEntries(MARKET_CODES.map((m) => [m, major[m] * 100])) as Record<Market, number>;
}

const EXCEPT_AE: Market[] = MARKET_CODES.filter((m) => m !== "AE");

/**
 * The German-speaking markets, priced for their waitlist pages (founder,
 * 2026-09-16). Planning figures: provisional, not-yet markets, never sold.
 */
const DACH: Market[] = ["DE", "AT", "CH"];

/** Monthly or annual prices for the UAE and the DACH markets, major units in. */
function dach(ae: number, eur: number, chf: number) {
  return { AE: ae * 100, DE: eur * 100, AT: eur * 100, CH: chf * 100 };
}

const DEPOSITS: Feature = {
  text: "Deposit links by text, paid into your own Stripe account",
  status: "not-yet",
  gap:
    "Built in src/lib/billing/deposits.ts on Stripe Connect, but inert until STRIPE_SECRET_KEY " +
    "and a Connect webhook are set and a venue has finished Stripe onboarding.",
};

/**
 * Whether a calendar connection works, as the public pages may say it: the
 * flags themselves (`booking.google`, `booking.outlook`), read when the
 * catalogue is read, never typed here. The website ignores FLAG_STUBS, and so
 * does this. Getters rather than values, so a feature follows the flag it has
 * now: the pricing page (built and served), Belle's not-yet list and the gaps
 * report all read the same answer.
 */
const calendarsLive = () => ({ google: publicFlag("booking.google"), outlook: publicFlag("booking.outlook") });

const INTEGRATIONS: Feature = {
  text: "Google Calendar and booking-system integrations",
  // Fresha, SevenRooms, OpenTable and Treatwell are still missing, so never live on Google alone.
  status: "not-yet",
  get gap() {
    const { google } = calendarsLive();
    return (
      (google ? "Google Calendar is live (booking.google is on). " : "Google Calendar is built and tested; it goes live when booking.google is switched on. ") +
      "Fresha, SevenRooms, OpenTable and Treatwell are partner-gated and issue no credentials without a signed agreement."
    );
  },
};

/** One calendar connection: live while either calendar's flag is on, and naming only what is live. */
const CALENDAR_CONNECTION: Feature = {
  get text() {
    return calendarConnectionText(calendarsLive());
  },
  get status(): Feature["status"] {
    const { google, outlook } = calendarsLive();
    return google || outlook ? "live" : "not-yet";
  },
  get gap() {
    const { google, outlook } = calendarsLive();
    if (google || outlook) return undefined;
    return (
      "Google Calendar and Microsoft Outlook are both built and tested (check:google, check:outlook); " +
      "each goes live when its flag, booking.google or booking.outlook, is switched on in Railway."
    );
  },
};

// --- 2026-09 bundle features (frozen: these customers were sold them) --------

const STARTER_FEATURES: Feature[] = [
  { text: "Keep your number — forward it to Belline", status: "live" },
  { text: "Takes booking requests and passes them to your team", status: "live" },
  { text: "Answers questions from your own hours, prices and policies", status: "live" },
  { text: "Summary and full transcript of every call and chat", status: "live" },
  { text: "Puts urgent calls through to your team, live", status: "live" },
  {
    text: "A reminder text the day before every booking",
    status: "not-yet",
    gap: "Built in src/lib/reminders.ts, but no text is sent until TWILIO_SMS_FROM is set in Railway.",
  },
  { text: "Your team can take over any chat from the inbox", status: "live" },
  { text: "Your own words and colours on the website buttons", status: "live" },
  DEPOSITS,
];

const BUSINESS_FEATURES: Feature[] = [
  ...STARTER_FEATURES,
  { text: "Your own rules about what it may and may not decide", status: "live" },
  { text: "Every change versioned, with one-click revert", status: "live" },
  {
    text: "Waitlist — when a slot frees, the guest who wanted it is at the top of your list, with their number",
    status: "not-yet",
    gap:
      "Works only on Belline's own booking list, which the September 2026 direction freezes; " +
      "it is not offered on public plans while Belline works with the customer's own booking system.",
  },
];

const PRO_FEATURES: Feature[] = [
  ...BUSINESS_FEATURES,
  { text: "Named contact for onboarding and changes", status: "live" },
  { text: "Priority support", status: "live" },
  INTEGRATIONS,
];

// --- 2026-10 plan features ----------------------------------------------------
//
// Placed per the strategy doc (§ Revised pricing). Every live/not-yet
// judgement is carried over from the 2026-09 catalogue; anything the doc lists
// that the codebase does not do is recorded as not-yet with the reason, never
// promoted.

const V2_STARTER_FEATURES: Feature[] = [
  { text: "One location", status: "live" },
  { text: "Keep your number — forward it to Belline", status: "live" },
  { text: "Answers questions from your own hours, prices and policies", status: "live" },
  { text: "Takes booking requests and passes them to your team", status: "live" },
  { text: "Summary and full transcript of every call and chat", status: "live" },
  { text: "Your team can take over any chat from the inbox", status: "live" },
  { text: "Your own words and colours on the website buttons", status: "live" },
  VIDEO_RECEPTIONIST,
  CALENDAR_CONNECTION,
  DEPOSITS,
];

const V2_GROWTH_FEATURES: Feature[] = [
  ...V2_STARTER_FEATURES,
  { text: "Puts urgent calls through to your team, live", status: "live" },
  {
    text: "A reminder text the day before every booking",
    status: "not-yet",
    gap: "Built in src/lib/reminders.ts, but no text is sent until TWILIO_SMS_FROM is set in Railway.",
  },
  { text: "Your own rules about what it may and may not decide", status: "live" },
  // The same History panel as the 2026-09 line above, in a customer's words (site review, 2026-09-17).
  { text: "Restore earlier settings any time", status: "live" },
  {
    text: "Waitlist — when a slot frees, the guest who wanted it is at the top of your list, with their number",
    status: "not-yet",
    gap:
      "Works only on Belline's own booking list, which the September 2026 direction freezes; " +
      "it is not offered on public plans while Belline works with the customer's own booking system.",
  },
  // WhatsApp is not a Growth feature: every plan's text conversations pool
  // covers it (poolText), exactly as channelsOf and entitlement.ts answer it.
  {
    text: "One specialist booking integration — Fresha, Treatwell, SevenRooms or OpenTable",
    status: "not-yet",
    gap: "Partner-gated: no credentials without a signed partner agreement, which the founder files.",
  },
];

const V2_SCALE_FEATURES: Feature[] = [
  ...V2_GROWTH_FEATURES,
  { text: "Named contact for onboarding and changes", status: "live" },
  { text: "Priority support", status: "live" },
  {
    text: "Several booking and calendar connections on one location",
    status: "not-yet",
    gap:
      "A venue has one calendar connection today, Google Calendar or Outlook, and the routes refuse a " +
      "second. Several need the partner integrations and availability merged across sources.",
  },
  {
    text: "Advanced routing and staff rules for calls",
    status: "not-yet",
    gap:
      "Not built as a product feature: calls transfer to the venue's own number, and there is no " +
      "routing editor for per-staff, per-service or time-of-day rules.",
  },
  {
    text: "API and webhook access",
    status: "not-yet",
    gap:
      "There is no customer-facing API or outbound webhook. It needs scoped keys, rate limits and " +
      "an audit trail before it can be offered securely.",
  },
];

export const PRODUCTS: Product[] = [
  // --- 2026-10: the three plans ----------------------------------------------
  //
  // Decided by the founder: AED 249 / 499 / 999 per location per month, annual
  // stored at 2,739 / 5,489 / 10,989, and the allowances 75 / 250 / 500 voice
  // minutes and 200 / 600 / 1,500 text conversations. Sold in the UAE only;
  // the DACH prices below are for waitlist pages, not for sale.
  //
  // Pricing v3 ("Option C"), decided 16 September 2026. It supersedes the
  // allowances merged earlier the same day (Growth 300/750, Scale 600/2,000),
  // which were set before the cost model was corrected. Prices go up and the
  // two upper allowances come back down together, because the pair is what
  // buys the margin: on the conservative UAE basis this targets 60-65% at
  // typical use, and every plan clears the floor at full use on both cycles.
  //
  // Annual is eleven months for twelve — the customer saves one month — and
  // it is now held to the same floor as monthly (check-plans.ts). It was not
  // before, which is how the old Scale annual sat near 18% at full use
  // unnoticed.
  //
  // Unchanged: users per plan, the trial, the packs, the usage policy and its
  // alerts, and every feature list.
  //
  // Germany, Austria and Switzerland (founder, 2026-09-16): €69 / €129 / €249
  // and CHF 79 / 149 / 279 a month, annual at eleven months. Provisional, and
  // the markets are not-yet, so these reach only the German waitlist pages and
  // no checkout (`isSellable`).
  //
  // The UAE rates underneath these margins are still estimates, not quotes —
  // TWILIO_INBOUND_AE and TWILIO_NUMBER_AE above all (margin.ts
  // unverifiedLines). A real carrier quote is the last input needed to trust
  // this table.
  {
    id: "v2_starter",
    kind: "plan",
    version: "2026-10",
    name: "Starter",
    summary: "For a small business that wants every enquiry answered.",
    status: "live",
    allowances: {},
    pools: { minutes: 75, conversations: 200 },
    users: 2,
    prices: dach(249, 69, 79),
    annualPrices: dach(2739, 759, 869),
    provisional: DACH,
    features: V2_STARTER_FEATURES,
  },
  {
    id: "v2_growth",
    kind: "plan",
    version: "2026-10",
    name: "Growth",
    summary: "For a business that wants Belline answering and booking across every channel it has.",
    status: "live",
    recommended: true,
    allowances: {},
    pools: { minutes: 250, conversations: 600 },
    users: 5,
    prices: dach(499, 129, 149),
    annualPrices: dach(5489, 1419, 1639),
    provisional: DACH,
    features: V2_GROWTH_FEATURES,
  },
  {
    id: "v2_scale",
    kind: "plan",
    version: "2026-10",
    name: "Scale",
    summary: "For higher-volume teams with more complex reception rules.",
    status: "live",
    allowances: {},
    pools: { minutes: 500, conversations: 1500 },
    users: 15,
    prices: dach(999, 249, 279),
    annualPrices: dach(10989, 2739, 3069),
    provisional: DACH,
    features: V2_SCALE_FEATURES,
  },

  // --- managed track (addendum §2) -------------------------------------------
  //
  // Quoted by a person, sold in the UAE only, and not-yet as a whole until the
  // integrations, Arabic and outbound calling it describes exist.
  {
    id: "professional",
    kind: "managed",
    version: "2026-09",
    name: "Professional",
    summary: "Managed for you, connected to the booking system you already use.",
    status: "not-yet",
    gap: "Sells a booking-system integration and Arabic, neither of which exists.",
    allowances: { phone: 500, chat: 2000, whatsapp: 2000 },
    prices: { AE: 999 * 100 },
    features: [
      { text: "500 phone minutes a month", status: "live" },
      {
        // Named without the channels: Belle's not-yet list is generated from
        // these texts, and WhatsApp itself works.
        text: "Fair use up to 2,000 text conversations a month",
        status: "not-yet",
        gap:
          "Website chat and WhatsApp both work, but this is a managed-track allowance: the managed track " +
          "is not public until its booking-system integration and Arabic exist.",
      },
      {
        text: "Connected to Fresha, Treatwell, SevenRooms or OpenTable",
        status: "not-yet",
        gap: "Partner-gated: no credentials without a signed partner agreement, which the founder files.",
      },
      {
        text: "Answers in Arabic",
        status: "not-yet",
        gap: "No Arabic speech recognition, voice or prompt has been built or tested.",
      },
    ],
  },
  {
    id: "premium",
    kind: "managed",
    version: "2026-09",
    name: "Premium",
    summary: "Managed for a group, across its locations.",
    status: "not-yet",
    gap: "Sells multi-location pricing and outbound no-show calls, neither of which exists.",
    allowances: { phone: 1500, chat: 2000, whatsapp: 2000 },
    prices: { AE: 1999 * 100 },
    features: [
      { text: "1,500 phone minutes a month", status: "live" },
      { text: "Named contact for onboarding and changes", status: "live" },
      {
        text: "Up to three locations on one plan",
        status: "not-yet",
        gap: "A subscription belongs to one venue; nothing prices or bills several together.",
      },
      {
        text: "Rings guests who did not turn up",
        status: "not-yet",
        gap: "Belline only answers. Outbound calling is not built.",
      },
    ],
  },

  // --- legacy: 2026-09 bundles -------------------------------------------------
  //
  // Sold for a few weeks in September 2026. Never sold again; every price,
  // allowance and computed annual fee is exactly as sold, and the venues on
  // them keep them indefinitely.
  {
    id: "everything_starter",
    kind: "legacy",
    version: "2026-09",
    name: "Starter (September 2026)",
    summary: "The September 2026 Starter bundle.",
    status: "live",
    allowances: { phone: 200, web_voice: 100, chat: 150, whatsapp: 300 },
    prices: price(299, 65, 119, 109, 79, 109, 69, 129, 299, 69, 69),
    provisional: EXCEPT_AE,
    features: STARTER_FEATURES,
    grandfather: "indefinite",
  },
  {
    id: "everything_business",
    kind: "legacy",
    version: "2026-09",
    name: "Business (September 2026)",
    summary: "The September 2026 Business bundle.",
    status: "live",
    allowances: { phone: 600, web_voice: 200, chat: 400, whatsapp: 800 },
    prices: price(599, 129, 239, 219, 155, 219, 139, 269, 599, 139, 139),
    provisional: EXCEPT_AE,
    features: BUSINESS_FEATURES,
    grandfather: "indefinite",
  },
  {
    id: "everything_pro",
    kind: "legacy",
    version: "2026-09",
    name: "Pro (September 2026)",
    summary: "The September 2026 Pro bundle.",
    status: "live",
    allowances: { phone: 1500, web_voice: 300, chat: 1000, whatsapp: 1500 },
    prices: price(1199, 259, 479, 429, 309, 429, 289, 539, 1099, 289, 289),
    provisional: EXCEPT_AE,
    features: PRO_FEATURES,
    grandfather: "indefinite",
  },

  // --- legacy: the original ladder ---------------------------------------------
  //
  // Never shown, never sold; kept so a pilot venue on it is billed and
  // answered exactly as it was for its 90 days of grandfathering (addendum §3).
  // Enterprise was sold as uncounted, and a grandfathered promise is kept as made.
  {
    id: "starter",
    kind: "legacy",
    version: "original",
    name: "Starter (2026)",
    summary: "The original Starter plan.",
    status: "live",
    allowances: { phone: 60, web_voice: null, chat: null },
    prices: { AE: 179 * 100 },
    features: [],
    grandfather: { days: 90 },
  },
  {
    id: "business",
    kind: "legacy",
    version: "original",
    name: "Business (2026)",
    summary: "The original Business plan.",
    status: "live",
    allowances: { phone: 180, web_voice: null, chat: null },
    prices: { AE: 365 * 100 },
    features: [],
    grandfather: { days: 90 },
  },
  {
    id: "enterprise",
    kind: "legacy",
    version: "original",
    name: "Enterprise (2026)",
    summary: "The original Enterprise plan.",
    status: "live",
    allowances: { phone: null, web_voice: null, chat: null },
    prices: { AE: 899 * 100 },
    features: [],
    grandfather: { days: 90 },
  },
];

// ---------------------------------------------------------------------------
// Packs, services and volume
// ---------------------------------------------------------------------------

export type PackId = "pack_minutes_100" | "pack_conversations_150";

/**
 * Extra units for one billing period, added only under an owner's chosen
 * usage policy (billing/usage-policy.ts). Never sold on their own.
 */
export interface Pack {
  id: PackId;
  version: string;
  name: string;
  pool: Pool;
  units: number;
  prices: Partial<Record<Market, number>>;
  /** Markets whose pack price is a planning figure, not a decision. */
  provisional?: Market[];
  status: "live" | "not-yet";
  gap?: string;
}

export const PACKS: Pack[] = [
  {
    id: "pack_minutes_100",
    version: "2026-10",
    name: "100 extra voice minutes",
    pool: "minutes",
    units: 100,
    prices: dach(99, 25, 29),
    provisional: DACH,
    status: "live",
  },
  {
    id: "pack_conversations_150",
    version: "2026-10",
    name: "150 extra text conversations",
    pool: "conversations",
    units: 150,
    prices: dach(49, 12, 14),
    provisional: DACH,
    status: "live",
  },
];

/** When the owner is told how much of an allowance is used, in percent. Once each, per pool, per period. */
export const ALERT_THRESHOLDS = [70, 90, 100] as const;

export function packFor(pool: Pool): Pack {
  const pack = PACKS.find((p) => p.pool === pool);
  if (!pack) throw new Error(`No pack for ${pool}`);
  return pack;
}

/** A one-off service. */
export interface Service {
  id: "white_glove_setup" | "assisted_setup";
  name: string;
  status: "live" | "not-yet";
  gap?: string;
  prices: Partial<Record<Market, number>>;
  /** The products it may be bought with. Absent: the managed track. */
  forProducts?: ProductId[];
}

export const SERVICES: Service[] = [
  {
    id: "assisted_setup",
    name: "Assisted setup",
    status: "not-yet",
    gap:
      "The checkout sells subscriptions only; there is no Stripe line for a one-off fee, so a " +
      "person would have to invoice it by hand.",
    prices: { AE: 399 * 100 },
    forProducts: ["v2_starter", "v2_growth"],
  },
  {
    id: "white_glove_setup",
    name: "White-glove setup",
    status: "not-yet",
    gap: "Sold with the managed track only, which is not public until its features are live.",
    prices: { AE: 750 * 100 },
  },
];

/**
 * Several locations. Each is its own subscription; the discount is applied by
 * a person (a Stripe coupon on the group's subscriptions), never computed at
 * checkout.
 */
export const VOLUME = {
  perLocation: true,
  tiers: [
    { from: 5, to: 19, percentOff: 10 },
    { from: 20, custom: true },
  ],
  appliedBy: "person",
} as const;

/** What each older plan maps to today, for links that still carry `?plan=` or an old `products=`. */
export const LEGACY_TO_BUNDLE: Record<LegacyPlanId | BundleId, PlanId> = {
  starter: "v2_starter",
  business: "v2_growth",
  enterprise: "v2_scale",
  everything_starter: "v2_starter",
  everything_business: "v2_growth",
  everything_pro: "v2_scale",
};

/** How long a venue on the original ladder keeps its plan after the modular catalogue shipped. */
export const GRANDFATHER_DAYS = 90;

export function grandfatherOf(product: Product): Grandfather | null {
  return product.kind === "legacy" ? (product.grandfather ?? { days: GRANDFATHER_DAYS }) : null;
}

/** True when a selection includes a legacy product whose grandfathering runs out. */
export function grandfatherExpires(ids: readonly ProductId[]): boolean {
  return ids.some((id) => {
    const g = grandfatherOf(productById(id));
    return g !== null && g !== "indefinite";
  });
}

// ---------------------------------------------------------------------------
// The trial
// ---------------------------------------------------------------------------

/**
 * Thirty days, no card, and a cap on both units so an unattended trial
 * cannot run up a bill. The length is the offer; the caps are what stop it
 * costing us — a longer trial spends no more than a short one. The card is
 * asked for when somebody chooses a plan, never at signup.
 */
export const TRIAL = {
  days: 30,
  /** Voice minutes, pooled across the phone and the voice button. */
  minutes: 30,
  /** Text conversations, pooled across website chat and WhatsApp (a trial includes every channel). */
  conversations: 50,
  /** Stored as the entitlement; not said publicly while calendar connections are not-yet. */
  calendarConnections: 1,
  /** What a new trial is trialling. Changing plan is a decision for the end. */
  products: ["v2_starter"] as ProductId[],
} as const;

/** Trials started before 2026-10 stored a phone cap only, and trialled this bundle's other allowances. */
export const LEGACY_TRIAL_PRODUCTS: ProductId[] = ["everything_starter"];

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

export function isProductId(value: unknown): value is ProductId {
  return typeof value === "string" && PRODUCTS.some((p) => p.id === value);
}

export function productById(id: ProductId): Product {
  const product = PRODUCTS.find((p) => p.id === id);
  if (!product) throw new Error(`No such product: ${id}`);
  return product;
}

/** Monthly price in a market, minor units. Throws where it is not sold. */
export function priceOf(id: ProductId, market: Market): number {
  const amount = productById(id).prices[market];
  if (amount === undefined) throw new Error(`${id} is not sold in ${market}`);
  return amount;
}

/**
 * A live plan with a price in this market, open or not: what a country's
 * waitlist page may show as planned prices. Never a reason to take money —
 * that is `isSellable`.
 */
export function isOffered(product: Product, market: Market): boolean {
  return product.kind === "plan" && product.status === "live" && product.prices[market] !== undefined;
}

export function offered(market: Market): Product[] {
  return PRODUCTS.filter((p) => isOffered(p, market));
}

/**
 * Sellable on the website and at checkout, in this market: offered there, and
 * the market is open. Germany, Austria and Switzerland are priced for their
 * waitlist pages, and this is what keeps the checkout, signup, the API and
 * Belle from selling in them.
 */
export function isSellable(product: Product, market: Market): boolean {
  return isOffered(product, market) && MARKETS[market].status === "live";
}

export function sellable(market: Market): Product[] {
  return PRODUCTS.filter((p) => isSellable(p, market));
}

/** The plan the website marks as most popular. */
export function recommendedPlan(market: Market): Product {
  const plans = sellable(market);
  return plans.find((p) => p.recommended) ?? plans[0] ?? productById("v2_growth");
}

// ---------------------------------------------------------------------------
// A subscription's products
// ---------------------------------------------------------------------------

/**
 * Per-channel allowances across a set of products. `undefined` for a channel
 * none of them allows individually; `null` if any leaves it uncounted (the
 * original ladder only); otherwise the sum. Pooled products contribute nothing
 * here — see `poolsOf`.
 */
export function allowancesOf(ids: readonly ProductId[]): Partial<Record<Channel, number | null>> {
  const out: Partial<Record<Channel, number | null>> = {};
  for (const id of ids) {
    for (const [channel, amount] of Object.entries(productById(id).allowances) as [Channel, number | null][]) {
      const before = out[channel];
      out[channel] = before === null || amount === null ? null : (before ?? 0) + amount;
    }
  }
  return out;
}

/** Pooled allowances across a set of products. */
export function poolsOf(ids: readonly ProductId[]): Partial<Record<Pool, number>> {
  const out: Partial<Record<Pool, number>> = {};
  for (const id of ids) {
    for (const [pool, amount] of Object.entries(productById(id).pools ?? {}) as [Pool, number][]) {
      out[pool] = (out[pool] ?? 0) + amount;
    }
  }
  return out;
}

/** True when the selection is counted in pools (2026-10) rather than per channel. */
export function isPooled(ids: readonly ProductId[]): boolean {
  return ids.length > 0 && ids.every((id) => productById(id).pools !== undefined);
}

export function channelsOf(ids: readonly ProductId[]): Channel[] {
  const allowances = allowancesOf(ids);
  const pools = poolsOf(ids);
  return CHANNEL_ORDER.filter((c) => c in allowances || poolOf(c) in pools);
}

/** The monthly price of a selection, minor units. */
export function monthlyOf(ids: readonly ProductId[], market: Market): number {
  return ids.reduce((sum, id) => sum + priceOf(id, market), 0);
}

/**
 * What one billing period costs, minor units.
 *
 * Annual is the stored annual price where the product has one (2026-10
 * onwards). A product without one was sold at ten months for twelve, and that
 * is still computed for it, so its customers pay exactly what they were sold.
 */
export function periodFee(ids: readonly ProductId[], market: Market, cycle: BillingCycle): number {
  if (cycle === "monthly") return monthlyOf(ids, market);
  return ids.reduce((sum, id) => {
    const stored = productById(id).annualPrices?.[market];
    return sum + (stored ?? priceOf(id, market) * (12 - ANNUAL_MONTHS_FREE));
  }, 0);
}

/**
 * The monthly-equivalent of the annual cycle, rounded down to a whole unit of
 * currency so the twelve months we advertise never add up to more than the
 * sum we actually charge.
 */
export function annualPerMonth(ids: readonly ProductId[], market: Market): number {
  return Math.floor(periodFee(ids, market, "annual") / 12 / 100) * 100;
}

/** Whole months the annual price saves against twelve monthly payments, rounded down. */
export function annualMonthsSaved(ids: readonly ProductId[], market: Market): number {
  const monthly = monthlyOf(ids, market);
  return monthly > 0 ? Math.floor((monthly * 12 - periodFee(ids, market, "annual")) / monthly) : 0;
}

export function selectionName(ids: readonly ProductId[]): string {
  if (ids.length === 0) return "No plan";
  return ids.map((id) => productById(id).name).join(" + ");
}

export type Selection =
  | { ok: true; products: ProductId[] }
  | { ok: false; error: string };

/**
 * Is this something a customer may buy?
 *
 * Exactly one live plan sold in the market. The checkout, the API and Belle
 * all ask this, so none of them can accept what another would refuse.
 */
export function checkSelection(raw: readonly unknown[], market: Market): Selection {
  const ids = [...new Set(raw)];
  if (ids.length === 0) return { ok: false, error: "Choose a plan." };
  if (ids.length > 1) return { ok: false, error: "Choose one plan." };
  const [id] = ids;
  if (!isProductId(id)) return { ok: false, error: "That plan does not exist." };
  const product = productById(id);
  if (!isSellable(product, market)) {
    return { ok: false, error: `${product.name} is not available in ${MARKETS[market].name}.` };
  }
  return { ok: true, products: [id] };
}

/**
 * Was this bought from us — now or under an earlier catalogue?
 *
 * The Stripe webhook asks this rather than `checkSelection`: a checkout
 * opened on a 2026-09 bundle and paid after 2026-10 shipped is a real
 * purchase, and the customer gets what they paid for. The original ladder
 * arrives by its own `belline_plan` path; managed plans were never sold.
 */
export function checkPurchased(raw: readonly unknown[], market: Market): Selection {
  const now = checkSelection(raw, market);
  if (now.ok) return now;
  const ids = [...new Set(raw)];
  if (ids.length !== 1 || !isProductId(ids[0])) return now;
  const product = productById(ids[0]);
  if (product.kind === "legacy" && product.grandfather === "indefinite" && product.prices[market] !== undefined) {
    return { ok: true, products: [product.id] };
  }
  return now;
}

// ---------------------------------------------------------------------------
// Moving up
// ---------------------------------------------------------------------------

export interface Recommendation {
  products: ProductId[];
  name: string;
  monthly: number;
}

type Usage = Partial<Record<Channel, number>>;

function need(usage: Usage, channel: Channel): number {
  return Math.max(0, usage[channel] ?? 0);
}

/** Does this selection carry this usage on these channels? */
function carries(ids: readonly ProductId[], usage: Usage, keep: Set<Channel>): boolean {
  const allowances = allowancesOf(ids);
  const pools = poolsOf(ids);
  const pooled: Partial<Record<Pool, number>> = {};
  for (const channel of CHANNEL_ORDER) {
    const n = need(usage, channel);
    if (!keep.has(channel) && n === 0) continue;
    if (channel in allowances) {
      const amount = allowances[channel];
      if (amount !== null && amount !== undefined && n > amount) return false;
    } else if (poolOf(channel) in pools) {
      pooled[poolOf(channel)] = (pooled[poolOf(channel)] ?? 0) + n;
    } else {
      return false;
    }
  }
  return POOL_ORDER.every((pool) => (pooled[pool] ?? 0) <= (pools[pool] ?? 0));
}

/** What a selection includes of one pool, for the never-shrink rule. Null: uncounted, nothing to compare. */
function poolCapacity(ids: readonly ProductId[], pool: Pool): number | null {
  const pools = poolsOf(ids);
  if (pools[pool] !== undefined) return pools[pool]!;
  const allowances = allowancesOf(ids);
  let total = 0;
  for (const channel of POOL_CHANNELS[pool]) {
    const amount = allowances[channel];
    if (amount === null) return null;
    total += amount ?? 0;
  }
  return total;
}

/**
 * The cheapest plan that would carry this usage, if it is a move up.
 *
 * Used to say "you want Growth" rather than "you are over". It never shrinks
 * what the venue already has — a pool or a channel — and never points
 * downwards off the back of one quiet month.
 */
export function recommend(usage: Usage, current: readonly ProductId[], market: Market): Recommendation | null {
  const keep = new Set(channelsOf(current));
  if (current.length > 0 && carries(current, usage, keep)) return null;

  let best: Recommendation | null = null;
  for (const plan of sellable(market)) {
    const ids = [plan.id];
    if (!carries(ids, usage, keep)) continue;
    const shrinks = POOL_ORDER.some((pool) => {
      const before = poolCapacity(current, pool);
      const after = poolCapacity(ids, pool);
      return before !== null && after !== null && after < before;
    });
    if (shrinks) continue;
    const monthly = monthlyOf(ids, market);
    if (!best || monthly < best.monthly) best = { products: ids, name: plan.name, monthly };
  }
  if (!best) return null;

  const priced = current.every((id) => productById(id).prices[market] !== undefined);
  const now = priced && current.length ? monthlyOf(current, market) : 0;
  return best.monthly > now ? best : null;
}

/** The next plan up the sellable ladder, for the "upgrade" usage policy. */
export function nextPlanUp(current: readonly ProductId[], market: Market): Product | null {
  const plans = sellable(market);
  const now = current.length && current.every((id) => productById(id).prices[market] !== undefined) ? monthlyOf(current, market) : 0;
  return plans.find((p) => priceOf(p.id, market) > now) ?? null;
}

// ---------------------------------------------------------------------------
// What the public may see, and what it may not
// ---------------------------------------------------------------------------

/** The allowance lines a product shows: pools, per-channel allowances, users — each with its real status. */
export function allowanceFeatures(product: Product): Feature[] {
  const pools = POOL_ORDER.filter((pool) => typeof product.pools?.[pool] === "number").map((pool) => {
    const live = POOL_CHANNELS[pool].some((c) => CHANNELS[c].status === "live");
    return { text: poolText(pool, product.pools![pool]!), status: live ? ("live" as const) : ("not-yet" as const) };
  });
  // What the voice-minute pool buys as video, generated from it. Only for a
  // current plan: an older product was never sold video.
  if (typeof product.pools?.minutes === "number" && product.version === CATALOGUE_VERSION) {
    const on = videoLive();
    pools.push({ text: videoAllowanceText(product.pools.minutes), status: on ? ("live" as const) : ("not-yet" as const), ...(on ? {} : { gap: VIDEO_GAP }) });
  }
  const channels = CHANNEL_ORDER.filter((c) => typeof product.allowances[c] === "number").map((channel) => ({
    text: allowanceText(channel, product.allowances[channel] as number),
    status: CHANNELS[channel].status,
    gap: CHANNELS[channel].gap,
  }));
  const users = product.users ? [{ text: `Up to ${product.users} users on your dashboard`, status: "live" as const }] : [];
  return [...pools, ...channels, ...users];
}

/** Everything a pricing card may say about a product: allowances first, then features. */
export function publicLines(product: Product): string[] {
  return [...allowanceFeatures(product), ...product.features]
    .filter((f) => f.status === "live")
    .map((f) => f.text);
}

/**
 * Everything the catalogue describes that does not yet work.
 *
 * The pricing page is generated against `live` only; this is the other half
 * of that list, so what we are choosing not to say is written down somewhere
 * rather than just absent.
 */
export function notYetLive(): { where: string; feature: string; gap: string }[] {
  const out: { where: string; feature: string; gap: string }[] = [];
  const seen = new Set<string>();
  const add = (where: string, feature: string, gap: string | undefined) => {
    const key = `${where} ${feature}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ where, feature, gap: gap ?? "No reason recorded." });
  };

  for (const channel of CHANNEL_ORDER) {
    const info = CHANNELS[channel];
    if (info.status === "not-yet") add("Channel", info.name, info.gap);
  }
  for (const product of PRODUCTS) {
    if (product.kind === "legacy") continue;
    if (product.status === "not-yet") add("Product", product.name, product.gap);
    for (const f of product.features) {
      if (f.status === "not-yet") add(product.name, f.text, f.gap);
    }
  }
  for (const pack of PACKS) {
    if (pack.status === "not-yet") add("Pack", pack.name, pack.gap);
  }
  for (const service of SERVICES) {
    if (service.status === "not-yet") add("Service", service.name, service.gap);
  }
  for (const market of MARKET_CODES) {
    if (MARKETS[market].status === "not-yet") add("Market", MARKETS[market].name, MARKETS[market].gap);
  }
  return out;
}

/** Format minor units in a market's currency. */
export function money(minor: number, market: Market): string {
  return formatMoney(minor, market);
}

/** Format fils as dirhams. */
export function aed(fils: number): string {
  return formatMoney(fils, "AE");
}

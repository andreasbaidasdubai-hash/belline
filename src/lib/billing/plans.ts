/**
 * What Belline costs.
 *
 * One catalogue, read by the billing engine, the checkout, Stripe, the
 * website and Belle, and checked against all of them by
 * `scripts/check-billing.ts` and `scripts/check-plans.ts`. Three rules hold it
 * together:
 *
 *   Money is integer minor units — fils, pence, cents — never a float. An
 *   invoice that reads "AED 246.60000000000002" destroys more trust than a
 *   whole outage.
 *
 *   Every feature carries whether it actually works. `status: "not-yet"` never
 *   reaches a public page; the test suite fails the build if it does. The same
 *   rule applies one level up — a whole product, a whole channel or a whole
 *   market can be `not-yet` — because the temptation to list a roadmap item on
 *   a pricing card is strongest precisely when someone is deciding whether to
 *   pay.
 *
 *   There is no per-minute or per-conversation overage anywhere. An allowance
 *   that runs out is a prompt to move up, never a second number on a bill.
 *   Nothing here is unlimited either: the only accounts that would use
 *   "unlimited" are the ones on the line where our own cost is highest.
 *
 * The shape (strategy doc §2.2): four channels sold as **modules**, so a
 * restaurant that only wants the chat can start small, and three **bundles**
 * — a set of allowances at one price, not a discount on the modules — for the
 * venue that wants everything. Priced per market in local money and never
 * converted at runtime (§2.4). Beside that self-serve ladder sits a
 * **managed** track (addendum), built into the catalogue now and hidden until
 * the things it promises exist.
 */

import { MARKETS, MARKET_CODES, formatMoney, type Market } from "../markets";

export type { Market } from "../markets";

/** 1 AED = 100 fils. Every amount in this module is a minor unit. */
export const FILS = 100;

export type BillingCycle = "monthly" | "annual";

/** Months of the year the annual cycle does not charge for. */
export const ANNUAL_MONTHS_FREE = 2;

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export type Channel = "phone" | "web_voice" | "chat" | "whatsapp";
export type Unit = "minutes" | "conversations";

export const CHANNEL_ORDER: Channel[] = ["phone", "web_voice", "chat", "whatsapp"];

export interface ChannelInfo {
  channel: Channel;
  /** The module's name on a pricing card. */
  name: string;
  unit: Unit;
  status: "live" | "not-yet";
  gap?: string;
}

export const CHANNELS: Record<Channel, ChannelInfo> = {
  phone: { channel: "phone", name: "Phone Receptionist", unit: "minutes", status: "live" },
  web_voice: { channel: "web_voice", name: "Website Voice Button", unit: "minutes", status: "live" },
  chat: { channel: "chat", name: "Chat Receptionist", unit: "conversations", status: "live" },
  whatsapp: {
    channel: "whatsapp",
    name: "WhatsApp Receptionist",
    unit: "conversations",
    status: "not-yet",
    gap:
      "Answering a customer's own WhatsApp number needs Belline's Meta WhatsApp Business account " +
      "(WHATSAPP_BUSINESS_ACCOUNT_ID, a verified business, and the app secret in Railway). The " +
      "founder's Meta profile is suspended pending appeal; today only Belline's own Twilio sandbox " +
      "number answers.",
  },
};

/**
 * One allowance, in the words the website and the checkout both use.
 *
 * Generated rather than typed into each product, so "600 phone minutes" and
 * the number the engine counts against cannot disagree.
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

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export type ModuleId =
  | "chat_free"
  | "chat"
  | "whatsapp"
  | "web_voice"
  | "phone_starter"
  | "phone_business"
  | "phone_pro";
export type BundleId = "everything_starter" | "everything_business" | "everything_pro";
export type ManagedId = "professional" | "premium";
/** The single-plan ladder sold until September 2026. Kept for grandfathered venues only. */
export type LegacyPlanId = "starter" | "business" | "enterprise";
export type ProductId = ModuleId | BundleId | ManagedId | LegacyPlanId;

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

export interface Product {
  id: ProductId;
  /**
   * `module` and `bundle` are the self-serve ladder. `managed` is quoted and
   * sold by a person. `legacy` is never sold — it exists so a venue that bought
   * the old ladder is still billed and answered correctly while grandfathered.
   */
  kind: "module" | "bundle" | "managed" | "legacy";
  name: string;
  summary: string;
  /** A whole product can be not-yet: then it is neither shown nor sold. */
  status: "live" | "not-yet";
  gap?: string;
  /**
   * What a period includes, per channel. A channel that is absent is not part
   * of the product. `null` is uncounted, and only the legacy ladder has it —
   * check-plans fails the build if anything sellable does.
   */
  allowances: Partial<Record<Channel, number | null>>;
  /** Monthly, in the market's minor unit. Absent: not sold in that market. */
  prices: Partial<Record<Market, number>>;
  /**
   * Markets whose price was derived here rather than set in the strategy doc
   * (§2.2, §2.4, addendum). Listed in STATUS.md so they are decided, not
   * forgotten.
   */
  provisional?: Market[];
  features: Feature[];
  recommended?: boolean;
  /**
   * The free chat tier's limits. The badge is the price of free; the model and
   * the ceiling are what keep 500 free accounts affordable (§2.2).
   */
  free?: { model: string; maxMessagesPerChat: number; badge: true; inboxTakeover: false };
}

/** Major units in, minor units out, in the MARKETS order. */
function price(ae: number, gb: number, au: number, ca: number, us: number, sg: number, ie: number, nz: number, ch: number) {
  const major: Record<Market, number> = { AE: ae, GB: gb, AU: au, CA: ca, US: us, SG: sg, IE: ie, NZ: nz, CH: ch };
  return Object.fromEntries(MARKET_CODES.map((m) => [m, major[m] * 100])) as Record<Market, number>;
}

const EXCEPT_AE: Market[] = MARKET_CODES.filter((m) => m !== "AE");

const DEPOSITS: Feature = {
  text: "Deposit links by text, paid into your own Stripe account",
  status: "not-yet",
  gap:
    "Built in src/lib/billing/deposits.ts on Stripe Connect, but inert until STRIPE_SECRET_KEY " +
    "and a Connect webhook are set and a venue has finished Stripe onboarding.",
};

const INTEGRATIONS: Feature = {
  text: "Google Calendar and booking-system integrations",
  status: "not-yet",
  gap:
    "Google Calendar is written and tested but has never run — it needs GOOGLE_CLIENT_ID and " +
    "GOOGLE_CLIENT_SECRET in Railway. Fresha, SevenRooms, OpenTable and Treatwell are " +
    "partner-gated and issue no credentials without a signed agreement.",
};

const ANSWERS: Feature[] = [
  { text: "Books and changes appointments against your real availability", status: "live" },
  { text: "Answers questions from your own hours, prices and policies", status: "live" },
];

const PHONE_BASE: Feature[] = [
  { text: "Keep your number — forward it to Belline", status: "live" },
  ...ANSWERS,
  { text: "Summary and full transcript of every call", status: "live" },
  { text: "Puts urgent calls through to your team, live", status: "live" },
  { text: "A reminder text the day before every booking", status: "live" },
  DEPOSITS,
];

const PHONE_BUSINESS: Feature[] = [
  { text: "Your own rules about what it may and may not decide", status: "live" },
  { text: "Every change versioned, with one-click revert", status: "live" },
  // Not "it offers a slot": Belline does not ring the guest. It matches the
  // freed slot to whoever wanted it and puts them at the top of the venue's
  // own list, held for half an hour. The ringing is the team's.
  {
    text: "Waitlist — when a slot frees, the guest who wanted it is at the top of your list, with their number",
    status: "live",
  },
];

const PHONE_PRO: Feature[] = [
  { text: "Named contact for onboarding and changes", status: "live" },
  { text: "Priority support", status: "live" },
  INTEGRATIONS,
];

const CHAT_PAID: Feature[] = [
  { text: "Your team can take over any conversation from the inbox", status: "live" },
  { text: "No Belline badge on your chat", status: "live" },
];

const WEB_VOICE: Feature[] = [
  { text: "Your own words and colours on the buttons", status: "live" },
];

const WHATSAPP: Feature[] = [
  {
    text: "Connect your WhatsApp number yourself, in minutes",
    status: "not-yet",
    gap: CHANNELS.whatsapp.gap,
  },
  {
    text: "Booking confirmations on WhatsApp",
    status: "not-yet",
    gap:
      "A confirmation sent outside the 24-hour service window has to be an approved Meta utility " +
      "template. Metering for templates exists (billing/cost.ts); sending and template approval do not.",
  },
];

export const PRODUCTS: Product[] = [
  // --- modules ---------------------------------------------------------------
  {
    id: "chat_free",
    kind: "module",
    name: "Chat Receptionist — Free",
    summary: "Belline on your website's chat, free for as long as you like.",
    status: "live",
    allowances: { chat: 100 },
    prices: price(0, 0, 0, 0, 0, 0, 0, 0, 0),
    features: [
      ...ANSWERS,
      { text: "No card, and no end date", status: "live" },
      { text: "“Answered by Belline” shown on your chat", status: "live" },
    ],
    free: { model: "claude-haiku-4-5", maxMessagesPerChat: 20, badge: true, inboxTakeover: false },
  },
  {
    id: "chat",
    kind: "module",
    name: "Chat Receptionist",
    summary: "The chat on your website, answered and booking.",
    status: "live",
    allowances: { chat: 150 },
    prices: price(49, 9, 19, 17, 13, 17, 12, 21, 49),
    provisional: EXCEPT_AE,
    features: [...ANSWERS, ...CHAT_PAID],
  },
  {
    id: "whatsapp",
    kind: "module",
    name: "WhatsApp Receptionist",
    summary: "Your WhatsApp, answered and booking.",
    status: "not-yet",
    gap: CHANNELS.whatsapp.gap,
    allowances: { whatsapp: 300 },
    prices: price(99, 21, 39, 37, 27, 37, 25, 45, 99),
    provisional: EXCEPT_AE,
    features: [...ANSWERS, ...WHATSAPP],
  },
  {
    id: "web_voice",
    kind: "module",
    name: "Website Voice Button",
    summary: "A button on your website that visitors talk to.",
    status: "live",
    allowances: { web_voice: 150 },
    prices: price(99, 21, 39, 37, 27, 37, 25, 45, 99),
    provisional: EXCEPT_AE,
    features: [...ANSWERS, ...WEB_VOICE],
  },
  {
    id: "phone_starter",
    kind: "module",
    name: "Phone Receptionist — Starter",
    summary: "For a single venue that wants the phone answered properly.",
    status: "live",
    allowances: { phone: 200 },
    // AED 199, not the doc's 149: on a UAE line with a $15 number, 149 left
    // 32% at typical use against the 45% floor (decision, 14 Sep 2026).
    prices: price(199, 35, 59, 55, 39, 55, 39, 65, 149),
    provisional: ["NZ"],
    features: PHONE_BASE,
  },
  {
    id: "phone_business",
    kind: "module",
    name: "Phone Receptionist — Business",
    summary: "For a venue where the phone is genuinely busy.",
    status: "live",
    allowances: { phone: 600 },
    // AED 399, not the doc's 349, for the same reason: 349 left 44%.
    prices: price(399, 79, 139, 129, 95, 129, 89, 155, 349),
    provisional: ["NZ"],
    features: [...PHONE_BASE, ...PHONE_BUSINESS],
  },
  {
    id: "phone_pro",
    kind: "module",
    name: "Phone Receptionist — Pro",
    summary: "For a venue whose phone never stops.",
    status: "live",
    allowances: { phone: 1500 },
    prices: price(799, 179, 319, 299, 219, 299, 199, 359, 699),
    provisional: ["NZ"],
    features: [...PHONE_BASE, ...PHONE_BUSINESS, ...PHONE_PRO],
  },

  // --- bundles ---------------------------------------------------------------
  {
    id: "everything_starter",
    kind: "bundle",
    name: "Everything Starter",
    summary: "Every channel, for one venue getting started.",
    status: "live",
    allowances: { phone: 200, web_voice: 100, chat: 150, whatsapp: 300 },
    prices: price(249, 55, 99, 89, 65, 89, 59, 109, 249),
    provisional: EXCEPT_AE,
    features: [...PHONE_BASE, ...CHAT_PAID, ...WEB_VOICE],
  },
  {
    id: "everything_business",
    kind: "bundle",
    name: "Everything Business",
    summary: "Every channel, for a venue that is genuinely busy.",
    status: "live",
    recommended: true,
    allowances: { phone: 600, web_voice: 200, chat: 400, whatsapp: 800 },
    prices: price(499, 109, 199, 179, 129, 179, 119, 219, 499),
    provisional: EXCEPT_AE,
    features: [...PHONE_BASE, ...PHONE_BUSINESS, ...CHAT_PAID, ...WEB_VOICE],
  },
  {
    id: "everything_pro",
    kind: "bundle",
    name: "Everything Pro",
    summary: "Every channel, for a venue that never stops.",
    status: "live",
    allowances: { phone: 1500, web_voice: 300, chat: 1000, whatsapp: 1500 },
    prices: price(999, 219, 399, 359, 259, 359, 239, 449, 899),
    provisional: EXCEPT_AE,
    features: [...PHONE_BASE, ...PHONE_BUSINESS, ...PHONE_PRO, ...CHAT_PAID, ...WEB_VOICE],
  },

  // --- managed track (addendum §2) -------------------------------------------
  //
  // Quoted by a person, sold in the UAE only, and not-yet as a whole until the
  // integrations, Arabic and outbound calling it describes exist. Belle may say
  // "for groups, we quote" and hand over; she may not describe these.
  {
    id: "professional",
    kind: "managed",
    name: "Professional",
    summary: "Managed for you, connected to the booking system you already use.",
    status: "not-yet",
    gap: "Sells a booking-system integration and Arabic, neither of which exists.",
    allowances: { phone: 500, chat: 2000, whatsapp: 2000 },
    prices: { AE: 999 * 100 },
    features: [
      { text: "500 phone minutes a month", status: "live" },
      {
        text: "WhatsApp and website chat, fair use up to 2,000 conversations",
        status: "not-yet",
        gap: CHANNELS.whatsapp.gap,
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

  // --- legacy ----------------------------------------------------------------
  //
  // The ladder sold until this catalogue shipped. Never shown, never sold;
  // kept so a pilot venue on it is billed and answered exactly as it was for
  // its 90 days of grandfathering (addendum §3). Enterprise was sold as
  // unlimited, and a grandfathered promise is kept as made.
  {
    id: "starter",
    kind: "legacy",
    name: "Starter (2026)",
    summary: "The original Starter plan.",
    status: "live",
    allowances: { phone: 60, web_voice: null, chat: null },
    prices: { AE: 179 * 100 },
    features: [],
  },
  {
    id: "business",
    kind: "legacy",
    name: "Business (2026)",
    summary: "The original Business plan.",
    status: "live",
    allowances: { phone: 180, web_voice: null, chat: null },
    prices: { AE: 365 * 100 },
    features: [],
  },
  {
    id: "enterprise",
    kind: "legacy",
    name: "Enterprise (2026)",
    summary: "The original Enterprise plan.",
    status: "live",
    allowances: { phone: null, web_voice: null, chat: null },
    prices: { AE: 899 * 100 },
    features: [],
  },
];

/** A one-off service. Managed track only (addendum §2). */
export interface Service {
  id: "white_glove_setup";
  name: string;
  status: "live" | "not-yet";
  gap?: string;
  prices: Partial<Record<Market, number>>;
}

export const SERVICES: Service[] = [
  {
    id: "white_glove_setup",
    name: "White-glove setup",
    status: "not-yet",
    gap: "Sold with the managed track only, which is not public until its features are live.",
    prices: { AE: 750 * 100 },
  },
];

/** What each legacy plan maps to on the new ladder, for links that still carry `?plan=`. */
export const LEGACY_TO_BUNDLE: Record<LegacyPlanId, BundleId> = {
  starter: "everything_starter",
  business: "everything_business",
  enterprise: "everything_pro",
};

/** How long a legacy venue keeps its plan after this catalogue ships. */
export const GRANDFATHER_DAYS = 90;

// ---------------------------------------------------------------------------
// The trial (§2.3)
// ---------------------------------------------------------------------------

/**
 * Fourteen days, every channel switched on, and a cap on phone minutes so an
 * unattended trial cannot run up a bill. No card — the card is asked for when
 * somebody chooses a plan, never at signup.
 */
export const TRIAL = {
  days: 14,
  phoneMinutes: 60,
  /** What a new trial is trialling. Changing plan is a decision for the end. */
  products: ["everything_starter"] as ProductId[],
} as const;

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

/** Sellable on the website and at checkout, in this market. */
export function isSellable(product: Product, market: Market): boolean {
  return (
    (product.kind === "module" || product.kind === "bundle") &&
    product.status === "live" &&
    product.prices[market] !== undefined
  );
}

export function sellable(market: Market): Product[] {
  return PRODUCTS.filter((p) => isSellable(p, market));
}

// ---------------------------------------------------------------------------
// A selection: what a subscription is made of
// ---------------------------------------------------------------------------

/**
 * Allowances across a set of products, per channel.
 *
 * `undefined` for a channel none of them includes; `null` if any of them
 * leaves it uncounted (legacy only); otherwise the sum.
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

export function channelsOf(ids: readonly ProductId[]): Channel[] {
  const allowances = allowancesOf(ids);
  return CHANNEL_ORDER.filter((c) => c in allowances);
}

/** The monthly price of a selection, minor units. */
export function monthlyOf(ids: readonly ProductId[], market: Market): number {
  return ids.reduce((sum, id) => sum + priceOf(id, market), 0);
}

/**
 * What one billing period of a selection costs, minor units.
 *
 * Annual is ten months' money for twelve months, computed rather than stored,
 * so it cannot drift from the monthly figure.
 */
export function periodFee(ids: readonly ProductId[], market: Market, cycle: BillingCycle): number {
  const monthly = monthlyOf(ids, market);
  return cycle === "annual" ? monthly * (12 - ANNUAL_MONTHS_FREE) : monthly;
}

/**
 * The monthly-equivalent of the annual cycle, rounded down to a whole unit of
 * currency so the twelve months we advertise never add up to more than the
 * sum we actually charge.
 */
export function annualPerMonth(ids: readonly ProductId[], market: Market): number {
  return Math.floor(periodFee(ids, market, "annual") / 12 / 100) * 100;
}

/** "Everything Business", or "Phone Receptionist — Starter + Chat Receptionist". */
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
 * One bundle on its own, or modules with at most one per channel — two phone
 * tiers, or the free chat and the paid one together, is a mistake rather than
 * a purchase. Only live products sold in the market. Order is normalised so
 * the same choice always produces the same Stripe line items.
 */
export function checkSelection(raw: readonly unknown[], market: Market): Selection {
  const ids = [...new Set(raw)];
  if (ids.length === 0) return { ok: false, error: "Choose a plan." };

  const products: Product[] = [];
  for (const id of ids) {
    if (!isProductId(id)) return { ok: false, error: "That plan does not exist." };
    const product = productById(id);
    if (!isSellable(product, market)) {
      return { ok: false, error: `${product.name} is not available in ${MARKETS[market].name}.` };
    }
    products.push(product);
  }

  const bundles = products.filter((p) => p.kind === "bundle");
  if (bundles.length > 0 && products.length > 1) {
    return { ok: false, error: "A bundle already includes every channel — choose it on its own." };
  }

  const seen = new Set<Channel>();
  for (const product of products) {
    for (const channel of Object.keys(product.allowances) as Channel[]) {
      if (product.kind === "module" && seen.has(channel)) {
        return { ok: false, error: `Choose one ${CHANNELS[channel].name} option.` };
      }
      seen.add(channel);
    }
  }

  const order = PRODUCTS.map((p) => p.id);
  return {
    ok: true,
    products: products.map((p) => p.id).sort((a, b) => order.indexOf(a) - order.indexOf(b)),
  };
}

/** True when a selection is only the free chat: no card, no Stripe. */
export function isFreeSelection(ids: readonly ProductId[]): boolean {
  return ids.length > 0 && ids.every((id) => Boolean(productById(id).free));
}

// ---------------------------------------------------------------------------
// Moving up
// ---------------------------------------------------------------------------

export interface Recommendation {
  products: ProductId[];
  name: string;
  monthly: number;
}

/**
 * The cheapest selection that would carry this usage, if it is a move up.
 *
 * Used to say "you want Everything Business" rather than "you are over" — the
 * second is a complaint, the first is an answer. Every channel the venue
 * already pays for stays in the answer, even one that was quiet this period:
 * recommending somebody drop the phone because it had a slow month is not a
 * recommendation anybody asked for. And never downwards off the back of one
 * quiet month.
 */
export function recommend(
  usage: Partial<Record<Channel, number>>,
  current: readonly ProductId[],
  market: Market,
): Recommendation | null {
  const keep = new Set(channelsOf(current));
  const had = allowancesOf(current);
  const need = (channel: Channel) => Math.max(0, usage[channel] ?? 0);

  const fits = (ids: readonly ProductId[], candidate: boolean) => {
    const allowances = allowancesOf(ids);
    for (const channel of CHANNEL_ORDER) {
      const amount = allowances[channel];
      const wanted = keep.has(channel) || need(channel) > 0;
      if (!wanted) continue;
      if (amount === undefined) return false;
      if (amount !== null && need(channel) > amount) return false;
      // A move up never shrinks a channel they already have.
      const before = had[channel];
      if (candidate && amount !== null && typeof before === "number" && amount < before) return false;
    }
    return true;
  };

  if (current.length > 0 && fits(current, false)) return null;

  // The free chat is somebody's choice, never our recommendation: it carries
  // the badge, and suggesting it to a paying venue is suggesting a downgrade.
  const live = sellable(market).filter((p) => !p.free);
  const options = (channel: Channel) => [
    null,
    ...live.filter((p) => p.kind === "module" && channel in p.allowances).map((p) => p.id),
  ];

  const candidates: ProductId[][] = live.filter((p) => p.kind === "bundle").map((p) => [p.id]);
  for (const phone of options("phone"))
    for (const voice of options("web_voice"))
      for (const chat of options("chat"))
        for (const whatsapp of options("whatsapp")) {
          const ids = [phone, voice, chat, whatsapp].filter((x): x is ProductId => x !== null);
          // In the catalogue's order, the same order checkSelection returns,
          // so a recommendation can be handed straight to the checkout.
          const order = PRODUCTS.map((p) => p.id);
          if (ids.length) candidates.push(ids.sort((a, b) => order.indexOf(a) - order.indexOf(b)));
        }

  let best: Recommendation | null = null;
  for (const ids of candidates) {
    if (!fits(ids, true)) continue;
    const monthly = monthlyOf(ids, market);
    if (!best || monthly < best.monthly || (monthly === best.monthly && ids.length < best.products.length)) {
      best = { products: ids, name: selectionName(ids), monthly };
    }
  }
  if (!best) return null;

  const paying = current.filter((id) => productById(id).prices[market] !== undefined);
  const now = paying.length === current.length ? monthlyOf(current, market) : 0;
  return best.monthly > now ? best : null;
}

// ---------------------------------------------------------------------------
// What the public may see, and what it may not
// ---------------------------------------------------------------------------

/** The allowance lines a product shows, with the channel's own status. */
export function allowanceFeatures(product: Product): Feature[] {
  return CHANNEL_ORDER.filter((c) => typeof product.allowances[c] === "number").map((channel) => ({
    text: allowanceText(channel, product.allowances[channel] as number),
    status: CHANNELS[channel].status,
    gap: CHANNELS[channel].gap,
  }));
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
 * rather than just absent. Belle reads it too.
 */
export function notYetLive(): { where: string; feature: string; gap: string }[] {
  const out: { where: string; feature: string; gap: string }[] = [];
  const seen = new Set<string>();
  const add = (where: string, feature: string, gap: string | undefined) => {
    const key = `${where} ${feature}`;
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

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
 *   rule applies one level up — a whole product, channel or market can be
 *   `not-yet` — because the temptation to list a roadmap item on a pricing
 *   card is strongest precisely when someone is deciding whether to pay.
 *
 *   There is no per-minute or per-conversation overage anywhere. An allowance
 *   that runs out is a prompt to move up, never a second number on a bill.
 *   Nothing here is unlimited either, and nothing is free: the trial is the
 *   only way to use Belline without paying.
 *
 * The shape (decided 14 September 2026, simplifying the strategy doc's
 * modules): three plans, every channel in every plan, differing only in how
 * much they include. One decision for a buyer, not a build-your-own form.
 * Priced per market in local money and never converted at runtime. Beside
 * them sits a **managed** track (addendum), built into the catalogue and
 * hidden until the things it promises exist.
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
  name: string;
  unit: Unit;
  status: "live" | "not-yet";
  gap?: string;
}

export const CHANNELS: Record<Channel, ChannelInfo> = {
  phone: { channel: "phone", name: "Phone", unit: "minutes", status: "live" },
  web_voice: { channel: "web_voice", name: "Website voice button", unit: "minutes", status: "live" },
  chat: { channel: "chat", name: "Website chat", unit: "conversations", status: "live" },
  whatsapp: {
    channel: "whatsapp",
    name: "WhatsApp",
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
 * Generated rather than typed into each plan, so "600 phone minutes" and the
 * number the engine counts against cannot disagree.
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

export type PlanId = "everything_starter" | "everything_business" | "everything_pro";
export type ManagedId = "professional" | "premium";
/** The single-plan ladder sold until September 2026. Kept for grandfathered venues only. */
export type LegacyPlanId = "starter" | "business" | "enterprise";
export type ProductId = PlanId | ManagedId | LegacyPlanId;

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
   * `plan` is what the website sells. `managed` is quoted and sold by a
   * person. `legacy` is never sold — it exists so a venue that bought the old
   * ladder is billed and answered correctly while grandfathered.
   */
  kind: "plan" | "managed" | "legacy";
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
  /** Markets whose price is a planning figure, not a decision. Listed in STATUS.md. */
  provisional?: Market[];
  features: Feature[];
  recommended?: boolean;
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

const STARTER_FEATURES: Feature[] = [
  { text: "Keep your number — forward it to Belline", status: "live" },
  { text: "Books and changes appointments against your real availability", status: "live" },
  { text: "Answers questions from your own hours, prices and policies", status: "live" },
  { text: "Summary and full transcript of every call and chat", status: "live" },
  { text: "Puts urgent calls through to your team, live", status: "live" },
  { text: "A reminder text the day before every booking", status: "live" },
  { text: "Your team can take over any chat from the inbox", status: "live" },
  { text: "Your own words and colours on the website buttons", status: "live" },
  DEPOSITS,
];

const BUSINESS_FEATURES: Feature[] = [
  ...STARTER_FEATURES,
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

const PRO_FEATURES: Feature[] = [
  ...BUSINESS_FEATURES,
  { text: "Named contact for onboarding and changes", status: "live" },
  { text: "Priority support", status: "live" },
  INTEGRATIONS,
];

export const PRODUCTS: Product[] = [
  // --- the three plans -------------------------------------------------------
  //
  // UAE prices decided 14 September 2026: every plan clears a 44% margin at
  // typical use even on the pessimistic UAE-line costs (check:plans). The
  // other markets are planning figures for a launch 2–3 months after the UAE.
  {
    id: "everything_starter",
    kind: "plan",
    name: "Starter",
    summary: "For a venue that wants every call and message answered properly.",
    status: "live",
    allowances: { phone: 200, web_voice: 100, chat: 150, whatsapp: 300 },
    prices: price(299, 65, 119, 109, 79, 109, 69, 129, 299),
    provisional: EXCEPT_AE,
    features: STARTER_FEATURES,
  },
  {
    id: "everything_business",
    kind: "plan",
    name: "Business",
    summary: "For a venue where the phone is genuinely busy.",
    status: "live",
    recommended: true,
    allowances: { phone: 600, web_voice: 200, chat: 400, whatsapp: 800 },
    prices: price(599, 129, 239, 219, 155, 219, 139, 269, 599),
    provisional: EXCEPT_AE,
    features: BUSINESS_FEATURES,
  },
  {
    id: "everything_pro",
    kind: "plan",
    name: "Pro",
    summary: "For a venue whose phone never stops.",
    status: "live",
    allowances: { phone: 1500, web_voice: 300, chat: 1000, whatsapp: 1500 },
    prices: price(1199, 259, 479, 429, 309, 429, 289, 539, 1099),
    provisional: EXCEPT_AE,
    features: PRO_FEATURES,
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

/** What each legacy plan maps to today, for links that still carry `?plan=`. */
export const LEGACY_TO_BUNDLE: Record<LegacyPlanId, PlanId> = {
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
  return product.kind === "plan" && product.status === "live" && product.prices[market] !== undefined;
}

export function sellable(market: Market): Product[] {
  return PRODUCTS.filter((p) => isSellable(p, market));
}

// ---------------------------------------------------------------------------
// A subscription's products
// ---------------------------------------------------------------------------

/**
 * Allowances across a set of products, per channel.
 *
 * A subscription is one plan today; the set is kept because a grandfathered
 * venue and a future add-on both fit it without another migration.
 * `undefined` for a channel none of them includes; `null` if any leaves it
 * uncounted (legacy only); otherwise the sum.
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
 * What one billing period costs, minor units.
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
 * Exactly one live plan sold in the market. The checkout, the API and the
 * Stripe webhook all ask this, so none of them can accept what another would
 * refuse.
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

// ---------------------------------------------------------------------------
// Moving up
// ---------------------------------------------------------------------------

export interface Recommendation {
  products: ProductId[];
  name: string;
  monthly: number;
}

/**
 * The cheapest plan that would carry this usage, if it is a move up.
 *
 * Used to say "you want Business" rather than "you are over" — the second is
 * a complaint, the first is an answer. It never shrinks a channel the venue
 * already has, and never points downwards off the back of one quiet month.
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
      if (!keep.has(channel) && need(channel) === 0) continue;
      if (amount === undefined) return false;
      if (amount !== null && need(channel) > amount) return false;
      const before = had[channel];
      if (candidate && amount !== null && typeof before === "number" && amount < before) return false;
    }
    return true;
  };

  if (current.length > 0 && fits(current, false)) return null;

  let best: Recommendation | null = null;
  for (const plan of sellable(market)) {
    const ids = [plan.id];
    if (!fits(ids, true)) continue;
    const monthly = monthlyOf(ids, market);
    if (!best || monthly < best.monthly) best = { products: ids, name: plan.name, monthly };
  }
  if (!best) return null;

  const priced = current.every((id) => productById(id).prices[market] !== undefined);
  const now = priced && current.length ? monthlyOf(current, market) : 0;
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

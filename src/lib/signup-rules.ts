/**
 * The rules a signup is held to, in one place the browser can import too.
 *
 * The checkout asks what the business does, and the answer has to mean the
 * same thing to the form, to the server, to the words the agent uses and to
 * a report months later. So the list the customer sees, the engine each
 * option runs on, and the aliases old links still arrive with all live here,
 * and check:signup fails if they drift.
 *
 * Pure data and pure functions: no `node:*`, no store.
 */

import type { Vertical } from "./types";

/**
 * What kind of business, as an optional prefill.
 *
 * Belline is for any business that takes calls or bookings, so this is not a
 * gate: leaving it empty is a valid answer and gets the appointment diary,
 * which is what most businesses keep.
 *
 * The engine knows two shapes and no more — a room full of tables, and a
 * diary of people's time — so every option maps onto one of them. What the
 * customer actually picked is kept as well, in `key`, because a vet and a car
 * garage are one engine and two quite different businesses, and a report that
 * can only say "salon" cannot tell them apart.
 */
export interface Trade {
  /** Stored on the location, and what a report groups by. */
  key: string;
  label: string;
  /** The engine it runs on. A table is not an appointment. */
  vertical: Vertical;
  /** The group it sits under on the checkout's list. */
  group: string;
}

export const TRADES: Trade[] = [
  { key: "salon", label: "Salon, spa or beauty", vertical: "salon", group: "Beauty and wellbeing" },
  { key: "barber", label: "Barber", vertical: "salon", group: "Beauty and wellbeing" },
  { key: "gym", label: "Gym, studio or fitness", vertical: "salon", group: "Beauty and wellbeing" },
  { key: "clinic", label: "Clinic or dental practice", vertical: "clinic", group: "Health" },
  { key: "medical", label: "Medical or health service", vertical: "clinic", group: "Health" },
  { key: "vet", label: "Vet", vertical: "clinic", group: "Health" },
  { key: "restaurant", label: "Restaurant or café", vertical: "restaurant", group: "Food and hospitality" },
  { key: "hotel", label: "Hotel or guest house", vertical: "restaurant", group: "Food and hospitality" },
  { key: "events", label: "Events or venue hire", vertical: "restaurant", group: "Food and hospitality" },
  { key: "home_services", label: "Home services (cleaning, maintenance, moving)", vertical: "salon", group: "Home and trades" },
  { key: "trades", label: "Trades (plumber, electrician, AC)", vertical: "salon", group: "Home and trades" },
  { key: "garage", label: "Car garage or car services", vertical: "salon", group: "Home and trades" },
  { key: "property", label: "Real estate or property", vertical: "salon", group: "Professional and other" },
  { key: "professional", label: "Professional services (legal, accounting, consulting)", vertical: "salon", group: "Professional and other" },
  { key: "education", label: "Education, tuition or nursery", vertical: "salon", group: "Professional and other" },
  { key: "retail", label: "Retail or showroom", vertical: "salon", group: "Professional and other" },
];

/** The groups, in the order the list gives them, for a grouped select. */
export const TRADE_GROUPS: string[] = [...new Set(TRADES.map((t) => t.group))];

/**
 * The engine a business gets when it tells us nothing.
 *
 * An appointment diary: it is what most businesses keep, and it is the
 * forgiving wrong answer. A restaurant given a diary can still take a
 * request; a salon given tables cannot book anybody.
 */
export const DEFAULT_VERTICAL: Vertical = "salon";

/**
 * What an older link or an older stored value means now.
 *
 * The three values every venue was signed up with before this list existed
 * are here and resolve to themselves, so nothing already in the database
 * stops making sense. The rest are the words people actually put in a
 * `?trade=` link.
 */
const TRADE_ALIASES: Record<string, string> = {
  // The three the engine has always had. These must never stop resolving.
  salon: "salon",
  salons: "salon",
  spa: "salon",
  beauty: "salon",
  clinic: "clinic",
  clinics: "clinic",
  dental: "clinic",
  dentist: "clinic",
  physio: "clinic",
  restaurant: "restaurant",
  restaurants: "restaurant",
  cafe: "restaurant",
  café: "restaurant",
  // The rest of the list, and the obvious words for each.
  barber: "barber",
  barbers: "barber",
  gym: "gym",
  fitness: "gym",
  medical: "medical",
  health: "medical",
  vet: "vet",
  vets: "vet",
  veterinary: "vet",
  hotel: "hotel",
  hotels: "hotel",
  events: "events",
  venue: "events",
  home_services: "home_services",
  "home-services": "home_services",
  cleaning: "home_services",
  maintenance: "home_services",
  trades: "trades",
  plumber: "trades",
  electrician: "trades",
  ac: "trades",
  garage: "garage",
  car: "garage",
  property: "property",
  "real-estate": "property",
  realestate: "property",
  professional: "professional",
  legal: "professional",
  accounting: "professional",
  consulting: "professional",
  education: "education",
  tuition: "education",
  nursery: "education",
  retail: "retail",
  showroom: "retail",
};

export function tradeByKey(key: unknown): Trade | undefined {
  return typeof key === "string" ? TRADES.find((t) => t.key === key.trim().toLowerCase()) : undefined;
}

/** A landing page's `?trade=`, or "" when it names nothing we know. Never a default. */
export function tradeFromParam(value: unknown): string {
  if (typeof value !== "string") return "";
  return TRADE_ALIASES[value.trim().toLowerCase()] ?? "";
}

/**
 * The engine to run this trade on.
 *
 * Anything unrecognised — including nothing at all, which is what "Something
 * else" sends — gets the appointment diary rather than an error. The question
 * is optional, so it cannot be a way to fail a signup.
 */
export function verticalForTrade(value: unknown): Vertical {
  return tradeByKey(tradeFromParam(value))?.vertical ?? DEFAULT_VERTICAL;
}

/** What to show for a stored trade: its label, or the engine's own word for older venues. */
export function tradeLabel(key: unknown, vertical: Vertical): string {
  const trade = tradeByKey(key);
  if (trade) return trade.label;
  return vertical === "restaurant" ? "Restaurant or café" : vertical === "clinic" ? "Clinic or dental practice" : "Appointments";
}

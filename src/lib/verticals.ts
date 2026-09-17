import type { Location, Vertical } from "./types";
import { tradeByKey } from "./signup-rules";

/**
 * What kind of business this is, and what it calls things.
 *
 * A salon and a clinic are the same scheduling problem — qualified people,
 * timed services, shared rooms, cleanup buffers — so they run on one engine.
 * What actually differs is the language. A clinic that hears "stylist" or
 * "guest" from its own phone line has already lost the room, and the words
 * reach the caller through the system prompt, so they belong in code rather
 * than in a hand-edited prompt per venue.
 */

export interface Terms {
  /** One customer: guest / client / patient. */
  guest: string;
  guests: string;
  /** The person performing the work. */
  staff: string;
  staffPlural: string;
  /** What is booked. */
  service: string;
  services: string;
  /** The booking itself. */
  booking: string;
  /** The business. */
  venue: string;
  /** The venue-type chip in the dashboard (`venueChip`), or "" when there should be none. */
  label: string;
}

const TERMS: Record<Vertical, Terms> = {
  restaurant: {
    guest: "guest",
    guests: "guests",
    staff: "host",
    staffPlural: "the floor team",
    service: "table",
    services: "tables",
    booking: "reservation",
    venue: "restaurant",
    label: "restaurant",
  },
  salon: {
    guest: "client",
    guests: "clients",
    staff: "stylist",
    staffPlural: "stylists",
    service: "service",
    services: "services",
    booking: "appointment",
    venue: "salon",
    label: "salon",
  },
  clinic: {
    guest: "patient",
    guests: "patients",
    staff: "practitioner",
    staffPlural: "practitioners",
    service: "treatment",
    services: "treatments",
    booking: "appointment",
    venue: "clinic",
    label: "clinic",
  },
};

/**
 * The trades whose own words the salon engine already speaks.
 *
 * Seventeen trades run on three engines, and the diary engine is called
 * "salon" because salons came first — not because a property developer, a
 * tutor or a garage keeps stylists. A trade outside this set that runs on the
 * diary gets plain words instead ("team", "services", "bookings"): neutral is
 * never wrong, and "our stylists" on a law firm's line is.
 */
const BEAUTY_TRADES = new Set(["salon", "barber"]);

/**
 * The venue-type chip, short enough for a pill. Keyed by trade (signup-rules.ts
 * `TRADES`); the list's own labels are written for a select, and "Professional
 * services (legal, accounting, consulting)" does not fit beside a venue name.
 */
const TRADE_CHIPS: Record<string, string> = {
  salon: "Salon or spa",
  barber: "Barber",
  gym: "Gym or studio",
  clinic: "Clinic",
  medical: "Medical",
  vet: "Vet",
  restaurant: "Restaurant",
  hotel: "Hotel",
  events: "Events",
  home_services: "Home services",
  trades: "Trades",
  garage: "Car services",
  property: "Real estate",
  professional: "Professional services",
  education: "Education",
  retail: "Retail",
};

const NEUTRAL: Omit<Terms, "label"> = {
  guest: "client",
  guests: "clients",
  staff: "team member",
  staffPlural: "the team",
  service: "service",
  services: "services",
  booking: "booking",
  venue: "business",
};

export function terms(location: Location): Terms {
  const trade = tradeByKey(location.tradeKey);
  const chip = venueChip(location) ?? "";
  // Only a diary venue that told us its trade, and whose trade is not beauty,
  // is re-worded. Restaurants and clinics keep their words; a venue with no
  // trade keeps the engine's, because that is what it was set up with and what
  // its agent has always said.
  if (location.vertical === "salon" && trade && !BEAUTY_TRADES.has(trade.key)) {
    return { ...NEUTRAL, label: chip };
  }
  return { ...TERMS[location.vertical], label: chip };
}

/**
 * What the owner sees on the venue chip: the business's own type, or nothing.
 *
 * The trade picked at signup when there is one. Without one, only an engine
 * that was chosen on purpose is worth showing: "restaurant" and "clinic" are
 * never anybody's default, but "salon" is what every unknown business runs on
 * (signup-rules.ts `DEFAULT_VERTICAL`), so a bare "salon" chip would call an
 * estate agent a salon. A demo line is the exception — Belline built it as the
 * engine it is, to let a prospect hear their own trade.
 */
export function venueChip(location: Pick<Location, "vertical" | "tradeKey" | "demo">): string | null {
  const trade = tradeByKey(location.tradeKey);
  if (trade) return TRADE_CHIPS[trade.key] ?? trade.label;
  if (location.vertical === "restaurant") return "Restaurant";
  if (location.vertical === "clinic") return "Clinic";
  return location.demo ? "Salon" : null;
}

export function isRestaurant(location: Location): boolean {
  return location.vertical === "restaurant";
}

/**
 * True for the verticals whose availability is a person's diary rather than a
 * room full of tables. Prefer this over `vertical === "salon"` — a clinic must
 * take the same branch, and a new vertical of the same shape should too.
 */
export function usesStaffDiary(location: Location): boolean {
  return location.vertical === "salon" || location.vertical === "clinic";
}

/** Deepgram caps the list, and the tail of it is the least useful part. */
const MAX_KEYTERMS = 40;

/**
 * The words this venue says that a general speech model has never met: its own
 * name, the sections of its room, its treatments, the people who work there.
 *
 * Every one of these is a word the caller will say early and the agent must
 * get right — a misheard stylist's name derails the whole booking, and the
 * caller experiences it as not being listened to rather than as a
 * transcription error.
 */
export function speechKeyterms(location: Location): string[] {
  const out = new Set<string>();

  for (const word of location.name.split(/\s+/)) {
    // Single letters and "The" boost nothing and crowd out real terms.
    if (word.length > 2) out.add(word);
  }
  out.add(location.agent.displayName);

  for (const table of location.restaurant?.tables ?? []) out.add(table.section);
  for (const service of location.restaurant?.services ?? []) out.add(service.name);

  for (const service of location.salon?.services ?? []) out.add(service.name);
  for (const person of location.salon?.staff ?? []) out.add(person.name);
  for (const resource of location.salon?.resources ?? []) out.add(resource.name);

  return [...out].filter((t) => t.trim().length > 2).slice(0, MAX_KEYTERMS);
}

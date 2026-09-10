import type { Location, Vertical } from "./types";

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
  /** Short label for the venue-type chip in the dashboard. */
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

export function terms(location: Location): Terms {
  return TERMS[location.vertical];
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

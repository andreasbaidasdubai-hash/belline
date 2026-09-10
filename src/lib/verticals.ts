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

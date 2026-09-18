import type { DestinationKind, Location } from "../types";
import { flag } from "../flags";

/**
 * Where this venue's bookings go, without loading the booking engine.
 *
 * Kept apart from provider.ts so the prompt and the setup pages can ask the
 * question without importing the diary, the store and the holds.
 *
 * No destination recorded means Belline's own diary: every venue that predates
 * the journey runs on it, and the backfill says so explicitly.
 */
export function destinationOf(location: Pick<Location, "onboarding">): DestinationKind {
  return location.onboarding?.destination?.kind ?? "belline";
}

/**
 * Does this venue run on Belline's own diary: the calendar, rota, waitlist,
 * recall, staff, rooms and turnaround?
 *
 * `destinationOf` answers "belline" for a venue with no destination, because
 * every venue that predates the journey ran on the diary and the backfill
 * writes that down. A new signup also has no destination until it reaches the
 * bookings step, and it is not on the diary: since the pivot the diary is
 * offered only to accounts that already use it. So a venue with a journey
 * record and no destination yet is not a diary venue.
 */
export function onBellineDiary(location: Pick<Location, "onboarding">): boolean {
  if (location.onboarding && !location.onboarding.destination) return false;
  return destinationOf(location) === "belline";
}

type Venue = Pick<Location, "onboarding"> & {
  google?: Location["google"];
  outlook?: Location["outlook"];
  calendly?: Location["calendly"];
};

/**
 * Can Belline book into this venue's Google Calendar right now?
 *
 * The flag is on, a sealed token is stored, Google has not stopped accepting
 * it, and Google is not refusing Belline's own project (the Calendar API
 * switched off, say). Any of them missing and the venue takes requests.
 */
export function googleUsable(location: Venue, env: Record<string, string | undefined> = process.env): boolean {
  const link = location.google;
  return Boolean(link?.sealedToken && !link.expiredAt && !link.misconfiguredAt && flag("booking.google", env));
}

/**
 * Can Belline book into this venue's Outlook calendar right now? The same four
 * conditions as Google, against `booking.outlook` and the Outlook link.
 */
export function outlookUsable(location: Venue, env: Record<string, string | undefined> = process.env): boolean {
  const link = location.outlook;
  return Boolean(link?.sealedToken && !link.expiredAt && !link.misconfiguredAt && flag("booking.outlook", env));
}

/**
 * Can Belline book into this venue's Calendly right now?
 *
 * The same four conditions as Google's and Outlook's — flag on, sealed token,
 * not expired, not refused because of Belline's own application — plus two that
 * are Calendly's alone, because Calendly can be perfectly connected and still
 * unable to take a booking:
 *
 * - **the plan.** Creating an invitee through Calendly's API needs a paid
 *   Calendly plan. A Free account connects and reads; it cannot be booked into,
 *   and `planBlockedAt` is set the first time Calendly says so.
 * - **something to book.** Calendly books event types, so an account with none
 *   left (they were all deleted or deactivated) has nothing Belline can offer.
 *
 * Any of them missing and the venue takes requests.
 */
export function calendlyUsable(location: Venue, env: Record<string, string | undefined> = process.env): boolean {
  const link = location.calendly;
  if (!link?.sealedToken || link.expiredAt || link.misconfiguredAt || link.planBlockedAt) return false;
  if (!(link.eventTypes ?? []).some((e) => e.active)) return false;
  return flag("booking.calendly", env);
}

/**
 * Does this venue take requests rather than confirmed bookings?
 *
 * Partner systems count as requests until their adapters exist. Google, Outlook
 * and Calendly count as requests whenever their connection is not usable — flag
 * off, never connected, or the token expired — so a calendar Belline cannot
 * see is never booked into. An owner who chose one is not told it works; the
 * agent takes the details and the team confirms.
 */
export function takesRequestsOnly(location: Venue): boolean {
  const kind = destinationOf(location);
  if (kind === "belline") return false;
  if (kind === "google") return !googleUsable(location);
  if (kind === "outlook") return !outlookUsable(location);
  if (kind === "calendly") return !calendlyUsable(location);
  return true;
}

/**
 * Must the agent take an email address before it can book?
 *
 * `Location.requiresEmail` is the owner's own answer, for a venue whose booking
 * *is* something sent. Calendly adds a second reason that is not the owner's to
 * decide: `POST /invitees` will not take a booking without an address, and the
 * confirmation, the reschedule link and the cancellation link all go to it. So
 * a venue booking into Calendly always asks, whatever the owner set — and a
 * caller who will not give one is taken as a request rather than promised a
 * time Belline cannot actually make.
 */
export function needsGuestEmail(location: Pick<Location, "requiresEmail"> & Venue): boolean {
  return Boolean(location.requiresEmail) || (destinationOf(location) === "calendly" && calendlyUsable(location));
}

/**
 * Does each service need a length?
 *
 * Only where Belline fits the appointment into a day itself: its own diary,
 * or a Google Calendar it books into (the same engine, with the calendar's
 * busy times taken out). A business that confirms its own bookings — requests,
 * a booking link, a calendar Belline cannot book into yet — is never offered a
 * time, so "how long does a property development take?" is not a question
 * setup should ask.
 *
 * A new account reviews its business before it chooses where bookings go.
 * Until it chooses, nothing is required; choosing the diary afterwards lists
 * any service without a length as missing before Go live (onboarding
 * `readiness`), and the diary never offers a time for one.
 */
export function serviceLengthsRequired(location: Venue): boolean {
  if (location.onboarding && !location.onboarding.destination) return false;
  return !takesRequestsOnly(location);
}

/**
 * Does this venue have diary settings to edit (Your business → Diary settings)?
 *
 * The rota, rooms, turnaround and recall are the diary's, so a venue on
 * Belline's own diary has them. A restaurant that books into its own Google or
 * Outlook calendar is booked by the same engine, which cannot offer a table
 * without its tables and sittings, so it keeps that page too. A salon, clinic
 * or trade booking into its calendar needs only who uses which calendar, and
 * sets that on the Calendars page.
 */
export function diarySettingsApply(location: Venue & Pick<Location, "vertical">): boolean {
  return onBellineDiary(location) || (location.vertical === "restaurant" && serviceLengthsRequired(location));
}

/** The owner's own booking link, when they gave one. */
export function bookingLinkOf(location: Pick<Location, "onboarding">): string | undefined {
  return takesRequestsOnly(location) ? location.onboarding?.destination?.bookingLink : undefined;
}

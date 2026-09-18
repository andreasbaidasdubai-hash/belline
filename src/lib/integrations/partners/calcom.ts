import { openCredentials } from "../../db/credentials";
import { zonedInstant } from "../google-api";
import {
  PartnerNotConnected,
  PartnerUnsupported,
  partnerLinkOf,
  partnerMode,
  type PartnerApi,
  type PartnerAvailabilityQuery,
  type PartnerBookingRef,
  type PartnerConnector,
  type PartnerCreate,
  type PartnerSlot,
  type PartnerVenue,
} from "./contract";
import { baseUrlFor, httpTransport, type PartnerTransport } from "./http";
import { PARTNERS } from "./registry";
import { sandboxPartner } from "./sandbox";

/**
 * Cal.com API v2.
 *
 * The one partner on this list with nobody to ask. Open source, publicly
 * documented, and the key is one the venue's own account holder makes in their
 * settings — so unlike every other adapter here, this one could be pointed at a
 * real account the day somebody wants it. That is also the reason to be careful
 * with it: there is no partner review standing between a mistake here and a
 * customer's diary.
 *
 * This is the second worked example of the **booking page** shape that Calendly
 * established, and the shape is the important part. Google and Outlook hand
 * Belline a diary and let its own rules decide what can be booked. A booking
 * page hands Belline the owner's *event types*, and each one carries its own
 * length, availability, buffers, notice and caps. Belline asks which times an
 * event type has open and books one of them. It cannot invent a time, a length,
 * or an appointment that is not one of the owner's event types.
 *
 * Where Cal.com differs from Calendly is written out in registry.ts; the two
 * that shape this file are that Cal.com has a real reschedule endpoint, and
 * that it can be self-hosted, so the base URL belongs to the venue.
 *
 * ## The version header
 *
 * Every endpoint is pinned to a dated contract, the dates differ per endpoint,
 * and Cal.com's own documentation says that sending the wrong value — or none —
 * silently falls back to an older version of that endpoint. That is worse than
 * an error: the call succeeds and quietly means something else. So the versions
 * live in one table below, every request carries one, and `check:calcom` fails
 * if a request is ever sent without it.
 *
 * ## Time
 *
 * `POST /v2/bookings` takes `start` as an instant in UTC. "Tuesday at ten" is
 * not an instant until somebody says where, and Belline will not decide that
 * for a venue: the zone is recorded on the venue (`partners.calcom.timeZone`)
 * and a venue without one is not connected. Slots are asked for in that same
 * zone and read back as wall time, so the round trip never passes through a
 * Belline guess about anybody's offset.
 */

const facts = PARTNERS.calcom;

const PRODUCTION = "https://api.cal.com/v2/";

/**
 * The dated contract each endpoint is pinned to.
 *
 * These are not interchangeable and they are not decoration. Cal.com documents
 * that an absent or wrong `cal-api-version` falls back to an older version of
 * the endpoint rather than failing, so dropping one here would not break a
 * check — it would change what the API means, months later, on somebody's
 * booking. Each is the version this adapter was written against.
 */
export const CALCOM_API_VERSIONS = {
  slots: "2024-09-04",
  bookings: "2026-02-25",
  eventTypes: "2024-06-14",
} as const;

interface CalSlot {
  start: string;
  end: string;
}

interface CalBooking {
  id?: number;
  uid?: string;
  start?: string;
  end?: string;
  status?: string;
}

/** Cal.com answers `{ status, data }`; only `data` is ever read. */
interface CalEnvelope<T> {
  status?: string;
  data?: T;
}

/** "2050-09-05T09:00:00.000+02:00" → "2050-09-05". The wall date, not a UTC one. */
const dateOf = (value: string): string => value.slice(0, 10);

/** …and the wall minute of that day, in whatever zone the slot was asked for. */
export function minutesOf(value: string): number {
  const m = /T(\d{2}):(\d{2})/.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

/** A venue's wall time as the instant Cal.com books, through the venue's own zone. */
export function instantOf(date: string, startMin: number, timeZone: string): string {
  return new Date(zonedInstant(date, startMin, timeZone)).toISOString();
}

export interface CalcomContext {
  /** The IANA zone this account answers in. Required: Cal.com books instants. */
  timeZone: string;
}

export function calcomApi(transport: PartnerTransport, context: CalcomContext): PartnerApi {
  const { timeZone } = context;

  return {
    async availability(query: PartnerAvailabilityQuery): Promise<PartnerSlot[]> {
      // An event type is the service. Cal.com cannot answer "what is free on
      // Tuesday" without one, and Belline does not answer it for them.
      const eventTypeId = query.serviceIds?.[0];
      if (!eventTypeId) return [];
      const answer = await transport.request<CalEnvelope<Record<string, CalSlot[]>>>({
        method: "GET",
        path: "slots",
        headers: { "cal-api-version": CALCOM_API_VERSIONS.slots },
        query: {
          eventTypeId,
          start: query.date,
          end: query.date,
          timeZone,
          // Ask for start *and* end, so the appointment's length is Cal.com's
          // and never a Belline assumption about the event type.
          format: "range",
        },
      });
      // The response is keyed by date; only the day that was asked for is used,
      // because a slot on another day is not an answer to this question.
      const slots = answer.data?.[query.date] ?? [];
      return slots
        .map((slot): PartnerSlot => ({
          date: dateOf(slot.start),
          startMin: minutesOf(slot.start),
          endMin: minutesOf(slot.end),
          // Cal.com's slots carry no host: a solo event type has one by
          // definition and a round-robin one is not decided until the booking
          // is made. Belline therefore never names a person from here.
          token: slot.start,
        }))
        .filter((s) => s.date === query.date && Number.isFinite(s.startMin) && Number.isFinite(s.endMin));
    },

    async create(input: PartnerCreate): Promise<PartnerBookingRef> {
      const eventTypeId = input.serviceIds?.[0];
      if (!eventTypeId) throw new PartnerUnsupported("calcom", "Cal.com needs the event type before it can take a booking");
      // Cal.com will not take a booking without an address, and it is where the
      // confirmation and the cancel link go. Refusing here is what makes the
      // agent ask for one rather than fail in front of a guest.
      if (!input.guestEmail?.trim()) {
        throw new PartnerUnsupported("calcom", "Cal.com needs an email address for the confirmation before it can take a booking");
      }
      const made = await transport.request<CalEnvelope<CalBooking>>({
        method: "POST",
        path: "bookings",
        headers: { "cal-api-version": CALCOM_API_VERSIONS.bookings },
        body: {
          eventTypeId: Number(eventTypeId),
          // The exact instant Cal.com offered, where it offered one. Belline's
          // own conversion is the fallback, never the first choice.
          start: input.token ?? instantOf(input.date, input.startMin, timeZone),
          attendee: {
            name: input.guestName,
            email: input.guestEmail.trim(),
            timeZone,
            phoneNumber: input.guestPhone,
          },
          metadata: {},
        },
      });
      // The uid is what every other endpoint takes, and what a guest would read
      // off their confirmation. The numeric id is Cal.com's own and is not it.
      const uid = made.data?.uid;
      if (!uid) throw new Error("Cal.com did not return the booking it made");
      return { id: uid, ref: uid };
    },

    async reschedule(ref, changes): Promise<PartnerBookingRef> {
      // A real endpoint, and the clearest difference from Calendly: the guest
      // keeps one booking rather than getting a cancellation and a new one.
      const moved = await transport.request<CalEnvelope<CalBooking>>({
        method: "POST",
        path: `bookings/${encodeURIComponent(ref.id)}/reschedule`,
        headers: { "cal-api-version": CALCOM_API_VERSIONS.bookings },
        body: { start: instantOf(changes.date, changes.startMin, timeZone) },
      });
      // Cal.com issues a new uid for the moved booking; the old one is no
      // longer the booking, so the mirror must follow this one.
      const uid = moved.data?.uid ?? ref.id;
      return { id: uid, ref: uid };
    },

    async cancel(ref, reason): Promise<void> {
      await transport.request<CalEnvelope<CalBooking>>({
        method: "POST",
        path: `bookings/${encodeURIComponent(ref.id)}/cancel`,
        headers: { "cal-api-version": CALCOM_API_VERSIONS.bookings },
        body: { cancellationReason: reason?.trim() || "Cancelled at the guest's request." },
      });
    },
  };
}

export const calcomConnector: PartnerConnector = {
  facts,

  linked(location: PartnerVenue): boolean {
    return Boolean(partnerLinkOf(location, "calcom")?.venueId);
  },

  usable(location: PartnerVenue, env = process.env): boolean {
    const mode = partnerMode(facts, env);
    if (mode === "off") return false;
    const link = partnerLinkOf(location, "calcom");
    if (!link?.venueId || link.expiredAt || link.misconfiguredAt) return false;
    if (mode === "sandbox") return true;
    // Live needs the account holder's own key, and the zone their calendar
    // answers in. Cal.com books an instant, and Belline will not pick one.
    return Boolean(link.sealedToken) && Boolean(link.timeZone);
  },

  apiFor(location: PartnerVenue, env = process.env): PartnerApi | null {
    if (!this.usable(location, env)) return null;
    const link = partnerLinkOf(location, "calcom")!;
    if (partnerMode(facts, env) === "sandbox") {
      return sandboxPartner(facts, { opens: 9 * 60, closes: 17 * 60, stepMin: 30, staff: [] });
    }
    // The key belongs to the venue's own Cal.com account, not to Belline, so it
    // is sealed on the location and never read from env.
    const key = openCredentials(link.sealedToken!).apiKey;
    if (!key) throw new PartnerNotConnected("calcom", "this venue's Cal.com account has not issued Belline a key");
    const timeZone = link.timeZone;
    if (!timeZone) throw new PartnerNotConnected("calcom", "this venue has not recorded the time zone its Cal.com answers in");

    // A self-hosted Cal.com lives wherever the venue put it. The env override
    // is the deployment's; this one is the venue's own.
    const base = link.baseUrl?.trim() || baseUrlFor(facts, PRODUCTION, env);
    const transport = httpTransport(facts, { baseUrl: base, auth: { Authorization: `Bearer ${key}` } });
    return calcomApi(transport, { timeZone });
  },

  refFields(ref: PartnerBookingRef) {
    return { partnerBookingId: ref.id, partnerRef: ref.ref };
  },
};

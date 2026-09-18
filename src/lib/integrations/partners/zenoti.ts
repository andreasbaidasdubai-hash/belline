import { openCredentials } from "../../db/credentials";
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
 * Zenoti, as documented at docs.zenoti.com and read on 2026-09-18.
 *
 * The flow is a cart, not a calendar:
 *
 *   POST /v1/bookings                             the guest, the centre, the services
 *   GET  /v1/bookings/{id}/slots                  what the centre will actually take
 *   POST /v1/bookings/{id}/slots/reserve          hold it while the guest decides
 *   POST /v1/bookings/{id}/slots/confirm          it is now the salon's appointment
 *
 * That suits a telephone call better than a single create would: the reserve
 * is the ninety seconds between "ten o'clock is free" and "yes please", which
 * Belline's own diary spends on a local hold (booking/holds.ts).
 *
 * The credential is the salon's, not ours. Zenoti has no third-party OAuth:
 * each centre's admin buys the API package and mints an unrestricted key. It is
 * sealed on the venue with every other credential and opened here, per call,
 * and it never appears in a log or in env.
 *
 * Nothing in this file has run against Zenoti. No salon has issued Belline a
 * key, so `apiFor` returns the sandbox at best and null in every real
 * deployment. Two calls are marked UNVERIFIED below: they are the guest
 * lookup, whose exact shape the research could not confirm, and the invoice
 * cancellation. Both must be checked against a live tenant before
 * `FLAG_BOOKING_PARTNER_ZENOTI=on` is ever set, and the registry's `limits`
 * say so too.
 */

const facts = PARTNERS.zenoti;

/** The documented production host. A sandbox tenant sets PARTNER_ZENOTI_BASE_URL. */
const PRODUCTION = "https://api.zenoti.com/v1/";

interface ZenotiSlot {
  Time: string;
  Available?: boolean;
  Warnings?: unknown[];
}

interface ZenotiBookingCreated {
  id: string;
}

interface ZenotiConfirmed {
  invoice_id?: string;
  /** Zenoti's own reference for the guest, where it returns one. */
  confirmation_id?: string;
}

/** "2026-09-20T14:30:00" → 870. Zenoti times are local to the centre. */
function minutesOf(time: string): number {
  const m = /T(\d{2}):(\d{2})/.exec(time);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

function iso(date: string, startMin: number): string {
  const hh = String(Math.floor(startMin / 60)).padStart(2, "0");
  const mm = String(startMin % 60).padStart(2, "0");
  return `${date}T${hh}:${mm}:00`;
}

export function zenotiApi(transport: PartnerTransport, centreId: string): PartnerApi {
  /**
   * The guest's Zenoti record, which a booking cannot be made without.
   *
   * UNVERIFIED. Zenoti documents guests as a resource, but the exact search
   * and create shapes were not confirmed against the reference, and a guess
   * written confidently is how an integration ships broken. Checked against a
   * live tenant before go-live; until then this is the one part of the flow a
   * reviewer should assume is wrong.
   */
  async function guestId(input: { guestName: string; guestPhone: string; guestEmail?: string }): Promise<string> {
    const [first, ...rest] = input.guestName.trim().split(/\s+/);
    const found = await transport.request<{ guests?: { id: string }[] }>({
      method: "GET",
      path: "guests/search",
      query: { center_id: centreId, phone: input.guestPhone, size: 1 },
    });
    const existing = found.guests?.[0]?.id;
    if (existing) return existing;
    const made = await transport.request<{ id: string }>({
      method: "POST",
      path: "guests",
      body: {
        center_id: centreId,
        personal_info: {
          first_name: first,
          last_name: rest.join(" ") || first,
          mobile_phone: { number: input.guestPhone },
          email: input.guestEmail,
        },
      },
    });
    return made.id;
  }

  /** A booking cart for this guest and these services, and the slots it offers. */
  async function cartFor(query: { date: string; guestId: string; serviceIds: string[]; staffId?: string }): Promise<string> {
    const created = await transport.request<ZenotiBookingCreated>({
      method: "POST",
      path: "bookings",
      body: {
        center_id: centreId,
        date: query.date,
        // `is_only_catalog_employees` defaults to true: only staff the centre
        // publishes for online booking. Left at the default deliberately — a
        // stylist the salon does not offer online is not ours to offer.
        guests: [
          {
            id: query.guestId,
            items: query.serviceIds.map((id) => ({ item: { id }, therapist: query.staffId ? { id: query.staffId } : undefined })),
          },
        ],
      },
    });
    return created.id;
  }

  return {
    async availability(query: PartnerAvailabilityQuery): Promise<PartnerSlot[]> {
      if (!query.serviceIds?.length) {
        // Zenoti computes availability for a service, not for a day. Without
        // one there is no question to ask, and Belline offers nothing rather
        // than offering its own guess at the salon's diary.
        return [];
      }
      // No guest, no cart, no slots. Belline does not create a Zenoti guest
      // record to answer a question, and it does not answer with its own guess
      // at the salon's diary either.
      if (!query.guest?.phone) return [];
      const guest = await guestId({ guestName: query.guest.name ?? "Belline caller", guestPhone: query.guest.phone });
      const cart = await cartFor({ date: query.date, guestId: guest, serviceIds: query.serviceIds, staffId: query.staffId });
      const answer = await transport.request<{ slots?: ZenotiSlot[] }>({
        method: "GET",
        path: `bookings/${cart}/slots`,
      });
      return (answer.slots ?? [])
        .filter((s) => s.Available !== false)
        .map((s): PartnerSlot => {
          const startMin = minutesOf(s.Time);
          return { date: query.date, startMin, endMin: startMin, staffId: query.staffId, token: cart };
        })
        .filter((s) => Number.isFinite(s.startMin));
    },

    async create(input: PartnerCreate): Promise<PartnerBookingRef> {
      if (!input.serviceIds?.length) throw new PartnerUnsupported("zenoti", "Zenoti needs the service before it can take a booking");
      const guest = await guestId(input);
      const cart = input.token ?? (await cartFor({ date: input.date, guestId: guest, serviceIds: input.serviceIds, staffId: input.staffId }));
      await transport.request({
        method: "POST",
        path: `bookings/${cart}/slots/reserve`,
        body: { slot_time: iso(input.date, input.startMin) },
      });
      // Zenoti has no idempotency key. The reserve/confirm pair means an
      // unconfirmed cart is inert, and the provider above has already checked
      // its own key, so a retry cannot reach here with the same booking.
      const confirmed = await transport.request<ZenotiConfirmed>({
        method: "POST",
        path: `bookings/${cart}/slots/confirm`,
        body: { notes: input.notes },
      });
      return { id: confirmed.invoice_id ?? cart, ref: confirmed.confirmation_id };
    },

    async reschedule(): Promise<PartnerBookingRef> {
      // Zenoti's own documentation describes rescheduling as cancel, then book
      // again. Belline will not cancel a guest's appointment on the chance the
      // new time is still there thirty seconds later.
      throw new PartnerUnsupported("zenoti", "Zenoti has no reschedule; moving an appointment means cancelling it first");
    },

    async cancel(ref: PartnerBookingRef, reason?: string): Promise<void> {
      // UNVERIFIED: documented at the invoice rather than the appointment, and
      // `comments` is mandatory on some tenants and optional on others.
      await transport.request({
        method: "PUT",
        path: `invoices/${ref.id}/cancel`,
        body: { comments: reason ?? "Cancelled by the guest through Belline" },
      });
    },
  };
}

export const zenotiConnector: PartnerConnector = {
  facts,

  linked(location: PartnerVenue): boolean {
    return Boolean(partnerLinkOf(location, "zenoti")?.venueId);
  },

  usable(location: PartnerVenue, env = process.env): boolean {
    const mode = partnerMode(facts, env);
    if (mode === "off") return false;
    const link = partnerLinkOf(location, "zenoti");
    if (!link?.venueId || link.expiredAt || link.misconfiguredAt) return false;
    // Live needs the centre's own key. The sandbox has no salon behind it.
    return mode === "sandbox" || Boolean(link.sealedToken);
  },

  apiFor(location: PartnerVenue, env = process.env): PartnerApi | null {
    if (!this.usable(location, env)) return null;
    const link = partnerLinkOf(location, "zenoti")!;
    if (partnerMode(facts, env) === "sandbox") {
      return sandboxPartner(facts, { opens: 9 * 60, closes: 18 * 60, stepMin: 60 });
    }
    const key = openCredentials(link.sealedToken!).apiKey;
    if (!key) throw new PartnerNotConnected("zenoti", "the centre's Zenoti key is missing from its sealed credentials");
    return zenotiApi(
      httpTransport(facts, { baseUrl: baseUrlFor(facts, PRODUCTION, env), auth: { authorization: `apikey ${key}` } }),
      link.venueId!,
    );
  },

  refFields(ref: PartnerBookingRef) {
    return { partnerBookingId: ref.id, partnerRef: ref.ref };
  },
};

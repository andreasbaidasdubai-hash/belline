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
 * Eat App's Partner API.
 *
 * The first restaurant reservation system Belline can actually build against.
 * OpenTable's endpoint reference is behind an application and its sandbox
 * excludes booking; SevenRooms' documentation went behind a login in February.
 * Eat App publishes both endpoints a booking channel needs, in its own help
 * centre, with a named sandbox host:
 *
 *   GET  /partners/v2/availability      time_slots for a date and a party size
 *   POST /partners/v2/reservations
 *
 * ## This is a restaurant, and the adapter is shaped like one
 *
 * The note at the foot of registry.ts exists to stop a restaurant being
 * modelled as a salon with tables, and this file is where it is obeyed:
 *
 * - **Party size is the question, not a detail.** `guests` is required. Asked
 *   without one, this returns no times rather than the times for a party of
 *   some number Belline picked. "Is 19:00 free?" has no answer.
 * - **The house sets the length.** Eat App adjusts the reservation duration by
 *   the number of covers, so Belline never sends a duration and never infers
 *   one from a slot.
 * - **Nobody asks for a waiter.** `staffId` is not sent, not read, and
 *   `facts.api.staffSelection` is false, so the agent is never given the tool.
 * - **The sitting is the shift**, and a slot carries it where Eat App names one.
 *
 * ## What it cannot do, and why that is written as a refusal
 *
 * Moving and cancelling exist on Eat App's *Concierge* API — a different grant,
 * issued to restaurants and vendors rather than to booking channels. So they
 * are `false` here, the agent gets no tool for them, and a guest who rings to
 * cancel is taken as a message. Belline would rather say "the restaurant will
 * call you back" than say "cancelled" and be wrong.
 *
 * And there is no hold. Eat App publishes no slot lock, so between quoting a
 * time and writing the reservation the table may be gone. The caller is told at
 * the time; nothing is pre-announced.
 *
 * ## UNVERIFIED
 *
 * The field name `time_slots`, the `guests` parameter and the 30-minute example
 * values are Eat App's own, from their help centre. The surrounding JSON:API
 * envelope and the way the restaurant is identified on the request were not
 * confirmed against a live sandbox, because Belline has no token. So `slotsIn`
 * below accepts only shapes it recognises and returns nothing for anything
 * else — a restaurant quoting no times is a restaurant taking messages, which
 * is recoverable; a restaurant quoting invented times is not.
 */

const facts = PARTNERS.eatapp;

const PRODUCTION = "https://api.eatapp.co/partners/v2/";

/** Eat App's own documented sandbox host. Nothing in it is a customer. */
export const EATAPP_SANDBOX_BASE = "https://api.eat-sandbox.co/partners/v2/";

/**
 * "19:30" → 1170. Eat App's own example values are bare wall times.
 *
 * Takes `unknown` rather than `string` on purpose: the envelope is UNVERIFIED,
 * so this is fed whatever Eat App actually sends, and a number where a time was
 * expected must be refused rather than thrown on. A parser that crashes on a
 * renamed field takes the whole evening's availability down with it.
 */
export function minutesOf(value: unknown): number {
  if (typeof value !== "string") return NaN;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return NaN;
  const hours = Number(m[1]);
  const mins = Number(m[2]);
  if (hours > 23 || mins > 59) return NaN;
  return hours * 60 + mins;
}

interface TimeSlot {
  time?: string;
  /** The sitting, where Eat App names one. */
  shift?: string;
  shift_name?: string;
  /** Handed back on the reservation where Eat App offered one. */
  preference_id?: string;
}

/**
 * The bookable times in whatever Eat App sent, or none at all.
 *
 * Deliberately strict. Two shapes are accepted because the help centre shows
 * bare strings (`"19:00"`, `"19:30"`) and the JSON:API framing implies objects:
 * a string, or an object with a `time`. Anything else — a nested envelope that
 * changed, a field renamed, a number where a time was — yields nothing, and the
 * restaurant takes messages until somebody looks. It never widens, never
 * interpolates between two slots, and never fills a gap.
 */
export function slotsIn(raw: unknown, date: string): PartnerSlot[] {
  if (!Array.isArray(raw)) return [];
  const out: PartnerSlot[] = [];
  for (const entry of raw) {
    const slot: TimeSlot | undefined =
      typeof entry === "string" ? { time: entry } : entry && typeof entry === "object" ? (entry as TimeSlot) : undefined;
    const startMin = minutesOf(slot?.time);
    if (!Number.isFinite(startMin)) continue;
    out.push({
      date,
      startMin,
      // The house decides how long a table is held, by party size, and does not
      // tell a booking channel. Belline records the start it was given and
      // never quotes an end it made up.
      endMin: startMin,
      section: slot?.shift ?? slot?.shift_name,
      token: slot?.preference_id,
    });
  }
  return out.sort((a, b) => a.startMin - b.startMin);
}

export interface EatAppContext {
  /** Eat App's own id for this restaurant. */
  restaurantId: string;
}

export function eatappApi(transport: PartnerTransport, context: EatAppContext): PartnerApi {
  return {
    async availability(query: PartnerAvailabilityQuery): Promise<PartnerSlot[]> {
      // 19:00 for two and 19:00 for six are different questions. Without the
      // party size there is no question to ask.
      if (!query.partySize || query.partySize < 1) return [];
      const answer = await transport.request<{ data?: { time_slots?: unknown }; time_slots?: unknown }>({
        method: "GET",
        path: "availability",
        query: {
          restaurant_id: context.restaurantId,
          date: query.date,
          // Eat App's word on the Partner API. The Concierge API calls the same
          // thing `covers`, and sending the wrong one books a party of nobody.
          guests: query.partySize,
        },
      });
      const slots = slotsIn(answer.data?.time_slots ?? answer.time_slots, query.date);
      return slots.filter((s) => {
        if (query.fromMin !== undefined && s.startMin < query.fromMin) return false;
        if (query.toMin !== undefined && s.startMin > query.toMin) return false;
        return true;
      });
    },

    async create(input: PartnerCreate): Promise<PartnerBookingRef> {
      if (!input.partySize || input.partySize < 1) {
        throw new PartnerUnsupported("eatapp", "Eat App needs the number of people before it can take a reservation");
      }
      const made = await transport.request<{ data?: { id?: string; reference?: string }; id?: string }>({
        method: "POST",
        path: "reservations",
        body: {
          restaurant_id: context.restaurantId,
          date: input.date,
          time: `${String(Math.floor(input.startMin / 60)).padStart(2, "0")}:${String(input.startMin % 60).padStart(2, "0")}`,
          guests: input.partySize,
          // The slot Eat App offered, handed straight back where it named one.
          preference_id: input.token,
          first_name: input.guestName.trim().split(/\s+/)[0],
          last_name: input.guestName.trim().split(/\s+/).slice(1).join(" ") || undefined,
          phone: input.guestPhone,
          email: input.guestEmail,
          notes: input.notes,
        },
      });
      const id = made.data?.id ?? made.id;
      if (!id) throw new Error("Eat App did not return the reservation it made");
      return { id, ref: made.data?.reference };
    },

    async reschedule(): Promise<PartnerBookingRef> {
      // PATCH /concierge/v2/reservations/:id would do it, on a grant Belline
      // does not hold. The restaurant moves it, and the guest is told that.
      throw new PartnerUnsupported("eatapp", "Eat App's Partner API cannot move a reservation");
    },

    async cancel(): Promise<void> {
      throw new PartnerUnsupported("eatapp", "Eat App's Partner API cannot cancel a reservation");
    },
  };
}

export const eatappConnector: PartnerConnector = {
  facts,

  linked(location: PartnerVenue): boolean {
    return Boolean(partnerLinkOf(location, "eatapp")?.venueId);
  },

  usable(location: PartnerVenue, env = process.env): boolean {
    const mode = partnerMode(facts, env);
    if (mode === "off") return false;
    const link = partnerLinkOf(location, "eatapp");
    if (!link?.venueId || link.expiredAt || link.misconfiguredAt) return false;
    // Live needs Eat App to have enabled this particular restaurant on
    // Belline's partner token. A token alone names no restaurant.
    return mode === "sandbox" || Boolean(link.sealedToken);
  },

  apiFor(location: PartnerVenue, env = process.env): PartnerApi | null {
    if (!this.usable(location, env)) return null;
    const link = partnerLinkOf(location, "eatapp")!;
    if (partnerMode(facts, env) === "sandbox") {
      return sandboxPartner(facts, {
        opens: 18 * 60,
        closes: 22 * 60,
        stepMin: 30,
        staff: [],
        maxParty: 8,
        sections: [
          { from: 12 * 60, to: 15 * 60, name: "Lunch" },
          { from: 18 * 60, to: 23 * 60, name: "Dinner" },
        ],
      });
    }
    const token = openCredentials(link.sealedToken!).apiToken;
    if (!token) throw new PartnerNotConnected("eatapp", "Eat App has not enabled this restaurant on Belline's partner token");
    const base = baseUrlFor(facts, PRODUCTION, env);
    const transport = httpTransport(facts, { baseUrl: base, auth: { Authorization: `Bearer ${token}` } });
    return eatappApi(transport, { restaurantId: link.venueId! });
  },

  refFields(ref: PartnerBookingRef) {
    return { partnerBookingId: ref.id, partnerRef: ref.ref };
  },
};

import type { Booking, Location, Slot } from "../types";
import { bookingRef, getCall, id, listBookings, saveBooking } from "../store";
import { bookingKey, describeWhat } from "./idempotency";
import { cancelBooking as localCancel } from "./index";
import {
  PartnerNotConnected,
  PartnerUnsupported,
  type PartnerApi,
  type PartnerBookingRef,
  type PartnerConnector,
  type PartnerCreate,
} from "../integrations/partners/contract";
import type { BookingProvider, Capabilities } from "./provider";
import type { BookingResult, CreateInput } from "./index";

/**
 * A business whose book is somebody else's booking system.
 *
 * This is the third shape of destination, and it is not the calendar one.
 *
 * With Google or Outlook, Belline's own engine decides what is offered and the
 * calendar only takes busy times away (calendar-provider.ts). That works
 * because a calendar has no opinion about hairdressing: the venue's services,
 * staff and rota live in Belline.
 *
 * A partner booking system has all of that itself, and better than we do — it
 * is where the salon's prices, rotas, room rules and processing times actually
 * live, and where its staff will look when the guest walks in. So Belline does
 * not compute availability here and filter it; it asks the partner what is
 * bookable and offers exactly that. Belline's own diary is a mirror of what the
 * partner confirmed, never a second opinion about it, because a second opinion
 * is how a guest is told 3pm is free when the salon's own screen says it is not.
 *
 * Three consequences worth stating, because they are easy to undo by accident.
 *
 * **Nothing is offered that the partner did not offer.** If the partner cannot
 * be reached, no times come back. Not Belline's times — none.
 *
 * **Nothing is confirmed that the partner did not confirm.** The mirror is
 * written only after the partner answers with a booking id. A failed write
 * leaves no Belline booking at all, so the agent takes a message instead of
 * telling somebody they have an appointment that does not exist.
 *
 * **What the partner cannot do, the agent is not given.** `capabilities` comes
 * from the partner's own documented API (integrations/partners/registry.ts).
 * OpenTable has no public way to move a reservation, so `reschedule` is false
 * there and the tool is never offered — rather than offered, attempted, and
 * failed in front of a guest.
 *
 * Today every one of these refuses with "not connected", because no partner has
 * issued Belline credentials. That is the honest state, and the checks pin it.
 */

const NOT_CONNECTED = (name: string) =>
  `This business's ${name} account is not connected to Belline, so no time can be confirmed. Take their name, number and the time they want as a message, and say the team will confirm.`;

const UNREACHABLE = (name: string) =>
  `${name} cannot be reached just now, so no time can be confirmed. Take their name, number and the time they want as a message, and say the team will confirm.`;

const CANNOT = (name: string, what: string) =>
  `${name} cannot ${what} through Belline. Take a message and say the team will do it.`;

function refused(detail: string, reason = "partner_unavailable"): BookingResult {
  return { ok: false, reason, detail, alternatives: [] };
}

/** Everything a partner-held booking needs on the Belline side, and nothing the engine would have decided. */
function mirror(location: Location, input: CreateInput, ref: PartnerBookingRef, key: string, endMin: number): Booking {
  const stamp = new Date().toISOString();
  return saveBooking({
    id: id("bk"),
    // The partner's own reference where it issues one: the guest will read it
    // back to the salon, and the salon looks it up in the partner's screen,
    // not in ours.
    ref: ref.ref ?? bookingRef(),
    locationId: location.id,
    vertical: location.vertical,
    status: "confirmed",
    date: input.date,
    startMin: input.startMin,
    endMin,
    guestName: input.guestName,
    guestPhone: input.guestPhone,
    guestEmail: input.guestEmail,
    notes: input.notes ?? "",
    partySize: input.partySize,
    serviceIds: input.serviceIds,
    staffId: input.staffId,
    source: input.source ?? "voice",
    callId: input.callId,
    partnerBookingId: ref.id,
    partnerRef: ref.ref,
    idempotencyKey: key,
    createdAt: stamp,
    updatedAt: stamp,
  } as Booking);
}

function capabilitiesOf(connector: PartnerConnector): Capabilities {
  const api = connector.facts.api;
  return {
    availability: api.availability,
    confirms: api.create,
    reschedule: api.reschedule,
    cancel: api.cancel,
    staffSelection: api.staffSelection,
    // A slot freed in the partner's system is not seen here. Belline's own
    // waitlist would be calling people about times the salon has already given
    // away, so there is no waitlist on a partner destination.
    waitlist: false,
  };
}

export function partnerProvider(connector: PartnerConnector): BookingProvider {
  const { facts } = connector;

  /** The partner API for this venue, or null with the reason already logged. */
  function apiOrNull(location: Location): PartnerApi | null {
    try {
      return connector.apiFor(location);
    } catch (err) {
      console.warn(`[partner:${facts.id}] ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  return {
    name: `partner:${facts.id}`,
    capabilities: capabilitiesOf(connector),

    async getServices({ location }) {
      // The partner holds the real catalogue; what Belline knows is whatever
      // setup recorded. Never invented, never merged — a service Belline made
      // up cannot be booked at the salon.
      return location.salon?.services ?? [];
    },

    async getStaff({ location }) {
      return location.salon?.staff ?? [];
    },

    async checkAvailability({ location, callId }, query) {
      const api = apiOrNull(location);
      if (!api || !facts.api.availability) return [];
      // Some partners compute availability against the guest's own record
      // rather than against the day (Zenoti's booking cart). The number the
      // conversation already has is handed over; nothing else about the guest is.
      const call = callId ? getCall(callId) : undefined;
      try {
        const slots = await api.availability({
          date: query.date,
          serviceIds: query.serviceIds,
          staffId: query.staffId,
          partySize: query.partySize,
          guest: call?.from ? { phone: call.from } : undefined,
        });
        return slots.map(
          (s): Slot => ({
            date: s.date,
            startMin: s.startMin,
            endMin: s.endMin,
            staffId: s.staffId,
            staffName: s.staffName,
            section: s.section,
          }),
        );
      } catch (err) {
        // A partner that cannot be read offers nothing. It never falls through
        // to Belline's own diary, which does not know this venue's book.
        console.warn(`[partner:${facts.id}] availability failed for ${location.name}: ${err instanceof Error ? err.message : String(err)}`);
        return [];
      }
    },

    async createBooking({ location }, input: CreateInput, idempotencyKey) {
      // What the partner's API cannot do is answered before what this
      // deployment has not got: "Fresha cannot take a booking through Belline"
      // is the true sentence for a partner with no booking API at all, and
      // "not connected" would imply a key would fix it.
      if (!facts.api.create) return refused(CANNOT(facts.name, "take a booking"), "unsupported");
      const api = apiOrNull(location);
      if (!api) return refused(NOT_CONNECTED(facts.name), "not_connected");

      const key =
        idempotencyKey ??
        bookingKey({
          locationId: location.id,
          date: input.date,
          startMin: input.startMin,
          guestPhone: input.guestPhone,
          guestName: input.guestName,
          what: describeWhat(input),
        });
      // The same booking arriving twice is one booking, whatever the partner
      // does about it: the mirror is looked up before anything leaves.
      const already = listBookings({ locationId: location.id, status: "confirmed" }).find((b) => b.idempotencyKey === key);
      if (already) return { ok: true, booking: already, duplicate: true };

      // The partner decides the length from its own service record. Where the
      // caller gave none, an hour is the placeholder the mirror carries — it is
      // never quoted to a guest, whose time comes from the partner's slot.
      const endMin = input.startMin + 60;
      const request: PartnerCreate = {
        date: input.date,
        startMin: input.startMin,
        endMin,
        guestName: input.guestName,
        guestPhone: input.guestPhone,
        guestEmail: input.guestEmail,
        notes: input.notes,
        serviceIds: input.serviceIds,
        staffId: input.staffId,
        partySize: input.partySize,
        idempotencyKey: key,
      };

      let ref: PartnerBookingRef;
      try {
        ref = await api.create(request);
      } catch (err) {
        if (err instanceof PartnerNotConnected) return refused(NOT_CONNECTED(facts.name), "not_connected");
        if (err instanceof PartnerUnsupported) return refused(CANNOT(facts.name, "take a booking"), "unsupported");
        console.warn(`[partner:${facts.id}] booking failed for ${location.name}: ${err instanceof Error ? err.message : String(err)}`);
        return refused(UNREACHABLE(facts.name));
      }

      const booking = mirror(location, input, ref, key, endMin);
      return ref.duplicate ? { ok: true, booking, duplicate: true } : { ok: true, booking };
    },

    async getBookingByRef({ location }, ref) {
      return listBookings({ locationId: location.id }).find((b) => b.ref === ref || b.partnerRef === ref) ?? null;
    },

    async getBookingById({ location }, bookingId) {
      const booking = listBookings({ locationId: location.id }).find((b) => b.id === bookingId);
      return booking ?? null;
    },

    async findBookingsByPhone({ location }, phone) {
      const digits = phone.replace(/\D/g, "").slice(-9);
      return listBookings({ locationId: location.id, status: "confirmed" }).filter((b) => b.guestPhone.replace(/\D/g, "").endsWith(digits));
    },

    async rescheduleBooking({ location }, booking, changes) {
      if (!facts.api.reschedule) return refused(CANNOT(facts.name, "move a booking"), "unsupported");
      const api = apiOrNull(location);
      if (!api) return refused(NOT_CONNECTED(facts.name), "not_connected");
      if (!booking.partnerBookingId) return refused(CANNOT(facts.name, "move a booking it does not hold"), "unsupported");

      const date = changes.date ?? booking.date;
      const startMin = changes.startMin ?? booking.startMin;
      const endMin = startMin + (booking.endMin - booking.startMin);
      try {
        // The partner moves it first. Only then does the mirror follow, so a
        // refusal leaves the guest's real appointment exactly where it was.
        const moved = await api.reschedule(
          { id: booking.partnerBookingId, ref: booking.partnerRef },
          { date, startMin, endMin, staffId: changes.staffId ?? booking.staffId },
        );
        const saved = saveBooking({
          ...booking,
          date,
          startMin,
          endMin,
          staffId: changes.staffId ?? booking.staffId,
          partnerBookingId: moved.id,
          partnerRef: moved.ref ?? booking.partnerRef,
          updatedAt: new Date().toISOString(),
        });
        return { ok: true, booking: saved };
      } catch (err) {
        if (err instanceof PartnerUnsupported) return refused(CANNOT(facts.name, "move a booking"), "unsupported");
        console.warn(`[partner:${facts.id}] reschedule failed for ${location.name}: ${err instanceof Error ? err.message : String(err)}`);
        return refused(UNREACHABLE(facts.name));
      }
    },

    async cancelBooking({ location }, booking, reason) {
      if (!facts.api.cancel) return { ok: false, detail: CANNOT(facts.name, "cancel a booking") };
      const api = apiOrNull(location);
      if (!api) return { ok: false, detail: NOT_CONNECTED(facts.name) };
      // Nothing is marked cancelled on Belline's side until the partner, which
      // holds the appointment the salon will actually look at, has cancelled it.
      if (booking.partnerBookingId) {
        try {
          await api.cancel({ id: booking.partnerBookingId, ref: booking.partnerRef }, reason);
        } catch (err) {
          if (err instanceof PartnerUnsupported) return { ok: false, detail: CANNOT(facts.name, "cancel a booking") };
          return { ok: false, detail: UNREACHABLE(facts.name) };
        }
      }
      return { ok: true, booking: localCancel(booking, location, reason) };
    },
  };
}

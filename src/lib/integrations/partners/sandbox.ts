import {
  PartnerUnsupported,
  type PartnerApi,
  type PartnerAvailabilityQuery,
  type PartnerBookingRef,
  type PartnerCreate,
  type PartnerFacts,
  type PartnerSlot,
} from "./contract";

/**
 * A partner booking system that only exists in this process.
 *
 * Every partner on the list issues credentials under an agreement, and several
 * have no sandbox at all (registry.ts), so there is nothing a check could talk
 * to. This stands in: it holds a day's bookable times, takes a booking off the
 * list when one is made, and refuses exactly what the real partner's API
 * refuses — so the checks drive the same adapter code paths a live key would.
 *
 * It is deliberately *not* generous. It does not invent a slot the query did
 * not ask for, it does not move a booking for a partner whose API cannot, and
 * it is only ever reachable when `FLAG_STUBS=on` or `PARTNER_<ID>_ENV=sandbox`
 * with credentials — never in production, where `flags.ts` refuses stubs
 * outright.
 *
 * What it is not: evidence that an integration works. A green check here says
 * Belline's side is built, and nothing whatever about whether the partner will
 * have us.
 */

export interface SandboxOptions {
  /** Bookable times, minutes from midnight, before anything is booked. */
  opens?: number;
  closes?: number;
  /** How long one slot is. Appointment systems quote these; restaurants quote sittings. */
  stepMin?: number;
  /** The partner's own ids for the people who can be asked for. */
  staff?: readonly { id: string; name: string }[];
  /** Restaurant sandboxes: the sitting a time falls in. */
  sections?: readonly { from: number; to: number; name: string }[];
  /** Party sizes the venue will take at all. */
  maxParty?: number;
  /** Make the partner unreachable, so a check can see what Belline says then. */
  down?: boolean;
}

export interface SandboxBooking extends PartnerCreate {
  id: string;
  ref: string;
  status: "confirmed" | "cancelled";
}

export interface SandboxPartner extends PartnerApi {
  /** Everything the fake partner holds, for a check to assert against. */
  bookings(): SandboxBooking[];
  /** Calls that reached the partner, in order: "availability", "create", … */
  calls(): string[];
  down(on: boolean): void;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function sandboxPartner(facts: PartnerFacts, options: SandboxOptions = {}): SandboxPartner {
  const opens = options.opens ?? 9 * 60;
  const closes = options.closes ?? 17 * 60;
  const step = options.stepMin ?? (facts.model === "reservations" ? 30 : 60);
  const staff = options.staff ?? (facts.api.staffSelection ? [{ id: `${facts.id}-emp-1`, name: "Nadia" }] : []);
  const held: SandboxBooking[] = [];
  const seen: string[] = [];
  let unreachable = options.down ?? false;

  let counter = 0;
  const nextId = () => `${facts.id}-${++counter}`;

  function unreachableCheck(what: string) {
    seen.push(what);
    if (unreachable) throw new Error(`${facts.name} sandbox is unreachable`);
  }

  function taken(date: string, startMin: number, staffId?: string): boolean {
    return held.some(
      (b) =>
        b.status === "confirmed" &&
        b.date === date &&
        b.startMin === startMin &&
        // A partner that names people only blocks that person's time.
        (!staff.length || !staffId || !b.staffId || b.staffId === staffId),
    );
  }

  function sectionFor(startMin: number): string | undefined {
    return options.sections?.find((s) => startMin >= s.from && startMin < s.to)?.name;
  }

  return {
    async availability(query: PartnerAvailabilityQuery): Promise<PartnerSlot[]> {
      unreachableCheck("availability");
      if (!facts.api.availability) throw new PartnerUnsupported(facts.id, `${facts.name} has no availability endpoint`);
      if (facts.model === "reservations" && !query.partySize) return [];
      if (facts.model === "reservations" && options.maxParty && query.partySize! > options.maxParty) return [];
      const who = facts.api.staffSelection ? (query.staffId ? staff.filter((s) => s.id === query.staffId) : staff) : [];
      if (query.staffId && facts.api.staffSelection && who.length === 0) return [];

      const out: PartnerSlot[] = [];
      for (let start = opens; start + step <= closes; start += step) {
        if (query.fromMin !== undefined && start < query.fromMin) continue;
        if (query.toMin !== undefined && start > query.toMin) continue;
        const member = who[0];
        if (taken(query.date, start, member?.id)) continue;
        out.push({
          date: query.date,
          startMin: start,
          endMin: start + step,
          staffId: member?.id,
          staffName: member?.name,
          section: sectionFor(start),
          // The partner hands back whatever it wants to see again when the
          // slot is booked. Zenoti's reserve/confirm pair works this way.
          token: `${query.date}T${pad(Math.floor(start / 60))}:${pad(start % 60)}`,
        });
      }
      return out;
    },

    async create(input: PartnerCreate): Promise<PartnerBookingRef> {
      unreachableCheck("create");
      if (!facts.api.create) throw new PartnerUnsupported(facts.id, `${facts.name} has no way to create a booking`);
      const before = held.find((b) => b.idempotencyKey === input.idempotencyKey && b.status === "confirmed");
      if (before) return { id: before.id, ref: before.ref, duplicate: true };
      if (taken(input.date, input.startMin, input.staffId)) throw new Error("that time is taken");
      const booking: SandboxBooking = { ...input, id: nextId(), ref: `S${1000 + held.length}`, status: "confirmed" };
      held.push(booking);
      return { id: booking.id, ref: booking.ref };
    },

    async reschedule(ref, changes): Promise<PartnerBookingRef> {
      unreachableCheck("reschedule");
      if (!facts.api.reschedule) throw new PartnerUnsupported(facts.id, `${facts.name} cannot move a booking through its API`);
      const booking = held.find((b) => b.id === ref.id && b.status === "confirmed");
      if (!booking) throw new Error("no such booking");
      if (taken(changes.date, changes.startMin, changes.staffId)) throw new Error("that time is taken");
      booking.date = changes.date;
      booking.startMin = changes.startMin;
      booking.endMin = changes.endMin;
      booking.staffId = changes.staffId;
      return { id: booking.id, ref: booking.ref };
    },

    async cancel(ref): Promise<void> {
      unreachableCheck("cancel");
      if (!facts.api.cancel) throw new PartnerUnsupported(facts.id, `${facts.name} cannot cancel through its API`);
      const booking = held.find((b) => b.id === ref.id);
      if (!booking) throw new Error("no such booking");
      booking.status = "cancelled";
    },

    bookings: () => held.map((b) => ({ ...b })),
    calls: () => [...seen],
    down: (on: boolean) => {
      unreachable = on;
    },
  };
}

/**
 * A partner with no API at all (Fresha today).
 *
 * Not a fake booking system — there is nothing to fake. Every call refuses the
 * way the adapter refuses in production, so a check can prove that a venue on
 * this partner is never quoted a time and never told a booking was made.
 */
export function closedPartner(facts: PartnerFacts, why: string): PartnerApi {
  const refuse = (): never => {
    throw new PartnerUnsupported(facts.id, why);
  };
  return {
    async availability() {
      return refuse();
    },
    async create() {
      return refuse();
    },
    async reschedule() {
      return refuse();
    },
    async cancel() {
      return refuse();
    },
  };
}

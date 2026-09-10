import type Anthropic from "@anthropic-ai/sdk";
import type { Booking, Call, Location, Slot } from "../types";
import {
  cancelBooking,
  confirmationMessage,
  createBooking,
  describeBooking,
  findAvailability,
  modifyBooking,
} from "../booking";
import { sendSms, smsEnabled } from "../providers/sms";
import { chainDuration, resolveServices } from "../booking/salon";
import {
  findBookingByRef,
  findBookingsByPhone,
  getBooking,
  listBookings,
} from "../store";
import {
  daysBetween,
  isValidDate,
  minutesToClock,
  minutesToSpoken,
  parseClock,
  resolveDate,
  todayIn,
} from "../time";

/**
 * The agent's hands.
 *
 * Two principles run through this file:
 *
 *   Tools validate, they do not trust. The model is good but it will
 *   occasionally send "friday" as a date or a party of forty. Every input is
 *   checked here and a failure comes back as a sentence the agent can read
 *   out, not an exception that drops the call.
 *
 *   Failures carry the recovery. An unavailable slot returns the nearby
 *   alternatives in the same result, so the agent answers "eight is gone, I
 *   have quarter past seven or half past eight" in one turn instead of three.
 */

export interface ToolContext {
  location: Location;
  call: Call;
  callerNumber?: string;
}

export interface ToolOutcome {
  result: unknown;
  /** Set when the tool ends the conversation. */
  control?: { type: "end_call"; summary: string } | { type: "transfer"; reason: string };
}

const TIME_DESC = "Time in 24-hour HH:MM form, e.g. 19:30.";
const DATE_DESC = "Date as YYYY-MM-DD. Resolve words like tomorrow yourself.";

export function toolsFor(location: Location): Anthropic.Tool[] {
  const isRestaurant = location.vertical === "restaurant";

  const bookingShape: Record<string, unknown> = isRestaurant
    ? {
        party_size: { type: "integer", description: "Number of people, including children." },
      }
    : {
        service_ids: {
          type: "array",
          items: { type: "string" },
          description:
            "Service ids from the service list, in the order they will be performed.",
        },
        staff_id: {
          type: "string",
          description: "Only if the caller asked for a specific person by name.",
        },
      };

  return [
    {
      name: "check_availability",
      description:
        "Find bookable times on a given date. Always call this before telling a caller whether something is possible. Returns the nearest available times either side of the one they asked for.",
      input_schema: {
        type: "object",
        properties: {
          date: { type: "string", description: DATE_DESC },
          time: {
            type: "string",
            description: `${TIME_DESC} Omit to see what is open across the whole day.`,
          },
          ...bookingShape,
        },
        required: ["date", ...(isRestaurant ? ["party_size"] : ["service_ids"])],
      },
    },
    {
      name: "book",
      description:
        "Create the booking. Only call this once you have a name, a contact number, and a time you have confirmed with check_availability.",
      input_schema: {
        type: "object",
        properties: {
          date: { type: "string", description: DATE_DESC },
          time: { type: "string", description: TIME_DESC },
          guest_name: { type: "string" },
          guest_phone: { type: "string", description: "Contact number, digits as spoken." },
          notes: {
            type: "string",
            description:
              "Anything the team needs to know: allergies, occasion, seating preference, mobility.",
          },
          ...bookingShape,
        },
        required: [
          "date",
          "time",
          "guest_name",
          "guest_phone",
          ...(isRestaurant ? ["party_size"] : ["service_ids"]),
        ],
      },
    },
    {
      name: "lookup_booking",
      description:
        "Find an existing booking before changing or cancelling it. Search by reference if the caller has one, otherwise by their phone number.",
      input_schema: {
        type: "object",
        properties: {
          reference: { type: "string", description: "Four-character booking reference." },
          phone: { type: "string", description: "The caller's phone number." },
        },
      },
    },
    {
      name: "change_booking",
      description:
        "Move or amend an existing booking. Pass only the fields that change. Returns alternatives if the new time does not work.",
      input_schema: {
        type: "object",
        properties: {
          booking_id: { type: "string", description: "From lookup_booking." },
          date: { type: "string", description: DATE_DESC },
          time: { type: "string", description: TIME_DESC },
          notes: { type: "string" },
          ...bookingShape,
        },
        required: ["booking_id"],
      },
    },
    {
      name: "cancel_booking",
      description: "Cancel a booking you have already found with lookup_booking.",
      input_schema: {
        type: "object",
        properties: {
          booking_id: { type: "string" },
          reason: { type: "string" },
        },
        required: ["booking_id"],
      },
    },
    {
      name: "take_message",
      description:
        "Record a message for the team when the caller wants something you cannot do yourself.",
      input_schema: {
        type: "object",
        properties: {
          caller_name: { type: "string" },
          callback_number: { type: "string" },
          message: { type: "string", description: "What they want, in one or two sentences." },
          urgency: { type: "string", enum: ["normal", "urgent"] },
        },
        required: ["caller_name", "message"],
      },
    },
    {
      name: "transfer_call",
      description:
        "Hand the call to a person. Use only when it is urgent and cannot wait for a callback.",
      input_schema: {
        type: "object",
        properties: { reason: { type: "string" } },
        required: ["reason"],
      },
    },
    {
      name: "end_call",
      description:
        "End the call once the caller's business is finished. Say your goodbye in the same turn you call this.",
      input_schema: {
        type: "object",
        properties: {
          summary: { type: "string", description: "One line for the call log." },
          outcome: {
            type: "string",
            enum: [
              "booking_created",
              "booking_changed",
              "booking_cancelled",
              "answered_question",
              "message_taken",
              "transferred",
              "abandoned",
            ],
          },
        },
        required: ["summary", "outcome"],
      },
    },
  ];
}

// ---------------------------------------------------------------------------

function slotSummary(location: Location, slots: Slot[]) {
  return slots.map((s) => ({
    time: minutesToClock(s.startMin),
    spoken: minutesToSpoken(s.startMin),
    ...(s.staffName ? { with: s.staffName } : {}),
  }));
}

function normaliseDate(ctx: ToolContext, raw: unknown): string | { error: string } {
  if (typeof raw !== "string") return { error: "A date is required, as YYYY-MM-DD." };
  const date = isValidDate(raw) ? raw : resolveDate(raw, ctx.location.timezone);
  if (!date) return { error: `Could not read "${raw}" as a date. Ask the caller to confirm it.` };

  const today = todayIn(ctx.location.timezone);
  const delta = daysBetween(today, date);
  if (delta < 0) return { error: "That date is in the past. Ask the caller which date they meant." };
  if (delta > ctx.location.agent.bookingHorizonDays) {
    return {
      error: `That is further ahead than the ${ctx.location.agent.bookingHorizonDays}-day booking window. Take a message instead.`,
    };
  }
  return date;
}

function normaliseTime(raw: unknown): number | { error: string } {
  if (typeof raw !== "string") return { error: "A time is required, as HH:MM." };
  const min = parseClock(raw);
  if (min === null) return { error: `Could not read "${raw}" as a time.` };
  return min;
}

function bookingPayload(location: Location, booking: Booking) {
  const base = {
    booking_id: booking.id,
    reference: booking.ref,
    date: booking.date,
    time: minutesToClock(booking.startMin),
    spoken_time: minutesToSpoken(booking.startMin),
    guest_name: booking.guestName,
    guest_phone: booking.guestPhone,
    status: booking.status,
    notes: booking.notes,
  };
  if (booking.vertical === "restaurant") {
    return { ...base, party_size: booking.partySize };
  }
  const { services } = resolveServices(location.salon!, booking.serviceIds ?? []);
  const { price, durationMin } = chainDuration(services);
  const staff = location.salon!.staff.find((s) => s.id === booking.staffId);
  return {
    ...base,
    services: services.map((s) => s.name),
    with: staff?.name,
    duration_min: durationMin,
    price: `${location.currency} ${price}`,
  };
}

/**
 * Text the confirmation, and tell the agent what to say about it.
 *
 * The result feeds straight back into the model, so it is phrased as an
 * instruction rather than a status code — otherwise the agent either says
 * nothing about the text or promises one that never arrived.
 */
async function confirmByText(
  location: Location,
  booking: Booking,
): Promise<{ sms: string }> {
  if (!smsEnabled()) {
    return { sms: "Not sent — do not mention a text message." };
  }
  const result = await sendSms(booking.guestPhone, confirmationMessage(location, booking));
  return {
    sms: result.sent
      ? "Sent. Tell the caller a confirmation text is on its way."
      : "Failed. Do not mention a text; read the reference back clearly instead.",
  };
}

// ---------------------------------------------------------------------------

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const { location } = ctx;
  const isRestaurant = location.vertical === "restaurant";

  switch (name) {
    case "check_availability": {
      const date = normaliseDate(ctx, input.date);
      if (typeof date !== "string") return { result: date };

      let preferredMin: number | undefined;
      if (input.time !== undefined && input.time !== null && input.time !== "") {
        const t = normaliseTime(input.time);
        if (typeof t !== "number") return { result: t };
        preferredMin = t;
      }

      const partySize = Number(input.party_size) || undefined;
      if (isRestaurant && partySize && partySize > location.restaurant!.maxPartySize) {
        return {
          result: {
            available: false,
            reason: "party_too_large",
            say: location.restaurant!.largePartyPolicy,
          },
        };
      }

      const slots = findAvailability(location, {
        locationId: location.id,
        date,
        preferredMin,
        partySize,
        serviceIds: (input.service_ids as string[]) ?? undefined,
        staffId: (input.staff_id as string) ?? undefined,
        windowMin: preferredMin === undefined ? 24 * 60 : undefined,
      });

      if (slots.length === 0) {
        return {
          result: {
            available: false,
            date,
            say: "Nothing is open on that date. Offer another day.",
          },
        };
      }

      const exact =
        preferredMin !== undefined && slots.some((s) => s.startMin === preferredMin);

      return {
        result: {
          available: true,
          date,
          exact_time_available: exact,
          options: slotSummary(location, slots),
        },
      };
    }

    case "book": {
      const date = normaliseDate(ctx, input.date);
      if (typeof date !== "string") return { result: date };
      const startMin = normaliseTime(input.time);
      if (typeof startMin !== "number") return { result: startMin };

      const guestName = String(input.guest_name ?? "").trim();
      const guestPhone = String(input.guest_phone ?? ctx.callerNumber ?? "").trim();
      if (!guestName) return { result: { error: "Ask for the guest's name first." } };
      if (!guestPhone) return { result: { error: "Ask for a contact number first." } };

      const result = createBooking(location, {
        date,
        startMin,
        guestName,
        guestPhone,
        notes: String(input.notes ?? ""),
        partySize: Number(input.party_size) || undefined,
        serviceIds: (input.service_ids as string[]) ?? undefined,
        staffId: (input.staff_id as string) ?? undefined,
        callId: ctx.call.id,
        source: "voice",
      });

      if (!result.ok) {
        return {
          result: {
            booked: false,
            reason: result.reason,
            say: result.detail,
            alternatives: slotSummary(location, result.alternatives),
          },
        };
      }

      ctx.call.bookingId = result.booking.id;
      const texted = await confirmByText(location, result.booking);
      return {
        result: {
          booked: true,
          ...bookingPayload(location, result.booking),
          read_back: describeBooking(location, result.booking),
          ...texted,
        },
      };
    }

    case "lookup_booking": {
      const ref = input.reference ? String(input.reference) : undefined;
      const phone = input.phone ? String(input.phone) : ctx.callerNumber;

      if (ref) {
        const found = findBookingByRef(location.id, ref);
        if (found && found.status === "confirmed") {
          return { result: { found: 1, bookings: [bookingPayload(location, found)] } };
        }
        if (found) {
          return {
            result: {
              found: 0,
              say: `That booking was already ${found.status}.`,
            },
          };
        }
      }

      if (phone) {
        const matches = findBookingsByPhone(location.id, phone)
          .filter((b) => b.date >= todayIn(location.timezone))
          .sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin);
        if (matches.length > 0) {
          return {
            result: {
              found: matches.length,
              bookings: matches.map((b) => bookingPayload(location, b)),
            },
          };
        }
      }

      return {
        result: {
          found: 0,
          say: "No upcoming booking under that reference or number. Ask which name it was under and when it was for.",
        },
      };
    }

    case "change_booking": {
      const booking = getBooking(String(input.booking_id ?? ""));
      if (!booking || booking.locationId !== location.id) {
        return { result: { error: "Unknown booking. Use lookup_booking first." } };
      }
      if (booking.status !== "confirmed") {
        return { result: { error: `That booking is ${booking.status} and cannot be changed.` } };
      }

      const changes: Parameters<typeof modifyBooking>[2] = {};
      if (input.date !== undefined) {
        const date = normaliseDate(ctx, input.date);
        if (typeof date !== "string") return { result: date };
        changes.date = date;
      }
      if (input.time !== undefined) {
        const t = normaliseTime(input.time);
        if (typeof t !== "number") return { result: t };
        changes.startMin = t;
      }
      if (input.party_size !== undefined) changes.partySize = Number(input.party_size);
      if (input.service_ids !== undefined) changes.serviceIds = input.service_ids as string[];
      if (input.staff_id !== undefined) changes.staffId = String(input.staff_id);
      if (input.notes !== undefined) changes.notes = String(input.notes);

      const result = modifyBooking(location, booking, changes);
      if (!result.ok) {
        return {
          result: {
            changed: false,
            reason: result.reason,
            say: result.detail,
            alternatives: slotSummary(location, result.alternatives),
          },
        };
      }
      ctx.call.bookingId = result.booking.id;
      const texted = await confirmByText(location, result.booking);
      return {
        result: {
          changed: true,
          ...bookingPayload(location, result.booking),
          read_back: describeBooking(location, result.booking),
          ...texted,
        },
      };
    }

    case "cancel_booking": {
      const booking = getBooking(String(input.booking_id ?? ""));
      if (!booking || booking.locationId !== location.id) {
        return { result: { error: "Unknown booking. Use lookup_booking first." } };
      }
      if (booking.status === "cancelled") {
        return { result: { cancelled: true, say: "That booking was already cancelled." } };
      }
      const updated = cancelBooking(booking);
      ctx.call.bookingId = updated.id;
      return {
        result: {
          cancelled: true,
          reference: updated.ref,
          say: "Cancelled. Confirm it back to the caller.",
        },
      };
    }

    case "take_message": {
      const message = String(input.message ?? "");
      ctx.call.escalation = `${String(input.caller_name ?? "Caller")}${
        input.callback_number ? ` (${input.callback_number})` : ""
      }: ${message}`;
      return {
        result: {
          saved: true,
          say: "Tell the caller the message is with the team and when they can expect a reply.",
        },
      };
    }

    case "transfer_call": {
      const number = location.agent.transferNumber;
      if (!number) {
        return {
          result: {
            transferred: false,
            say: "No one is available to take a transfer. Offer to take a message instead.",
          },
        };
      }
      ctx.call.escalation = `Transfer requested: ${String(input.reason ?? "")}`;
      return {
        result: { transferred: true, number },
        control: { type: "transfer", reason: String(input.reason ?? "") },
      };
    }

    case "end_call": {
      const summary = String(input.summary ?? "");
      ctx.call.summary = summary;
      ctx.call.outcome = (input.outcome as Call["outcome"]) ?? null;
      return {
        result: { ended: true },
        control: { type: "end_call", summary },
      };
    }

    default:
      return { result: { error: `No such tool: ${name}` } };
  }
}

/** Used by the dashboard's "today at a glance" panel. */
export function todaysBookings(location: Location): Booking[] {
  return listBookings({
    locationId: location.id,
    date: todayIn(location.timezone),
    status: "confirmed",
  }).sort((a, b) => a.startMin - b.startMin);
}

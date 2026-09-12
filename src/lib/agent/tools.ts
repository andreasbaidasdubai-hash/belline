import type Anthropic from "@anthropic-ai/sdk";
import type { Booking, Call, Location, Slot } from "../types";
import { confirmationMessage, describeBooking } from "../booking";
import {
  providerFor,
  type BookingProvider,
  type ProviderContext,
} from "../booking/provider";
import { sendSms, smsEnabled } from "../providers/sms";
// The same checker the website's booking form uses. Two copies of "is this a
// real address" drift, and the one that drifts is the one nobody tested.
import { checkShape } from "../leads/email";
import { join } from "../waitlist";
import { serviceShape } from "../booking/services";
import { depositWording, horizonDays } from "../booking/policy";
import { listBookings } from "../store";
import {
  daysBetween,
  isValidDate,
  minutesToClock,
  minutesToSpoken,
  parseClock,
  resolveDate,
  todayIn,
} from "../time";
import type { AgentChannel } from "./prompt";

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

export function toolsFor(
  location: Location,
  channel: AgentChannel = "voice",
): Anthropic.Tool[] {
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
        "Create the booking. Only call this once you have a name, a contact number, and a time you have confirmed with check_availability." +
        (location.requiresEmail
          ? " This venue also needs an email address. Spell it back to them letter by letter and have them confirm it before you call this — an address misheard on a phone line never bounces, it just means they never hear from us."
          : ""),
      input_schema: {
        type: "object",
        properties: {
          date: { type: "string", description: DATE_DESC },
          time: { type: "string", description: TIME_DESC },
          guest_name: { type: "string" },
          guest_phone: { type: "string", description: "Contact number, digits as spoken." },
          ...(location.requiresEmail
            ? {
                guest_email: {
                  type: "string",
                  description:
                    "Email address, confirmed with them. Write it as an address — 'andreas at gmail dot com' becomes andreas@gmail.com.",
                },
                email_confirmed: {
                  type: "boolean",
                  description:
                    "Set this only after you have read an address back that looked like a misspelling and they told you it was right anyway. Without it an unusual address is queried once.",
                },
              }
            : {}),
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
          ...(location.requiresEmail ? ["guest_email"] : []),
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
      name: "join_waitlist",
      description:
        "Put the caller on the waitlist when the time they wanted is gone and no alternative " +
        "suits them. Offer this instead of letting them ring off with nothing — if something " +
        "frees up we will call them back. Ask for the window they would accept, not one time.",
      input_schema: {
        type: "object",
        properties: {
          guest_name: { type: "string" },
          phone: { type: "string", description: "A number to ring back on." },
          date: { type: "string", description: "YYYY-MM-DD." },
          earliest: { type: "string", description: "Earliest they would come, e.g. 19:00." },
          latest: { type: "string", description: "Latest they would come, e.g. 21:00." },
          party_size: { type: "number" },
          service_ids: { type: "array", items: { type: "string" } },
          staff_id: { type: "string", description: "Only if they will not see anyone else." },
          notes: { type: "string" },
        },
        required: ["guest_name", "phone", "date", "earliest", "latest"],
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
    /*
      The control verbs, which are the one place the two channels genuinely
      differ.

      A telephone call is a resource that is held open and has to be let go of
      — hence end_call — and it can be handed to a person mid-sentence, which
      is what transfer_call does. A message thread has neither property. It
      does not hang up, it goes quiet; and "fetch a person" is not a transfer
      but a change of state that stops Belline answering and puts the thread in
      front of staff.

      So the verbs are swapped rather than shared. Offering end_call on
      WhatsApp would mean the agent deciding a conversation was over, which is
      a judgement it is in no position to make.
    */
    ...(channel === "voice"
      ? ([
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
        ] satisfies Anthropic.Tool[])
      : ([
          {
            name: "request_human_handoff",
            description:
              "Stop answering and put this conversation in front of the team. Use it when someone asks for a person, complains, is angry, raises something sensitive, or asks for something you are not allowed to decide — and when you have misunderstood twice in a row. Say in the same turn that you are passing it on.",
            input_schema: {
              type: "object",
              properties: {
                reason: {
                  type: "string",
                  description: "Why, in a few words. Staff see this at the top of the conversation.",
                },
                summary: {
                  type: "string",
                  description:
                    "Two sentences: what they want and what has happened so far, so nobody has to read the thread before replying.",
                },
                urgency: { type: "string", enum: ["normal", "urgent"] },
              },
              required: ["reason", "summary"],
            },
          },
        ] satisfies Anthropic.Tool[])),
  ];
}

// ---------------------------------------------------------------------------

function slotSummary(location: Location, slots: Slot[]) {
  return slots.map((s) => ({
    time: minutesToClock(s.startMin),
    spoken: minutesToSpoken(s.startMin),
    ...(s.staffName ? { with: s.staffName } : {}),
    // The price travels with the slot because it is not a property of the
    // service alone: a salon that charges by stylist level quotes a different
    // number for the same cut at eleven and at two, and the agent reading the
    // wall price is an argument at the till.
    ...(s.price ? { price: `${location.currency} ${s.price}` } : {}),
  }));
}

function normaliseDate(ctx: ToolContext, raw: unknown): string | { error: string } {
  if (typeof raw !== "string") return { error: "A date is required, as YYYY-MM-DD." };
  const date = isValidDate(raw) ? raw : resolveDate(raw, ctx.location.timezone);
  if (!date) return { error: `Could not read "${raw}" as a date. Ask the caller to confirm it.` };

  const today = todayIn(ctx.location.timezone);
  const delta = daysBetween(today, date);
  if (delta < 0) return { error: "That date is in the past. Ask the caller which date they meant." };
  // The venue's own horizon where it has set one, falling back to the agent's.
  // Checked here as well as in the engine so the agent stops asking questions
  // about a date it is never going to be allowed to book.
  const horizon = horizonDays(ctx.location);
  if (delta > horizon) {
    return {
      error: `That is further ahead than the ${horizon}-day booking window. Take a message instead.`,
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
  const config = location.salon!;
  const staff = config.staff.find((s) => s.id === booking.staffId);
  // Priced and timed for the person actually doing it, not off the wall list.
  const shape = serviceShape(config, booking.serviceIds ?? [], { staff });
  const second = config.staff.find((s) => s.id === booking.secondaryStaffId);
  return {
    ...base,
    services: shape.services.map((s) => s.name),
    with: staff?.name,
    ...(second ? { also_seeing: second.name } : {}),
    duration_min: shape.durationMin,
    price: `${location.currency} ${shape.price}`,
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
  // Which book this venue writes into. One provider today — but every booking
  // the product takes now goes through the interface, which is the only way an
  // abstraction stays honest. The previous attempt at this seam was a type
  // with no implementations and no call sites.
  const provider = providerFor(location);
  // The call id travels with every provider call: it is what lets the engine
  // hold a quoted slot against other lines without holding it against this one.
  const pctx: ProviderContext = { location, callId: ctx.call.id };

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

      const slots = await provider.checkAvailability(pctx, {
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

      // An address taken by ear is the least reliable thing on the call, and
      // the only one that fails silently — so it is checked here rather than
      // trusted, and the agent is handed words to say rather than an error.
      let guestEmail: string | undefined;
      if (location.requiresEmail) {
        const check = checkShape(String(input.guest_email ?? ""));
        if (!check.valid) {
          return {
            result: {
              booked: false,
              reason: "email_unclear",
              say:
                "I did not catch that address. Ask them to say it again slowly, " +
                "then spell the part before the at sign back to them.",
            },
          };
        }
        // Queried once, then believed — the same bargain the web form makes.
        // A real mailbox can sit one letter from a famous domain, and telling
        // somebody their own address is wrong is worse than a bounce.
        if (check.suggestion && !input.email_confirmed) {
          return {
            result: {
              booked: false,
              reason: "email_uncertain",
              say:
                `Read it back as ${check.suggestion} and ask if that is right. ` +
                `If they say it really is ${check.email}, call book again with ` +
                `email_confirmed set and it will go through.`,
              heard: check.email,
              likely: check.suggestion,
            },
          };
        }
        guestEmail = check.email;
      }

      const result = await provider.createBooking(pctx, {
        date,
        startMin,
        guestName,
        guestPhone,
        guestEmail,
        notes: String(input.notes ?? ""),
        partySize: Number(input.party_size) || undefined,
        serviceIds: (input.service_ids as string[]) ?? undefined,
        staffId: (input.staff_id as string) ?? undefined,
        callId: ctx.call.id,
        source: "voice",
      });

      if (!result.ok) {
        // A house rule is not a full room, and answering one with "how about
        // half past" is worse than saying nothing: the caller has been told
        // the venue needs a day's notice and is then offered a time tomorrow
        // morning anyway. `detail` already carries what to say.
        if (result.policy) {
          return {
            result: {
              booked: false,
              reason: result.reason,
              house_rule: true,
              say: `${result.detail} Say this as the house's rule, not as a system limitation, and do not offer nearby times.`,
            },
          };
        }
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

      // This booking already existed — a retry, or a caller going round the
      // houses and asking for the same thing twice. Confirm what they have
      // rather than announcing a second one, and do not text them again: a
      // duplicate confirmation reads as a duplicate booking to the guest.
      if (result.duplicate) {
        return {
          result: {
            booked: true,
            already_booked: true,
            ...bookingPayload(location, result.booking),
            read_back: describeBooking(location, result.booking),
            say: "They already have this booking. Confirm it back as theirs — do not suggest anything was booked twice.",
          },
        };
      }

      const texted = await confirmByText(location, result.booking);
      const deposit = result.booking.deposit;
      return {
        result: {
          booked: true,
          ...bookingPayload(location, result.booking),
          read_back: describeBooking(location, result.booking),
          // Said at the point the booking is made and not before, because a
          // deposit mentioned while the caller is still choosing a time reads
          // as a barrier rather than a term. Belline never takes the money —
          // see policy.ts — so the wording sends them to the team.
          ...(deposit
            ? {
                deposit: `${deposit.currency} ${deposit.amount}`,
                say: depositWording(location, deposit),
              }
            : {}),
          ...texted,
        },
      };
    }

    case "lookup_booking": {
      const ref = input.reference ? String(input.reference) : undefined;
      const phone = input.phone ? String(input.phone) : ctx.callerNumber;

      if (ref) {
        const found = await provider.getBookingByRef(pctx, ref);
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
        const matches = (await provider.findBookingsByPhone(pctx, phone))
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
      // Honest before attempted. A provider that cannot move a booking must
      // say so and take a message — trying, failing and leaving a guest
      // believing their appointment moved is the worst of the three outcomes.
      if (!provider.capabilities.reschedule) {
        return {
          result: {
            error: "not_supported",
            say: "I can't move a booking myself here. Let me take the details and the team will do it.",
          },
        };
      }
      const booking = await provider.getBookingById(pctx, String(input.booking_id ?? ""));
      if (!booking) {
        return { result: { error: "Unknown booking. Use lookup_booking first." } };
      }
      if (booking.status !== "confirmed") {
        return { result: { error: `That booking is ${booking.status} and cannot be changed.` } };
      }

      const changes: Parameters<BookingProvider["rescheduleBooking"]>[2] = {};
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

      const result = await provider.rescheduleBooking(pctx, booking, changes);
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
      const booking = await provider.getBookingById(pctx, String(input.booking_id ?? ""));
      if (!booking || booking.locationId !== location.id) {
        return { result: { error: "Unknown booking. Use lookup_booking first." } };
      }
      if (booking.status === "cancelled") {
        return { result: { cancelled: true, say: "That booking was already cancelled." } };
      }
      const cancelled = await provider.cancelBooking(pctx, booking);
      if (!cancelled.ok) {
        return { result: { error: "cancel_failed", say: cancelled.detail } };
      }
      const updated = cancelled.booking;
      ctx.call.bookingId = updated.id;
      return {
        result: {
          cancelled: true,
          reference: updated.ref,
          say: "Cancelled. Confirm it back to the caller.",
        },
      };
    }

    case "join_waitlist": {
      const date = resolveDate(String(input.date ?? ""), location.timezone);
      const earliest = parseClock(String(input.earliest ?? ""));
      const latest = parseClock(String(input.latest ?? ""));
      const name = String(input.guest_name ?? "").trim();
      const phone = String(input.phone ?? ctx.callerNumber ?? "").trim();

      if (!date) return { result: { error: "Which day? Ask them to say it plainly." } };
      if (earliest === null || latest === null) {
        return { result: { error: "Ask what window would work — earliest and latest." } };
      }
      if (!name) return { result: { error: "Ask for a name first." } };
      if (!phone) return { result: { error: "Ask for a number to ring back on." } };

      const entry = join({
        locationId: location.id,
        guestName: name,
        guestPhone: phone,
        date,
        earliestMin: earliest,
        latestMin: latest,
        partySize: Number(input.party_size) || undefined,
        serviceIds: (input.service_ids as string[]) ?? undefined,
        staffId: (input.staff_id as string) ?? undefined,
        notes: String(input.notes ?? ""),
        callId: ctx.call.id,
      });

      return {
        result: {
          waitlisted: true,
          id: entry.id,
          say:
            "Tell them they are on the list and that we will ring if something frees up. " +
            "Do not promise a slot — there may not be one.",
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


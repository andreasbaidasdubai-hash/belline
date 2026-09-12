import type { Booking, DateStr, Location } from "../types";
import { listBookings, saveBooking } from "../store";
import { addDays, daysBetween, todayIn } from "../time";
import { normalisePhone } from "../guests";
import { priceFor } from "./services";

/**
 * Who is due back, and for what.
 *
 * This is the part of a clinic system that makes the money, and it is almost
 * never the part a scheduling product ships. A dental practice does not grow
 * by answering the phone faster; it grows because somebody rings the four
 * hundred patients whose six-month cleaning fell due and never got rebooked.
 * Practices call it recall or recare, they measure themselves on it, and the
 * industry average is that a third of it never gets done — because it is a
 * list somebody has to work through by hand, between patients, on a Tuesday.
 *
 * A salon has the same shape and does not have a word for it: a root touch-up
 * at six weeks, a cut at eight. Same query, different interval.
 *
 * Belline is the only thing in this market that can both hold the list *and*
 * make the calls, which is why the list is computed here rather than left as a
 * dashboard filter. `recallDue` is what an outbound campaign iterates.
 *
 * Derived, never stored. Each booking writes its own `recallDueOn` at the time
 * it is taken (see `recallFor` in index.ts), so this is a scan rather than a
 * nightly job — and a nightly job is a thing that fails quietly for three
 * weeks before anyone notices the calls stopped.
 */

export type RecallStatus = "upcoming" | "due" | "overdue" | "contacted" | "booked";

export interface RecallItem {
  guestName: string;
  guestPhone: string;
  /** When they were due back. */
  dueOn: DateStr;
  serviceId: string;
  serviceName: string;
  /** The visit that generated the recall. */
  lastVisit: DateStr;
  fromBookingId: string;
  status: RecallStatus;
  /** Negative until the date passes. */
  overdueDays: number;
  /** What the return visit is worth at list price. Ranks the call list. */
  value: number;
  /** Set when they have already rebooked — the item is closed, not chased. */
  bookedFor?: DateStr;
  /** When somebody last rang them about it. */
  contactedAt?: string;
  /** Off the list until this date, because they asked. */
  snoozedUntil?: DateStr;
}

export interface RecallOptions {
  /** How far forward to look. Default 30 days: a month of calls to make. */
  withinDays?: number;
  /** How far back an unanswered recall is still worth chasing. Default 180. */
  staleAfterDays?: number;
  /**
   * Include the people who asked to be left until later.
   *
   * Off by default, because the point of a snooze is that the list gets
   * shorter. On for the page that wants to show what it is hiding.
   */
  includeSnoozed?: boolean;
  /** Freeze the clock. Tests only. */
  today?: DateStr;
}

/**
 * The call list, most valuable and most overdue first.
 *
 * One entry per guest per service: somebody with two years of cleanings is one
 * person to ring, not four, and the most recent visit is the one that says
 * when they are next due.
 */
export function recallDue(location: Location, opts: RecallOptions = {}): RecallItem[] {
  const config = location.salon;
  if (!config) return [];

  const today = opts.today ?? todayIn(location.timezone);
  const horizon = addDays(today, opts.withinDays ?? 30);
  const floor = addDays(today, -(opts.staleAfterDays ?? 180));

  const bookings = listBookings({ locationId: location.id });

  // Latest recall-generating visit per guest per service. Cancellations and
  // no-shows generate nothing: somebody who did not come has not started the
  // clock on coming back.
  const latest = new Map<string, Booking>();
  for (const booking of bookings) {
    if (!booking.recallDueOn || !booking.recallServiceId) continue;
    if (booking.status === "cancelled" || booking.status === "no_show") continue;
    const key = `${normalisePhone(booking.guestPhone)}:${booking.recallServiceId}`;
    const held = latest.get(key);
    if (!held || booking.date > held.date) latest.set(key, booking);
  }

  const items: RecallItem[] = [];
  for (const [key, booking] of latest) {
    const dueOn = booking.recallDueOn!;
    if (dueOn > horizon || dueOn < floor) continue;

    const serviceId = booking.recallServiceId!;
    const service = config.services.find((s) => s.id === serviceId);
    if (!service) continue;

    const phone = key.slice(0, key.lastIndexOf(":"));
    const bookedFor = answeredBy(bookings, phone, booking.date);
    const overdueDays = daysBetween(dueOn, today);

    const snoozed = booking.recallSnoozedUntil && booking.recallSnoozedUntil > today;
    if (snoozed && !bookedFor && !opts.includeSnoozed) continue;

    items.push({
      guestName: booking.guestName,
      guestPhone: booking.guestPhone,
      dueOn,
      serviceId,
      serviceName: service.name,
      lastVisit: booking.date,
      fromBookingId: booking.id,
      status: bookedFor
        ? "booked"
        : booking.recallContactedAt
          ? "contacted"
          : overdueDays > 0
            ? "overdue"
            : overdueDays === 0
              ? "due"
              : "upcoming",
      overdueDays,
      value: priceFor(service),
      bookedFor,
      contactedAt: booking.recallContactedAt,
      snoozedUntil: booking.recallSnoozedUntil,
    });
  }

  // Overdue before due before upcoming, then by what the visit is worth. A
  // practice working a list from the top should be ringing the people who
  // stopped coming, not the people who are coming next week anyway — and
  // someone already rung sits below both, because the next move there is
  // theirs rather than the practice's.
  const rank: Record<RecallStatus, number> = {
    overdue: 0,
    due: 1,
    upcoming: 2,
    contacted: 3,
    booked: 4,
  };
  return items.sort(
    (a, b) =>
      rank[a.status] - rank[b.status] ||
      b.overdueDays - a.overdueDays ||
      b.value - a.value,
  );
}

/**
 * Has this guest already rebooked the thing they were recalled for?
 *
 * Any confirmed visit after the one that raised the recall counts, whether or
 * not it names the same service — somebody who came in for the cleaning and
 * had a filling instead has been seen, and ringing them to ask why they have
 * not been in is the sort of call that loses a patient.
 */
function answeredBy(
  bookings: Booking[],
  phone: string,
  after: DateStr,
): DateStr | undefined {
  return bookings
    .filter(
      (b) =>
        normalisePhone(b.guestPhone) === phone &&
        b.date > after &&
        (b.status === "confirmed" || b.status === "completed"),
    )
    .sort((a, b) => a.date.localeCompare(b.date))[0]?.date;
}

export interface RecallSummary {
  overdue: number;
  due: number;
  upcoming: number;
  contacted: number;
  booked: number;
  /** What the unanswered part of the list is worth, at list price. */
  outstandingValue: number;
}

/**
 * The number an owner actually reacts to.
 *
 * "Thirty-one patients are overdue and that is AED 14,200 sitting in your
 * recall list" is a sentence that sells a subscription; "you have a recall
 * feature" is not.
 */
export function recallSummary(location: Location, opts: RecallOptions = {}): RecallSummary {
  const items = recallDue(location, opts);
  return {
    overdue: items.filter((i) => i.status === "overdue").length,
    due: items.filter((i) => i.status === "due").length,
    upcoming: items.filter((i) => i.status === "upcoming").length,
    contacted: items.filter((i) => i.status === "contacted").length,
    booked: items.filter((i) => i.status === "booked").length,
    outstandingValue: items
      .filter((i) => i.status === "overdue" || i.status === "due")
      .reduce((n, i) => n + i.value, 0),
  };
}

/**
 * Record that somebody has been rung, or asked to be left alone until later.
 *
 * Written onto the visit that raised the recall — see `Booking.recallContactedAt`.
 * `until` absent simply marks the contact, which moves the item down the list
 * without hiding it: they have been rung, they have not said no.
 */
export function markRecall(
  booking: Booking,
  action: "contacted" | "snooze" | "clear",
  until?: DateStr,
): Booking {
  const at = new Date().toISOString();
  const next: Booking = { ...booking, updatedAt: at };

  if (action === "clear") {
    delete next.recallContactedAt;
    delete next.recallSnoozedUntil;
  } else {
    next.recallContactedAt = at;
    if (action === "snooze") next.recallSnoozedUntil = until;
  }
  return saveBooking(next);
}

/**
 * What the agent says when it rings somebody on the list.
 *
 * Written as a brief rather than a script. A recall call that opens by
 * reciting a date and a treatment name sounds like a debt collection agency;
 * the venue wants it to sound like the practice remembering them.
 */
export function recallBriefing(location: Location, item: RecallItem): string {
  const lines = [
    `You are ringing ${item.guestName} because their ${item.serviceName.toLowerCase()} is due.`,
    `They were last in on ${item.lastVisit}.`,
  ];
  if (item.overdueDays > 30) {
    lines.push(
      `That was a while ago — ${item.overdueDays} days past due. Do not make a point of it.`,
    );
  }
  lines.push(
    `The purpose of the call is to offer them a time, nothing else. If they say no, thank them and leave it; if they want to think about it, say you will leave it with them. Do not press, and do not quote the price unless they ask.`,
  );
  return lines.join(" ");
}

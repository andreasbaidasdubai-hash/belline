import type { Booking, Location, Slot, VenueLanguage } from "../types";
import { signBookingToken } from "../auth";
import { findAvailability } from "./index";
import { lateCancelNotice } from "./policy";
import { instantOf } from "../reminders";
import { addDays, dateToGerman, dateToSpoken, minutesToClock, minutesToGerman, minutesToSpoken, todayIn } from "../time";
import { answersIn, inHouseSpelling } from "../language";
import { copy, type CopyKey } from "../customer-copy";
import { emailEnabled, sendEmail } from "../providers/email";

/**
 * A guest managing their own booking, the way every booking platform lets them.
 *
 * The confirmation email carries one link. Behind it: what was booked, add it
 * to a calendar, change the time, cancel. Everything goes through the same
 * engine and the same house rules the agent obeys — a guest changing a time
 * online cannot take a slot the phone could not, and a late cancellation is
 * judged by the same window whichever door it came through.
 */

function origin(): string {
  return (process.env.PUBLIC_ORIGIN || "https://app.belline.ai").replace(/\/$/, "");
}

export function manageUrl(booking: Booking): string {
  return `${origin()}/b/${signBookingToken(booking.id)}`;
}

export function calendarUrl(booking: Booking): string {
  return `${manageUrl(booking)}/calendar.ics`;
}

/** What was booked, in the words a guest would use. */
export function whatWasBooked(location: Location, booking: Booking, language: VenueLanguage = "en"): string {
  if (booking.vertical === "restaurant") return copy(language, "booking.table_title", { n: booking.partySize ?? "" }).trim();
  const names = (booking.serviceIds ?? [])
    .map((id) => location.salon?.services.find((s) => s.id === id)?.name)
    .filter(Boolean);
  return names.join(" + ") || copy(language, "booking.appointment_title");
}

/**
 * "Friday 12 September at 7:30 PM", or "Freitag, 12. September um 19:30 Uhr"
 * — the day and time of a booking as a confirmation, a reminder or the manage
 * page writes it, in the venue's language.
 */
export function bookingWhen(location: Location, booking: Pick<Booking, "date" | "startMin">, language: VenueLanguage = "en"): string {
  return language === "de"
    ? copy("de", "booking.when", { date: dateToGerman(booking.date, location.timezone), time: minutesToGerman(booking.startMin) })
    : copy("en", "booking.when", { date: dateToSpoken(booking.date, location.timezone), time: minutesToSpoken(booking.startMin) });
}

export function withWhom(location: Location, booking: Booking): string | null {
  return location.salon?.staff.find((s) => s.id === booking.staffId)?.name ?? null;
}

/** Can the guest still act on it from the link? */
export function manageable(
  location: Location,
  booking: Booking,
  now = Date.now(),
  language: VenueLanguage = "en",
): { ok: boolean; why?: string } {
  if (booking.status === "cancelled") return { ok: false, why: copy(language, "booking.cancelled_already") };
  if (booking.status !== "confirmed") return { ok: false, why: copy(language, "booking.taken_place") };
  if (instantOf(booking.date, booking.startMin, location.timezone) <= now) {
    return { ok: false, why: copy(language, "booking.started") };
  }
  return { ok: true };
}

/**
 * Other times the guest could move to.
 *
 * Same services, same person where they had one, the next fortnight, a few
 * per day. The engine is asked exactly as the agent would ask it, with this
 * booking excluded so its own slot is not counted against it.
 */
export function alternativeTimes(location: Location, booking: Booking, days = 14, perDay = 4): Slot[] {
  const today = todayIn(location.timezone);
  const out: Slot[] = [];
  for (let i = 0; i < days && out.length < 40; i++) {
    const date = addDays(today, i);
    const slots = findAvailability(location, {
      locationId: location.id,
      date,
      partySize: booking.partySize,
      serviceIds: booking.serviceIds,
      staffId: booking.staffId,
      excludeBookingId: booking.id,
      guestPhone: booking.guestPhone,
      windowMin: 24 * 60,
    })
      .filter((s) => !(s.date === booking.date && s.startMin === booking.startMin))
      .filter((s) => instantOf(s.date, s.startMin, location.timezone) > Date.now() + 60 * 60 * 1000)
      .sort((a, b) => a.startMin - b.startMin)
      .slice(0, perDay);
    out.push(...slots);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Calendar file
// ---------------------------------------------------------------------------

function icsDate(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function icsText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

export function bookingIcs(location: Location, booking: Booking): string {
  const start = instantOf(booking.date, booking.startMin, location.timezone);
  const end = instantOf(booking.date, booking.endMin, location.timezone);
  const who = withWhom(location, booking);
  const language = answersIn(location);
  const spell = (text: string) => inHouseSpelling(location, text);
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Belline//Bookings//EN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${booking.id}@belline.ai`,
    `DTSTAMP:${icsDate(Date.now())}`,
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsText(`${whatWasBooked(location, booking, language)} — ${location.name}`)}`,
    `LOCATION:${icsText(location.address || location.name)}`,
    `DESCRIPTION:${icsText(
      spell(
        copy(language, "booking.ics_description", {
          ref: booking.ref,
          with: who ? copy(language, "booking.ics_with", { who }) : "",
          link: manageUrl(booking),
        }),
      ),
    )}`,
    `STATUS:${booking.status === "cancelled" ? "CANCELLED" : "CONFIRMED"}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

// ---------------------------------------------------------------------------
// The email
// ---------------------------------------------------------------------------

export type BookingEmailKind = "confirmed" | "changed" | "cancelled";

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function bookingEmail(location: Location, booking: Booking, kind: BookingEmailKind) {
  const language = answersIn(location);
  const t = (key: CopyKey, vars?: Record<string, string | number>) => copy(language, key, vars);
  const what = whatWasBooked(location, booking, language);
  const who = withWhom(location, booking);
  const when = bookingWhen(location, booking, language);
  const heading = t(kind === "confirmed" ? "booking.email_confirmed" : kind === "changed" ? "booking.email_changed" : "booking.email_cancelled");
  const subject = t(
    kind === "cancelled" ? "booking.subject_cancelled" : kind === "changed" ? "booking.subject_changed" : "booking.subject_confirmed",
    { what, when, name: location.name },
  );

  const policy = kind !== "cancelled" ? lateCancelNotice(location, language) : null;
  const deposit =
    kind !== "cancelled" && booking.deposit?.status === "required"
      ? t("booking.deposit_due_email", {
          currency: booking.deposit.currency,
          amount: booking.deposit.amount,
          pay: booking.deposit.link ? t("booking.deposit_pay_here", { link: booking.deposit.link }) : "",
        })
      : null;

  const rows: [string, string][] = [
    [t("booking.label_what"), what],
    ...(who ? ([[t("booking.label_with"), who]] as [string, string][]) : []),
    [t("booking.label_when"), `${when} (${minutesToClock(booking.startMin)})`],
    [t("booking.label_where"), location.address || location.name],
    [t("booking.label_reference"), booking.ref],
  ];

  const text = [
    `${heading}.`,
    "",
    ...rows.map(([k, v]) => `${k}: ${v}`),
    "",
    ...(kind !== "cancelled"
      ? [t("booking.change_or_cancel_link", { link: manageUrl(booking) }), t("booking.add_to_calendar_link", { link: calendarUrl(booking) })]
      : []),
    ...(deposit ? ["", deposit] : []),
    ...(policy ? ["", policy] : []),
    "",
    location.businessPhone ? t("booking.questions", { name: location.name, phone: location.businessPhone }) : `— ${location.name}`,
  ].join("\n");

  const button = (href: string, label: string, primary: boolean) =>
    `<a href="${esc(href)}" style="display:inline-block;padding:12px 20px;border-radius:999px;text-decoration:none;font-weight:600;font-size:14px;${
      primary ? "background:#2667FF;color:#FFFFFF;" : "border:1px solid #DDE3F5;color:#1B2735;"
    }">${esc(label)}</a>`;

  const html = `<!doctype html><html><body style="margin:0;background:#FFFFFF;font-family:Inter,-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1B2735">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FFFFFF;border:1px solid #DDE3F5;border-radius:16px">
<tr><td style="padding:28px 28px 8px">
<p style="margin:0;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#1A4FD6">${esc(location.name)}</p>
<h1 style="margin:10px 0 18px;font-family:'Plus Jakarta Sans',-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-weight:600;font-size:26px;line-height:1.2;letter-spacing:-0.02em">${esc(heading)}</h1>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:15px;line-height:1.5">
${rows
  .map(
    ([k, v]) =>
      `<tr><td style="padding:6px 0;color:#746C63;width:96px;vertical-align:top">${esc(k)}</td><td style="padding:6px 0">${esc(v)}</td></tr>`,
  )
  .join("")}
</table>
</td></tr>
${
  kind !== "cancelled"
    ? `<tr><td style="padding:18px 28px 6px">${button(manageUrl(booking), t("booking.change_or_cancel"), true)}&nbsp; ${button(calendarUrl(booking), t("booking.add_to_calendar"), false)}</td></tr>`
    : ""
}
${deposit ? `<tr><td style="padding:14px 28px 0;font-size:14px;color:#4A443C">${esc(deposit)}</td></tr>` : ""}
${policy ? `<tr><td style="padding:14px 28px 0;font-size:13px;color:#746C63">${esc(policy)}</td></tr>` : ""}
<tr><td style="padding:22px 28px 28px;font-size:13px;color:#746C63">${
    location.businessPhone ? t("booking.questions", { name: esc(location.name), phone: esc(location.businessPhone) }) : esc(location.name)
  }</td></tr>
</table>
<p style="font-size:11px;color:#9A9288;margin:16px 0 0">${t("booking.sent_by", { name: esc(location.name) })}</p>
</td></tr></table></body></html>`;

  // Swiss spelling for a Swiss venue; unchanged for everyone else.
  const spell = (value: string) => inHouseSpelling(location, value);
  return { subject: spell(subject), text: spell(text), html: spell(html) };
}

/** Send the email for this booking, if there is an address and email is on. Never throws. */
export async function sendBookingEmail(
  location: Location,
  booking: Booking,
  kind: BookingEmailKind,
): Promise<{ sent: boolean; reason?: string }> {
  if (!booking.guestEmail) return { sent: false, reason: "No email address on the booking." };
  if (!emailEnabled()) return { sent: false, reason: "Email is not configured." };
  if (location.demo?.enabled || location.prospect) return { sent: false, reason: "Demo venue." };

  const { subject, text, html } = bookingEmail(location, booking, kind);
  return sendEmail({
    to: booking.guestEmail,
    subject,
    text,
    html,
    ...(kind !== "cancelled"
      ? { attachments: [{ filename: "booking.ics", content: bookingIcs(location, booking), contentType: "text/calendar" }] }
      : {}),
  });
}

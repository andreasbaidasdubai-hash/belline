import Link from "next/link";
import type { Booking, Location } from "@/lib/types";
import { getCall, listBookings } from "@/lib/store";
import { dateToSpoken, minutesToSpoken } from "@/lib/time";
import { describeBookingShort } from "@/lib/booking";
import { listCalendarsFor } from "@/lib/integrations/google";
import { listOutlookCalendarsFor } from "@/lib/integrations/outlook";
import { depositsReady } from "@/lib/billing/deposits";
import { LocationTabs, PageHeader } from "@/components/LocationTabs";
import DepositActions from "./DepositActions";

/**
 * What Belline booked into a venue's Google Calendar or Outlook.
 *
 * A calendar venue has no diary to work from: the calendar is where the team
 * looks. Belline still keeps its own record of every booking it made (the
 * calendar provider saves a `Booking` and then writes the event, storing the
 * event id and calendar on it), and that record is what this lists: newest
 * first, so "what did it book this morning" is the top of the page.
 *
 * The calendar column is careful in the same way the Requests page is: a
 * booking whose event has not reached the calendar yet says so, rather than
 * implying it is there.
 */

/** As many as a person reads; the rest are in the calendar. */
const SHOWN = 200;

const STATUS: Record<Booking["status"], string> = {
  confirmed: "Booked",
  cancelled: "Cancelled",
  completed: "Done",
  no_show: "No-show",
};

function calendarState(booking: Booking): string | null {
  const sync = booking.calendarSync;
  if (!sync || sync.state === "synced") return null;
  if (sync.state === "failed") return "Not in the calendar yet: Belline keeps retrying";
  return "Being written to the calendar";
}

export default async function CalendarBookings({ location, service }: { location: Location; service: "google" | "outlook" }) {
  const serviceName = service === "google" ? "Google Calendar" : "Outlook";
  const all = listBookings({ locationId: location.id }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const bookings = all.slice(0, SHOWN);
  const link = service === "google" ? location.google : location.outlook;

  // Names for the calendars bookings went to. Only asked for when some booking
  // is not on the venue calendar, whose name is already stored; a calendar that
  // cannot be listed just now is named by whose it is instead.
  const needNames = bookings.some((b) => b.calendarId && b.calendarId !== link?.calendarId);
  const listed = needNames
    ? await (service === "google" ? listCalendarsFor(location) : listOutlookCalendarsFor(location)).catch(() => null)
    : null;
  const staffName = new Map((location.salon?.staff ?? []).map((s) => [s.id, s.name]));
  const calendarLabel = (b: Booking): string => {
    if (!b.calendarId) return "—";
    if (b.calendarId === link?.calendarId) return link?.calendarName ?? "Venue calendar";
    const named = listed?.find((c) => c.id === b.calendarId)?.name;
    if (named) return named;
    const who = b.staffId ? staffName.get(b.staffId) : undefined;
    return who ? `${who}'s calendar` : "Another calendar";
  };
  const canSendDeposits = depositsReady(location);

  return (
    <>
      <PageHeader
        title="Bookings"
        subtitle={`What Belline booked into your ${serviceName}, newest first. To change or cancel one, do it in Belline so the customer's record and the calendar stay the same.`}
      />
      <LocationTabs base="/bookings" active={location.id} />

      {bookings.length === 0 ? (
        <div className="panel">
          <p className="muted" style={{ padding: "30px 18px", margin: 0, fontSize: 13, lineHeight: 1.6 }}>
            Belline has not booked anything into your {serviceName} yet. Bookings it makes appear here and in the calendar.
          </p>
        </div>
      ) : (
        <div className="panel">
          <div className="table-wrap" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Customer</th>
                  <th>What</th>
                  <th>Calendar</th>
                  <th>Status</th>
                  <th>Conversation</th>
                </tr>
              </thead>
              <tbody>
                {bookings.map((b) => {
                  const call = b.callId ? getCall(b.callId) : undefined;
                  const pending = b.status === "confirmed" ? calendarState(b) : null;
                  return (
                    <tr key={b.id} style={b.status === "cancelled" ? { opacity: 0.55 } : undefined}>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <div style={{ fontWeight: 600 }}>{dateToSpoken(b.date, location.timezone)}</div>
                        <div className="mono muted" style={{ fontSize: 12 }}>
                          {minutesToSpoken(b.startMin)}
                        </div>
                      </td>
                      <td>
                        <div style={{ fontWeight: 600 }}>{b.guestName}</div>
                        <div className="muted" style={{ fontSize: 12 }}>
                          {b.guestPhone}
                        </div>
                      </td>
                      <td style={{ fontSize: 13 }}>
                        {location.salon || b.vertical === "restaurant" ? describeBookingShort(location, b) : "—"}
                        {b.deposit && b.status !== "cancelled" && (
                          <div style={{ marginTop: 5 }}>
                            <DepositActions
                              bookingId={b.id}
                              label={`${b.deposit.currency} ${b.deposit.amount}`}
                              status={b.deposit.status}
                              canSend={canSendDeposits}
                            />
                          </div>
                        )}
                      </td>
                      <td style={{ fontSize: 13 }}>{calendarLabel(b)}</td>
                      <td>
                        <span className="pill">
                          {STATUS[b.status]}
                          {b.status === "cancelled" && b.lateCancel ? " · late" : ""}
                        </span>
                        {pending && (
                          <div style={{ fontSize: 12, color: "var(--warn)", marginTop: 4 }}>{pending}</div>
                        )}
                        <div className="mono muted" style={{ fontSize: 11.5, marginTop: 4 }}>
                          {b.ref}
                        </div>
                      </td>
                      <td style={{ fontSize: 13 }}>
                        {call ? (
                          <Link href={`/calls/${call.id}`} style={{ color: "var(--accent)" }}>
                            Open
                          </Link>
                        ) : (
                          <span className="muted">{b.source === "manual" ? "Added by your team" : "—"}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {all.length > SHOWN && (
            <p className="muted" style={{ padding: "12px 16px", margin: 0, fontSize: 12.5 }}>
              The latest {SHOWN} of {all.length}. Older bookings are in your {serviceName}.
            </p>
          )}
        </div>
      )}
    </>
  );
}

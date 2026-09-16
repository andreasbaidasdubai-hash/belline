import Link from "next/link";
import { requireUser, resolveLocation } from "@/lib/auth-server";
import { seedIfEmpty } from "@/lib/seed";
import { listCalls, getBooking } from "@/lib/store";
import { describeRequest } from "@/lib/booking/requests";
import { googleUsable, outlookUsable, takesRequestsOnly } from "@/lib/booking/destination";
import { LocationTabs, PageHeader } from "@/components/LocationTabs";

export const dynamic = "force-dynamic";

export const metadata = { title: "Requests" };

/**
 * Booking requests Belline took, and what became of them.
 *
 * This is the screen the pivot needs most and the one the old dashboard never
 * had. Belline does not run the diary any more: on most accounts it takes the
 * customer's details and the time they asked for, and a person confirms it.
 * Until now the only trace of that was an item on the attention list that
 * disappeared once somebody cleared it, so "how many bookings did this thing
 * actually bring us" had no answer.
 *
 * The status column is deliberately careful, because the strategy document is
 * explicit that an estimate must never be shown as a confirmation:
 *
 *   Booked      — a real booking record exists, so a provider confirmed it.
 *   With your team — Belline took it and somebody has to confirm it.
 *
 * There is no third state that means "probably fine". Where a calendar is
 * connected and its flag (`booking.google`, `booking.outlook`) is on, the booking is the event; where it is
 * not, the request is all there is and the page says so rather than implying
 * a calendar wrote it down.
 */
export default async function RequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ loc?: string }>;
}) {
  seedIfEmpty();
  const user = await requireUser();
  const { loc } = await searchParams;
  const location = await resolveLocation(user, loc);
  if (!location) return <p className="muted">No venues are assigned to your account yet.</p>;

  const calls = listCalls(location.id).filter((c) => !c.isDemo);
  const rows = calls
    .flatMap((call) =>
      (call.bookingRequests ?? []).map((request) => ({
        request,
        call,
        booking: call.bookingId ? getBooking(call.bookingId) : undefined,
      })),
    )
    .sort((a, b) => b.request.at.localeCompare(a.request.at));

  // Where the request goes once Belline has taken it. Said once, at the top,
  // rather than repeated down a column.
  const connected = googleUsable(location) ? "Google Calendar" : outlookUsable(location) ? "Outlook calendar" : null;
  const requestsOnly = takesRequestsOnly(location);
  const where = connected
    ? `This venue's ${connected} is connected, so Belline books into it and the event is linked below.`
    : requestsOnly
      ? "Belline takes the details and your team confirms each one. No calendar is connected to this venue yet."
      : "Belline books these into your Belline diary.";

  return (
    <>
      <PageHeader
        title="Requests"
        subtitle={`Every booking Belline was asked for, and what happened to it. ${where}`}
      />
      <LocationTabs base="/requests" active={location.id} />

      <div className="panel">
        {rows.length === 0 ? (
          <p className="muted" style={{ padding: "30px 18px", margin: 0, fontSize: 13 }}>
            No booking requests yet. When somebody asks Belline for a time, the details land here.
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 150 }}>Taken</th>
                  <th>What they asked for</th>
                  <th style={{ width: 170 }}>Who</th>
                  <th style={{ width: 150 }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ request, call, booking }) => (
                  <tr key={request.id}>
                    <td className="mono muted" style={{ fontSize: 12 }}>
                      {new Date(request.at).toLocaleString()}
                    </td>
                    <td>
                      <Link href={`/calls/${call.id}`} style={{ fontWeight: 600 }}>
                        {describeRequest(request)}
                      </Link>
                      {request.notes && (
                        <div className="muted" style={{ fontSize: 11.5, marginTop: 3 }}>
                          {request.notes}
                        </div>
                      )}
                    </td>
                    <td style={{ fontSize: 12.5 }}>
                      {request.guestName}
                      <div className="muted mono" style={{ fontSize: 11.5, marginTop: 3 }}>
                        {request.guestPhone}
                      </div>
                    </td>
                    <td style={{ fontSize: 12.5 }}>
                      {booking ? (
                        <>
                          <span style={{ color: "var(--ok)" }}>Booked</span>
                          <div className="muted mono" style={{ fontSize: 11.5, marginTop: 3 }}>
                            {booking.ref}
                          </div>
                        </>
                      ) : (
                        <span style={{ color: "var(--warn)" }}>With your team</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

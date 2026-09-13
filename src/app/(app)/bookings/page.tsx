import Link from "next/link";
import { listBookings } from "@/lib/store";
import { requireUser, resolveLocation } from "@/lib/auth-server";
import { addDays, minutesToSpoken, dateToSpoken, todayIn } from "@/lib/time";
import { describeBookingShort } from "@/lib/booking";
import { terms } from "@/lib/verticals";
import { seedIfEmpty } from "@/lib/seed";
import { LocationTabs, PageHeader } from "@/components/LocationTabs";
import Progress from "./Progress";
import CancelBooking from "./CancelBooking";
import DepositActions from "./DepositActions";
import { depositsReady } from "@/lib/billing/deposits";

export const dynamic = "force-dynamic";

/** How far back the list reaches, so last night can still be tidied up. */
const RECENT_DAYS = 3;

export default async function BookingsPage({
  searchParams,
}: {
  searchParams: Promise<{ loc?: string }>;
}) {
  seedIfEmpty();
  const user = await requireUser();
  const { loc } = await searchParams;
  const location = await resolveLocation(user, loc);
  if (!location) return <p className="muted">No venues are assigned to your account yet.</p>;
  const t = terms(location);
  const canSendDeposits = depositsReady(location);

  const today = todayIn(location.timezone);
  // A few days back as well as forward.
  //
  // Upcoming-only was right while this page was a list to read. It is now a
  // list to work — somebody ticks people off as they arrive — and nobody marks
  // last night's no-shows during last night. They do it the next morning, and
  // a page that had already dropped yesterday made that impossible, which left
  // the no-show rule in the house rules permanently unreachable.
  const from = addDays(today, -RECENT_DAYS);
  const bookings = listBookings({ locationId: location.id })
    .filter((b) => b.date >= from)
    .sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin);

  const byDate = new Map<string, typeof bookings>();
  for (const b of bookings) {
    const list = byDate.get(b.date) ?? [];
    list.push(b);
    byDate.set(b.date, list);
  }

  return (
    <>
      <PageHeader
        title="Bookings"
        subtitle={`Everything the agent took, alongside anything entered by hand. Mark ${t.guests} in as they arrive — a no-show recorded here is what the house rules count.`}
      />
      <LocationTabs base="/bookings" active={location.id} />

      {byDate.size === 0 ? (
        <div className="panel">
          <p className="muted" style={{ padding: "30px 18px", margin: 0, fontSize: 13 }}>
            Nothing upcoming. Take a booking in the{" "}
            <Link href="/test" style={{ color: "var(--accent)" }}>test console</Link>.
          </p>
        </div>
      ) : (
        [...byDate.entries()].map(([date, list]) => (
          <div key={date} className="panel" style={{ marginBottom: 14 }}>
            <div
              style={{
                padding: "12px 16px",
                borderBottom: "1px solid var(--border)",
                fontWeight: 600,
                fontSize: 13,
                display: "flex",
                gap: 10,
                alignItems: "baseline",
              }}
            >
              {dateToSpoken(date, location.timezone)}
              <span className="muted" style={{ fontWeight: 400, fontSize: 12, marginLeft: "auto" }}>
                {location.vertical === "restaurant"
                  ? `${list.filter((b) => b.status === "confirmed").reduce((n, b) => n + (b.partySize ?? 0), 0)} covers`
                  : `${list.filter((b) => b.status === "confirmed").length} appointments`}
              </span>
            </div>
            <div className="table-wrap" tabIndex={0}>
            <table className="booking-table">
              <tbody>
                {list.map((b) => {
                  const cancelled = b.status !== "confirmed";
                  const detail = describeBookingShort(location, b);
                  return (
                    <tr key={b.id} style={cancelled ? { opacity: 0.42 } : undefined}>
                      <td
                        className="mono"
                        style={{ width: 88, color: "var(--gold-ink)", whiteSpace: "nowrap" }}
                      >
                        {minutesToSpoken(b.startMin)}
                      </td>
                      <td>
                        <div
                          style={{
                            fontWeight: 600,
                            textDecoration: cancelled ? "line-through" : "none",
                          }}
                        >
                          {b.guestName}
                        </div>
                        <div className="muted" style={{ fontSize: 12 }}>
                          {detail}
                        </div>
                        {b.notes && (
                          <div style={{ fontSize: 12, color: "var(--warn)", marginTop: 3 }}>
                            ✎ {b.notes}
                          </div>
                        )}
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
                      <td className="muted" style={{ width: 120, fontSize: 12 }}>
                        {b.guestPhone}
                      </td>
                      <td style={{ width: 92 }}>
                        <span className="pill">{b.source}</span>
                      </td>
                      <td style={{ width: 170, textAlign: "right" }}>
                        {/* Only where it can still mean something: nobody
                            arrives for tomorrow, and a cancellation is already
                            settled. */}
                        {b.date <= today && b.status !== "cancelled" ? (
                          <Progress
                            locationId={location.id}
                            booking={{ id: b.id, status: b.status, service: b.service }}
                            guestWord={t.guest}
                          />
                        ) : b.status === "cancelled" ? (
                          <span className="pill">cancelled{b.lateCancel ? " · late" : ""}</span>
                        ) : (
                          // Tomorrow's booking, still confirmed: the only thing
                          // to do to it from the desk is take it off the book.
                          <CancelBooking bookingId={b.id} guestName={b.guestName} />
                        )}
                      </td>
                      <td style={{ width: 80, textAlign: "right" }}>
                        <span className="pill mono">{b.ref}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          </div>
        ))
      )}
    </>
  );
}

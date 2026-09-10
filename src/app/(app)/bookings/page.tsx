import Link from "next/link";
import { listBookings } from "@/lib/store";
import { requireUser, resolveLocation } from "@/lib/auth-server";
import { minutesToSpoken, dateToSpoken, todayIn } from "@/lib/time";
import { describeBookingShort } from "@/lib/booking";
import { seedIfEmpty } from "@/lib/seed";
import { LocationTabs, PageHeader } from "@/components/LocationTabs";

export const dynamic = "force-dynamic";

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

  const today = todayIn(location.timezone);
  const bookings = listBookings({ locationId: location.id })
    .filter((b) => b.date >= today)
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
        subtitle="Upcoming only. Everything the agent took is here alongside anything entered by hand."
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
              <span className="muted mono" style={{ fontWeight: 400, fontSize: 11.5 }}>
                {date}
              </span>
              <span className="muted" style={{ fontWeight: 400, fontSize: 12, marginLeft: "auto" }}>
                {location.vertical === "restaurant"
                  ? `${list.filter((b) => b.status === "confirmed").reduce((n, b) => n + (b.partySize ?? 0), 0)} covers`
                  : `${list.filter((b) => b.status === "confirmed").length} appointments`}
              </span>
            </div>
            <div className="table-wrap">
            <table>
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
                      </td>
                      <td className="muted" style={{ width: 120, fontSize: 12 }}>
                        {b.guestPhone}
                      </td>
                      <td style={{ width: 92 }}>
                        <span className="pill">{b.source}</span>
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

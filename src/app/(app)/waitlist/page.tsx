import Link from "next/link";
import { requireUser, resolveLocation } from "@/lib/auth-server";
import { seedIfEmpty } from "@/lib/seed";
import { openEntries, matchesFor } from "@/lib/waitlist";
import { minutesToSpoken, dateToSpoken, todayIn } from "@/lib/time";
import { isRestaurant } from "@/lib/verticals";
import { LocationTabs, PageHeader } from "@/components/LocationTabs";

export const dynamic = "force-dynamic";

export default async function WaitlistPage({
  searchParams,
}: {
  searchParams: Promise<{ loc?: string }>;
}) {
  seedIfEmpty();
  const user = await requireUser();
  const { loc } = await searchParams;
  const location = await resolveLocation(user, loc);
  if (!location) return <p className="muted">No venues are assigned to your account yet.</p>;

  const entries = openEntries(location.id);
  const today = todayIn(location.timezone);
  // Only today's matches: a slot free next Tuesday is not urgent, and marking
  // it so would make the whole list stop meaning anything.
  const matched = new Set(matchesFor(location, today).map((m) => m.entry.id));

  return (
    <>
      <PageHeader
        title="Waitlist"
        subtitle="People who wanted a time that was gone. A full Friday is not a lost caller — it is a caller nobody wrote down."
      />
      <LocationTabs base="/waitlist" active={location.id} />

      {entries.length === 0 ? (
        <div className="panel">
          <p className="muted" style={{ padding: "30px 18px", margin: 0, fontSize: 13 }}>
            Nobody waiting. Belline offers the list when a caller cannot have the time they
            asked for and no alternative suits them.
          </p>
        </div>
      ) : (
        <div className="panel">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Who</th>
                  <th>When they would come</th>
                  <th>For</th>
                  <th>Asked</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => {
                  const free = matched.has(entry.id);
                  return (
                    <tr key={entry.id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{entry.guestName}</div>
                        <div className="muted" style={{ fontSize: 12 }}>
                          {entry.guestPhone}
                        </div>
                      </td>
                      <td style={{ fontSize: 13 }}>
                        {dateToSpoken(entry.date, location.timezone)}
                        <div className="muted" style={{ fontSize: 12 }}>
                          {minutesToSpoken(entry.earliestMin)} – {minutesToSpoken(entry.latestMin)}
                        </div>
                      </td>
                      <td style={{ fontSize: 13 }}>
                        {isRestaurant(location)
                          ? `${entry.partySize ?? 2} covers`
                          : (entry.serviceIds ?? [])
                              .map(
                                (sid) =>
                                  (location.salon?.services ?? []).find((s) => s.id === sid)?.name,
                              )
                              .filter(Boolean)
                              .join(" + ") || "Appointment"}
                        {entry.notes && (
                          <div style={{ fontSize: 12, color: "var(--warn)", marginTop: 3 }}>
                            ✎ {entry.notes}
                          </div>
                        )}
                      </td>
                      <td className="muted" style={{ fontSize: 12, width: 110 }}>
                        {new Date(entry.createdAt).toLocaleDateString("en-GB", {
                          day: "numeric",
                          month: "short",
                        })}
                      </td>
                      <td style={{ width: 210, textAlign: "right" }}>
                        {free ? (
                          <span
                            className="pill"
                            style={{
                              background: "var(--ok-soft)",
                              color: "var(--ok)",
                              borderColor: "var(--ok)",
                            }}
                          >
                            Something is free
                          </span>
                        ) : entry.status === "offered" ? (
                          <span className="pill">Offered</span>
                        ) : (
                          <span className="pill">Waiting</span>
                        )}{" "}
                        {entry.callId && (
                          <Link className="btn" href={`/calls/${entry.callId}`}>
                            Call
                          </Link>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p className="muted" style={{ fontSize: 12, marginTop: 12, maxWidth: "72ch", lineHeight: 1.6 }}>
        When a booking is cancelled or moved, anyone whose window now has a real opening
        appears at the top of <Link href="/attention" style={{ color: "var(--accent)" }}>Needs you</Link>{" "}
        with a number to ring. Matches are checked against the booking engine, so a slot
        offered is a slot they can actually have.
      </p>
    </>
  );
}

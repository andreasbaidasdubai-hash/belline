import Link from "next/link";
import { requireUser, resolveLocation } from "@/lib/auth-server";
import { dateToSpoken, minutesToSpoken } from "@/lib/time";
import { seedIfEmpty } from "@/lib/seed";
import { guestKey, searchGuests } from "@/lib/guest-profile";
import { LocationTabs, PageHeader } from "@/components/LocationTabs";

export const dynamic = "force-dynamic";

/**
 * Customers — everyone who has booked or called, searchable, each a profile.
 *
 * Built from who actually calls and books; the receptionist reads the same
 * record before it speaks, so a regular is greeted as one.
 */
export default async function GuestsPage({
  searchParams,
}: {
  searchParams: Promise<{ loc?: string; q?: string }>;
}) {
  seedIfEmpty();
  const user = await requireUser();
  const { loc, q = "" } = await searchParams;
  const location = await resolveLocation(user, loc);
  if (!location) return <p className="muted">No venues are assigned to your account yet.</p>;

  const all = searchGuests(location, "");
  const guests = q.trim() ? searchGuests(location, q) : all;
  const returning = all.filter((g) => g.visits > 1).length;

  return (
    <>
      <PageHeader
        title="Customers"
        subtitle="Everyone who has booked or called. Open anyone for their visits, calls, spend and notes."
      />
      <LocationTabs base="/guests" active={location.id} />

      <form method="get" style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
        <input type="hidden" name="loc" value={location.id} />
        <input name="q" defaultValue={q} placeholder="Search by name, number or email" aria-label="Search customers" style={{ flex: "1 1 280px", maxWidth: 420 }} />
        <button className="btn">Search</button>
        {q && <Link className="btn" href={`/guests?loc=${location.id}`}>Clear</Link>}
        <span className="pill mono" style={{ marginLeft: "auto" }}>{all.length} customers</span>
        <span className="pill mono">{returning} returning</span>
      </form>

      {guests.length === 0 ? (
        <div className="panel">
          <p className="muted" style={{ padding: "30px 18px", margin: 0, fontSize: 13 }}>
            {q
              ? `Nobody matches “${q}”.`
              : "No customers yet. Every booking and call adds one — take a booking from the calendar or let Belline answer a call."}
          </p>
        </div>
      ) : (
        <div className="panel">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th style={{ width: 76 }}>Visits</th>
                  <th style={{ width: 150 }}>Last seen</th>
                  <th>Usually</th>
                  <th style={{ width: 190 }}>Next booking</th>
                </tr>
              </thead>
              <tbody>
                {guests.map((g) => (
                  <tr key={g.phone}>
                    <td>
                      <Link href={`/guests/${guestKey(g.phone)}?loc=${location.id}`} style={{ fontWeight: 600 }}>
                        {g.name || "—"}
                      </Link>
                      <div className="muted mono" style={{ fontSize: 11.5 }}>{g.phone}</div>
                      {g.notes.length > 0 && (
                        <div style={{ fontSize: 11.5, color: "var(--warn)", marginTop: 4 }}>✎ {g.notes.join("; ")}</div>
                      )}
                    </td>
                    <td className="mono">
                      {g.visits}
                      {g.noShows > 0 && (
                        <div style={{ fontSize: 11, color: "var(--bad)" }}>
                          {g.noShows} no-show{g.noShows === 1 ? "" : "s"}
                        </div>
                      )}
                      {g.cancellations > 0 && (
                        <div className="muted" style={{ fontSize: 11 }}>{g.cancellations} cancelled</div>
                      )}
                    </td>
                    <td className="muted" style={{ fontSize: 12 }}>
                      {g.lastVisit ? dateToSpoken(g.lastVisit, location.timezone) : "—"}
                    </td>
                    <td className="muted" style={{ fontSize: 12.5 }}>{g.usual ?? "—"}</td>
                    <td style={{ fontSize: 12.5 }}>
                      {g.upcoming.length === 0 ? (
                        <span className="muted">—</span>
                      ) : (
                        <Link href={`/calendar?loc=${location.id}&date=${g.upcoming[0].date}&open=${g.upcoming[0].id}`}>
                          {dateToSpoken(g.upcoming[0].date, location.timezone)} at {minutesToSpoken(g.upcoming[0].startMin)}
                          <span className="pill mono" style={{ marginLeft: 6 }}>{g.upcoming[0].ref}</span>
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

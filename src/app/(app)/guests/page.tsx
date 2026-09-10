import { listGuests } from "@/lib/guests";
import { requireUser, resolveLocation } from "@/lib/auth-server";
import { dateToSpoken, minutesToSpoken } from "@/lib/time";
import { seedIfEmpty } from "@/lib/seed";
import { LocationTabs, PageHeader } from "@/components/LocationTabs";

export const dynamic = "force-dynamic";

export default async function GuestsPage({
  searchParams,
}: {
  searchParams: Promise<{ loc?: string }>;
}) {
  seedIfEmpty();
  const user = await requireUser();
  const { loc } = await searchParams;
  const location = await resolveLocation(user, loc);
  if (!location) return <p className="muted">No venues are assigned to your account yet.</p>;

  const guests = listGuests(location);
  const returning = guests.filter((g) => g.visits > 1).length;

  return (
    <>
      <PageHeader
        title="Guests"
        subtitle="Built from who actually calls. The agent reads this before it speaks, so a regular is greeted as one."
      />
      <LocationTabs base="/guests" active={location.id} />

      {guests.length === 0 ? (
        <div className="panel">
          <p className="muted" style={{ padding: "30px 18px", margin: 0, fontSize: 13 }}>
            Nobody yet. Take two bookings from the same number in the test console and
            this fills in — the second call will be greeted by name.
          </p>
        </div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
            <span className="pill mono">{guests.length} known</span>
            <span className="pill mono">{returning} returning</span>
          </div>

          <div className="panel">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Guest</th>
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
                        <div style={{ fontWeight: 600 }}>{g.name || "—"}</div>
                        <div className="muted mono" style={{ fontSize: 11.5 }}>
                          {g.phone}
                        </div>
                        {g.notes.length > 0 && (
                          <div style={{ fontSize: 11.5, color: "var(--warn)", marginTop: 4 }}>
                            ✎ {g.notes.join("; ")}
                          </div>
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
                          <div className="muted" style={{ fontSize: 11 }}>
                            {g.cancellations} cancelled
                          </div>
                        )}
                      </td>
                      <td className="muted" style={{ fontSize: 12 }}>
                        {g.lastVisit ? dateToSpoken(g.lastVisit, location.timezone) : "—"}
                      </td>
                      <td className="muted" style={{ fontSize: 12.5 }}>
                        {g.usual ?? "—"}
                      </td>
                      <td style={{ fontSize: 12.5 }}>
                        {g.upcoming.length === 0 ? (
                          <span className="muted">—</span>
                        ) : (
                          <>
                            {dateToSpoken(g.upcoming[0].date, location.timezone)} at{" "}
                            {minutesToSpoken(g.upcoming[0].startMin)}
                            <span className="pill mono" style={{ marginLeft: 6 }}>
                              {g.upcoming[0].ref}
                            </span>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </>
  );
}

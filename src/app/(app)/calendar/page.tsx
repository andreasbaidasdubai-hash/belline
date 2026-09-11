import Link from "next/link";
import { requireUser, resolveLocation } from "@/lib/auth-server";
import { seedIfEmpty } from "@/lib/seed";
import { dayView } from "@/lib/calendar";
import { addDays, dateToSpoken, minutesToClock, todayIn } from "@/lib/time";
import { isRestaurant } from "@/lib/verticals";
import { LocationTabs, PageHeader } from "@/components/LocationTabs";
import Grid from "./Grid";

export const dynamic = "force-dynamic";

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ loc?: string; date?: string }>;
}) {
  seedIfEmpty();
  const user = await requireUser();
  const { loc, date } = await searchParams;
  const location = await resolveLocation(user, loc);
  if (!location) return <p className="muted">No venues are assigned to your account yet.</p>;

  const today = todayIn(location.timezone);
  const on = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today;
  const view = dayView(location, on);

  const link = (d: string) => `/calendar?loc=${location.id}&date=${d}`;
  const busiest = [...view.pacing].sort((a, b) => b.covers - a.covers)[0];

  return (
    <>
      <PageHeader
        title="Calendar"
        subtitle={
          isRestaurant(location)
            ? "The room, by table. Turn times are drawn to scale, so a tight nine o'clock looks tight."
            : "The diary, by person. The paler tail on each appointment is the turnaround the guest was never quoted."
        }
        right={
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Link className="btn" href={link(addDays(on, -1))} aria-label="Previous day">
              ←
            </Link>
            <Link className="btn" href={link(today)}>
              Today
            </Link>
            <Link className="btn" href={link(addDays(on, 1))} aria-label="Next day">
              →
            </Link>
          </div>
        }
      />
      <LocationTabs base="/calendar" active={location.id} />

      <div className="panel" style={{ padding: "14px 18px", marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 22, alignItems: "baseline", flexWrap: "wrap" }}>
          <div style={{ fontWeight: 600, fontSize: 14.5 }}>
            {dateToSpoken(on, location.timezone)}
            {on === today && (
              <span className="pill" style={{ marginLeft: 9 }}>
                today
              </span>
            )}
          </div>
          <div className="muted" style={{ fontSize: 12.5 }}>
            {isRestaurant(location)
              ? `${view.covers} covers across ${view.appointments} reservations`
              : `${view.appointments} appointments`}
          </div>
          {busiest && (
            <div
              className="muted"
              style={{
                fontSize: 12.5,
                marginLeft: "auto",
                color: busiest.covers > busiest.cap ? "var(--bad)" : undefined,
              }}
            >
              Busiest slot {minutesToClock(busiest.startMin)} — {busiest.covers} of {busiest.cap}
              {busiest.covers > busiest.cap ? " · over the kitchen's cap" : ""}
            </div>
          )}
        </div>
      </div>

      {view.columns.length === 0 ? (
        <div className="panel">
          <p className="muted" style={{ padding: "30px 18px", margin: 0, fontSize: 13 }}>
            Nothing to draw a day against yet —{" "}
            {isRestaurant(location) ? "no tables are configured." : "no staff are configured."}
          </p>
        </div>
      ) : (
        <Grid view={view} />
      )}

      {view.unplaced.length > 0 && (
        <div className="panel" style={{ marginTop: 16, padding: "14px 18px" }}>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
            Not on the grid ({view.unplaced.length})
          </div>
          <p className="muted" style={{ fontSize: 12.5, margin: "0 0 8px" }}>
            Booked, but not assigned to {isRestaurant(location) ? "a table" : "a person"} — so they
            would be invisible on a calendar that only drew what it could place.
          </p>
          {view.unplaced.map((b) => (
            <div key={b.id} style={{ fontSize: 13 }}>
              {minutesToClock(b.startMin)} · {b.guestName} · <span className="mono">{b.ref}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

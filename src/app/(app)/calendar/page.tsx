import Link from "next/link";
import { requireUser, resolveLocation } from "@/lib/auth-server";
import { seedIfEmpty } from "@/lib/seed";
import { dayView, resourceView, weekView, weekStart } from "@/lib/calendar";
import { addDays, dateToSpoken, minutesToClock, todayIn } from "@/lib/time";
import { isRestaurant } from "@/lib/verticals";
import { LocationTabs, PageHeader } from "@/components/LocationTabs";
import Grid from "./Grid";

export const dynamic = "force-dynamic";

/** "an injectables" rather than "a injectables". Service names are the venue's. */
function article(name: string): string {
  return /^[aeiou]/i.test(name.trim()) ? "an" : "a";
}

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ loc?: string; date?: string; axis?: string }>;
}) {
  seedIfEmpty();
  const user = await requireUser();
  const { loc, date, axis } = await searchParams;
  const location = await resolveLocation(user, loc);
  if (!location) return <p className="muted">No venues are assigned to your account yet.</p>;

  const today = todayIn(location.timezone);
  const on = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today;

  // The constraint that actually binds in a clinic is almost always the room,
  // not the practitioner — "is surgery two free at two" is a question a diary
  // drawn by person cannot answer. Same grid, other axis.
  const rooms = (location.salon?.resources ?? []).length > 0;
  const byRoom = rooms && axis === "rooms";
  const view = byRoom ? resourceView(location, on) : dayView(location, on);
  const week = weekView(location, weekStart(on));

  const link = (d: string) =>
    `/calendar?loc=${location.id}&date=${d}${byRoom ? "&axis=rooms" : ""}`;
  const axisLink = (a: string) => `/calendar?loc=${location.id}&date=${on}&axis=${a}`;
  const busiest = [...view.pacing].sort((a, b) => b.covers - a.covers)[0];
  const sellable = view.gaps.slice(0, 6);
  const sellableValue = view.gaps.reduce((n, g) => n + g.value, 0);

  return (
    <>
      <PageHeader
        title="Calendar"
        subtitle={
          byRoom
            ? "The day by room, chair and machine — the constraint that usually binds, and the one a diary drawn by person cannot show."
            : isRestaurant(location)
              ? "The room, by table. Turn times are drawn to scale, so a tight nine o'clock looks tight."
              : "The diary, by person. The paler tail is the turnaround nobody was quoted; the dashed band inside an appointment is time the chair is taken and the stylist is not."
        }
        right={
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {rooms && (
              <div style={{ display: "flex", gap: 4, marginRight: 6 }}>
                <Link className={`btn${byRoom ? "" : " on"}`} href={axisLink("people")}>
                  People
                </Link>
                <Link className={`btn${byRoom ? " on" : ""}`} href={axisLink("rooms")}>
                  Rooms
                </Link>
              </div>
            )}
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

      {/* The week above the day: where are we thin, then what is happening. */}
      <div className="cal-week" style={{ marginBottom: 16 }}>
        {week.map((day) => (
          <Link
            key={day.date}
            href={link(day.date)}
            className={`cal-week-day${day.date === on ? " on" : ""}${day.closed ? " closed" : ""}`}
            aria-current={day.date === on ? "date" : undefined}
          >
            <span className="cal-week-name">
              {new Date(`${day.date}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short" })}
            </span>
            <span className="cal-week-num">{Number(day.date.slice(8))}</span>
            <span className="cal-week-bar" aria-hidden="true">
              <span
                className={`cal-week-fill${
                  day.peak && day.peak.covers > day.peak.cap ? " over" : ""
                }`}
                style={{ height: `${Math.round(day.load * 100)}%` }}
              />
            </span>
            <span className="cal-week-sub">
              {day.closed
                ? "closed"
                : isRestaurant(location)
                  ? day.covers > 0
                    ? `${day.covers}`
                    : "—"
                  : day.appointments > 0
                    ? `${day.appointments}`
                    : "—"}
            </span>
            {day.isToday && <span className="cal-week-today" aria-label="today" />}
          </Link>
        ))}
      </div>

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
              : `${view.appointments} appointments · ${location.currency} ${view.revenue.toLocaleString()}`}
          </div>
          {/* Sold against rostered, not against the clock: a salon with three
              people in is not half empty because the grid runs to seven.
              Withheld for a restaurant, where minutes of table time is the
              wrong measure — a room is full when the seats are gone, not when
              the hours are, and the covers and the pacing beside this already
              say that properly. */}
          {!isRestaurant(location) && (
            <div className="muted" style={{ fontSize: 12.5 }}>
              {Math.round(view.utilisation * 100)}% of the {byRoom ? "rooms" : "day"} sold
            </div>
          )}
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
            {isRestaurant(location) ? "no tables are set up." : "no staff are set up."}{" "}
            <Link href={`/venue?loc=${location.id}`} style={{ color: "var(--accent)", textDecoration: "underline" }}>
              Add them under How it works
            </Link>
            .
          </p>
        </div>
      ) : (
        <Grid
          view={view}
          locationId={location.id}
          isRestaurant={isRestaurant(location)}
          bookable={!byRoom}
          overbookAllowed={(location.restaurant?.overbookPerSlot ?? 0) > 0}
          services={(location.salon?.services ?? []).map((s) => ({
            id: s.id,
            name: s.name,
            durationMin: s.durationMin,
          }))}
        />
      )}

      {/* The thing a calendar normally leaves for somebody to notice. A hole
          long enough to sell is a call worth making, and until it is counted
          and priced nobody ever makes it. */}
      {sellable.length > 0 && (
        <div className="panel" style={{ marginTop: 16, padding: "14px 18px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 12,
              marginBottom: 8,
              flexWrap: "wrap",
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 13 }}>
              Time still to sell ({view.gaps.length})
            </div>
            {/* Not on the room axis. One appointment can occupy a surgery and
                a machine at once, so adding the two rooms' empty time together
                counts the same lost treatment twice — and a number that
                flatters itself is one nobody trusts twice. */}
            {sellableValue > 0 && !byRoom && (
              <div className="muted" style={{ fontSize: 12.5 }}>
                about {location.currency} {sellableValue.toLocaleString()} if every gap went
              </div>
            )}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 18px" }}>
            {sellable.map((gap) => (
              <div key={`${gap.columnId}-${gap.startMin}`} style={{ fontSize: 12.5 }}>
                <span className="mono">
                  {minutesToClock(gap.startMin)}–{minutesToClock(gap.endMin)}
                </span>{" "}
                {gap.columnName}
                <span className="muted">
                  {" "}
                  · {gap.minutes} min
                  {gap.fits ? ` · fits ${article(gap.fits)} ${gap.fits.toLowerCase()}` : ""}
                </span>
              </div>
            ))}
          </div>
        </div>
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

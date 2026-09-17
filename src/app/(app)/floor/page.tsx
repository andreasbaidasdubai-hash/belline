import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser, resolveLocation } from "@/lib/auth-server";
import { canEditAgent } from "@/lib/auth";
import { seedIfEmpty } from "@/lib/seed";
import { floorState } from "@/lib/floor";
import { nowMinutesIn, todayIn } from "@/lib/time";
import { LocationTabs, PageHeader } from "@/components/LocationTabs";
import { notOnDiaryHome, usesDiary } from "@/lib/nav";
import FloorPlan from "./FloorPlan";

export const dynamic = "force-dynamic";

/** The room as a host sees it: every table, and what is happening at it now. */
export default async function FloorPage({ searchParams }: { searchParams: Promise<{ loc?: string }> }) {
  seedIfEmpty();
  const user = await requireUser();
  const { loc } = await searchParams;
  const location = await resolveLocation(user, loc);
  if (!location) return <p className="muted">No venues are assigned to your account yet.</p>;
  // A diary page, for the venues on the diary. Everybody else goes where their bookings are.
  if (!usesDiary(location)) redirect(notOnDiaryHome(location));

  if (!location.restaurant) {
    return (
      <>
        <PageHeader title="Floor" />
        <LocationTabs base="/floor" active={location.id} />
        <div className="panel">
          <p className="muted" style={{ padding: "26px 18px", margin: 0, fontSize: 13.5 }}>
            The floor plan is for restaurants. {location.name} books people rather than tables —{" "}
            <Link href={`/calendar?loc=${location.id}`}>open the calendar</Link> or{" "}
            <Link href={`/rota?loc=${location.id}`}>the rota</Link>.
          </p>
        </div>
      </>
    );
  }

  const today = todayIn(location.timezone);
  const now = nowMinutesIn(location.timezone);
  const tables = floorState(location, today, now);

  return (
    <>
      <PageHeader title="Floor" subtitle={`${location.name}, now. Refreshes by itself as guests arrive and bookings come in.`} />
      <LocationTabs base="/floor" active={location.id} />
      {tables.length === 0 ? (
        <div className="panel">
          <p className="muted" style={{ padding: "26px 18px", margin: 0, fontSize: 13.5 }}>
            No tables yet. <Link href={`/venue/diary?loc=${location.id}`}>Add them under How it works</Link>.
          </p>
        </div>
      ) : (
        <FloorPlan
          key={tables.map((t) => `${t.id}:${t.x}:${t.y}:${t.status}`).join("|")}
          locationId={location.id}
          date={today}
          nowMin={now}
          tables={tables}
          canArrange={canEditAgent(user, location.id)}
          currency={location.currency}
          overbookAllowed={(location.restaurant.overbookPerSlot ?? 0) > 0}
        />
      )}
    </>
  );
}

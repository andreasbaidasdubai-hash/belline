import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser, resolveLocation } from "@/lib/auth-server";
import { seedIfEmpty } from "@/lib/seed";
import { weekRota } from "@/lib/rota";
import { weekStart } from "@/lib/calendar";
import { addDays, todayIn } from "@/lib/time";
import { LocationTabs, PageHeader } from "@/components/LocationTabs";
import RotaEditor from "./RotaEditor";

export const dynamic = "force-dynamic";

/** Who works when, this week and any week — and what a change would strand. */
export default async function RotaPage({ searchParams }: { searchParams: Promise<{ loc?: string; week?: string }> }) {
  seedIfEmpty();
  const user = await requireUser();
  if (user.role === "staff") notFound();
  const { loc, week } = await searchParams;
  const location = await resolveLocation(user, loc);
  if (!location) return <p className="muted">No venues are assigned to your account yet.</p>;

  if (!location.salon) {
    return (
      <>
        <PageHeader title="Rota" />
        <LocationTabs base="/rota" active={location.id} />
        <div className="panel">
          <p className="muted" style={{ padding: "26px 18px", margin: 0, fontSize: 13.5 }}>
            The rota is for businesses that book people. {location.name} books tables —{" "}
            <Link href={`/floor?loc=${location.id}`}>open the floor</Link>.
          </p>
        </div>
      </>
    );
  }

  const today = todayIn(location.timezone);
  const start = weekStart(week && /^\d{4}-\d{2}-\d{2}$/.test(week) ? week : today);
  const rows = weekRota(location, start);
  const link = (d: string) => `/rota?loc=${location.id}&week=${d}`;

  return (
    <>
      <PageHeader
        title="Rota"
        subtitle="Usual hours come from each person's weekly pattern. Change a day here — a different shift, a day off, or time off — and Belline books around it straight away."
        right={
          <div style={{ display: "flex", gap: 8 }}>
            <Link className="btn" href={link(addDays(start, -7))} aria-label="Previous week">←</Link>
            <Link className="btn" href={link(today)}>This week</Link>
            <Link className="btn" href={link(addDays(start, 7))} aria-label="Next week">→</Link>
          </div>
        }
      />
      <LocationTabs base="/rota" active={location.id} />
      {rows.length === 0 ? (
        <div className="panel">
          <p className="muted" style={{ padding: "26px 18px", margin: 0, fontSize: 13.5 }}>
            Nobody on the team yet. <Link href={`/venue?loc=${location.id}`}>Add people under How it works</Link>.
          </p>
        </div>
      ) : (
        <RotaEditor key={start + JSON.stringify(rows)} locationId={location.id} rows={rows} today={today} />
      )}
    </>
  );
}

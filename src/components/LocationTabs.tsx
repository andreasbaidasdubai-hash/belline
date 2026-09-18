import Link from "next/link";
import { canManageUsers, visibleLocations } from "@/lib/auth";
import { requireUser } from "@/lib/auth-server";
import { venueChip } from "@/lib/verticals";

export async function LocationTabs({ base, active }: { base: string; active: string }) {
  // Beside each name, the business's own type (verticals.ts `venueChip`), never
  // the engine it runs on: a property developer runs on the diary engine called
  // "salon" and used to be labelled one on every page. No chip when unknown.

  // Only the venues this person is allowed to open — a manager at one salon
  // should not even see that the other exists.
  const user = await requireUser();
  const locations = visibleLocations(user);

  /*
    "If I needed to add another location, where and how?" (founder, f6.)

    The answer was the Settings menu item, whose first tab happens to be
    Locations: findable once somebody has told you, which is not the same as
    discoverable. The row of venue names at the top of every page is where an
    owner looks when they are thinking about their venues, so the way to a new
    one ends that row and lands with the form already open
    (locations/LocationsManager.tsx reads `?add=1`).

    Owners only, because only an owner may add one (lib/locations.ts
    `addAllowance`). The page itself explains the plan rule; what it will not
    do is offer a button to somebody it is about to refuse.
  */
  const addLocation = canManageUsers(user) ? (
    <Link href="/locations?add=1" className="pill loc-tabs-add">
      <span aria-hidden="true">+</span> Add a location
    </Link>
  ) : null;

  // With nothing to switch between there is no switcher, but the page still
  // has to say which venue you are looking at.
  if (locations.length === 1) {
    return (
      <div className="loc-tabs">
        <span className="pill">
          {locations[0].name}
          {venueChip(locations[0]) && (
            <span style={{ fontWeight: 400 }}>
              {venueChip(locations[0])}
            </span>
          )}
        </span>
        {addLocation}
      </div>
    );
  }
  if (locations.length === 0) return addLocation ? <div className="loc-tabs">{addLocation}</div> : null;
  return (
    <div className="loc-tabs">
      {locations.map((l) => {
        const on = l.id === active;
        return (
          <Link
            key={l.id}
            href={`${base}?loc=${l.id}`}
            className="pill"
            style={{
              padding: "6px 13px",
              fontSize: 12,
              background: on ? "var(--accent)" : "var(--panel)",
              color: on ? "#fff" : "var(--muted)",
              borderColor: on ? "var(--accent)" : "var(--border)",
            }}
          >
            {l.name}
            {/* Not faded on the active blue tab: white on #0071E3 is 4.70:1,
                so any opacity drops it under 4.5:1 (0.9 measured 4.11). */}
            {venueChip(l) && (
              <span style={{ fontWeight: 500 }}>
                {venueChip(l)}
              </span>
            )}
          </Link>
        );
      })}
      {addLocation}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
}) {
  return (
    <div
      className="page-head"
      style={{
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: 20,
        marginBottom: 20,
      }}
    >
      <div>
        <h1 style={{ fontSize: 25, fontWeight: 600, margin: 0, letterSpacing: "-0.02em" }}>
          {title}
        </h1>
        {subtitle && (
          <p className="muted" style={{ fontSize: 13.5, margin: "6px 0 0", maxWidth: "62ch", lineHeight: 1.55 }}>
            {subtitle}
          </p>
        )}
      </div>
      {right}
    </div>
  );
}

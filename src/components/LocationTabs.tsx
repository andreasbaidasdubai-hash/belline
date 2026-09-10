import Link from "next/link";
import { visibleLocations } from "@/lib/auth";
import { requireUser } from "@/lib/auth-server";

export async function LocationTabs({ base, active }: { base: string; active: string }) {
  // Only the venues this person is allowed to open — a manager at one salon
  // should not even see that the other exists.
  const locations = visibleLocations(await requireUser());

  // With nothing to switch between there is no switcher, but the page still
  // has to say which venue you are looking at.
  if (locations.length === 1) {
    return (
      <div className="loc-tabs">
        <span className="pill">
          {locations[0].name}
          <span style={{ opacity: 0.65, fontWeight: 400 }}>
            {locations[0].vertical}
          </span>
        </span>
      </div>
    );
  }
  if (locations.length === 0) return null;
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
            <span style={{ opacity: 0.65, fontWeight: 500 }}>
              {l.vertical}
            </span>
          </Link>
        );
      })}
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

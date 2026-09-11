import Link from "next/link";
import { requireUser } from "@/lib/auth-server";
import { canManageUsers, canSeeLocation } from "@/lib/auth";
import { listLocations } from "@/lib/store";
import { attentionFor } from "@/lib/attention";
import SignOutButton from "@/components/SignOutButton";

/**
 * The signed-in shell.
 *
 * Every dashboard route sits under this layout, so `requireUser()` here is
 * what actually protects them — a page added next month is guarded before
 * anyone remembers to think about it. Route handlers are not covered by
 * layouts and check for themselves.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  // What still needs a person, across everything this user can see. It leads
  // the sidebar because it is the only item that is ever urgent — the rest of
  // the dashboard is there to be browsed, this one is there to be cleared.
  const outstanding = listLocations()
    .filter((l) => canSeeLocation(user, l.id))
    .reduce((n, l) => n + attentionFor(l).length, 0);

  const nav = [
    { href: "/attention", label: "Needs you", badge: outstanding || undefined },
    { href: "/", label: "Overview" },
    { href: "/calendar", label: "Calendar" },
    { href: "/calls", label: "Calls" },
    { href: "/bookings", label: "Bookings" },
    { href: "/waitlist", label: "Waitlist" },
    { href: "/guests", label: "Guests" },
    { href: "/test", label: "Test console" },
    // Floor staff read the book; they do not rewrite the agent's rules.
    ...(user.role !== "staff"
      ? [
          { href: "/agents", label: "Agent" },
          { href: "/integrations", label: "Integrations" },
        ]
      : []),
    ...(canManageUsers(user)
      ? [
          { href: "/demo", label: "Demo line" },
          { href: "/team", label: "Team" },
        ]
      : []),
    // Sales-side, so it stays out of a venue's own sidebar. Nested inside the
    // manage-users branch before, which read as if it were part of it.
    ...(user.role === "owner"
      ? [
          { href: "/prospects", label: "Personalised demos" },
          { href: "/sales", label: "Sales engine" },
          { href: "/sales/activity", label: "Activity" },
        ]
      : []),
  ];

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.svg" alt="Belline" style={{ height: 30, width: "auto", display: "block" }} />
          <div className="muted brand-sub" style={{ fontSize: 11, marginTop: 6 }}>
            AI reception
          </div>
        </div>

        <nav className="nav">
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="navlink"
              style={{
                padding: "8px 10px",
                borderRadius: 8,
                fontSize: 13,
                color: "var(--muted)",
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              {item.label}
              {item.badge ? (
                <span
                  style={{
                    marginLeft: "auto",
                    minWidth: 19,
                    height: 19,
                    padding: "0 6px",
                    borderRadius: 999,
                    background: "var(--bad)",
                    color: "#fff",
                    fontSize: 11,
                    fontWeight: 700,
                    display: "grid",
                    placeItems: "center",
                    fontVariantNumeric: "tabular-nums",
                  }}
                  aria-label={`${item.badge} needing attention`}
                >
                  {item.badge}
                </span>
              ) : null}
            </Link>
          ))}
        </nav>

        <div className="who">
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: 12.5,
                fontWeight: 600,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {user.name}
            </div>
            <div className="muted" style={{ fontSize: 11 }}>
              {user.role}
            </div>
          </div>
          <SignOutButton />
        </div>
      </aside>

      <main className="content">{children}</main>
    </div>
  );
}

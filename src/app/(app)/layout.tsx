import Link from "next/link";
import { requireUser } from "@/lib/auth-server";
import { canManageUsers } from "@/lib/auth";
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

  const nav = [
    { href: "/", label: "Overview" },
    { href: "/test", label: "Test console" },
    { href: "/calls", label: "Calls" },
    { href: "/bookings", label: "Bookings" },
    { href: "/guests", label: "Guests" },
    // Floor staff read the book; they do not rewrite the agent's rules.
    ...(user.role !== "staff" ? [{ href: "/agents", label: "Agent" }] : []),
    ...(canManageUsers(user)
      ? [
          { href: "/demo", label: "Demo line" },
          { href: "/team", label: "Team" },
        ]
      : []),
  ];

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div
            style={{
              fontSize: 15,
              fontWeight: 600,
              letterSpacing: "-0.022em",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 999,
                background: "var(--accent)",
                display: "inline-block",
              }}
            />
            Belline
          </div>
          <div className="muted brand-sub" style={{ fontSize: 11, marginTop: 4 }}>
            AI voice receptionist
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
              }}
            >
              {item.label}
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

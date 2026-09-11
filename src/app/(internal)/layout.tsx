import Link from "next/link";
import Brand from "@/components/Brand";
import { requireUser } from "@/lib/auth-server";
import SignOutButton from "@/components/SignOutButton";

/**
 * Belline's own console. Not the customer's.
 *
 * This is deliberately a separate route group from `(app)`, with its own
 * layout and its own guard, because the two hold fundamentally different data.
 * `(app)` holds one venue's diary and its guests; this holds every prospect in
 * every market — other people's businesses, their phone numbers, what we think
 * of them, and what we are about to send them.
 *
 * A venue manager must never see this, and "must never" is not something to
 * leave to a nav array. So:
 *
 *   · separate layout, separate `requireUser` + role check, checked here and
 *     again in every page beneath it
 *   · no link to it from the customer shell at all
 *   · a visibly different chrome, so nobody ever mistakes one for the other
 *     while screen-sharing with a customer
 *
 * The URL is shared today because both run in one process. When this moves
 * behind `sales.belline.ai`, only the hostname check in `marketing.ts` needs
 * to change — the separation above is already real.
 */
export default async function InternalLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  // Not `canManageUsers`: that answers "may this person manage a venue's
  // team", which is a different question from "does this person work for
  // Belline". Deliberately the narrowest check available.
  if (user.role !== "owner") {
    return (
      <div className="shell">
        <main className="content">
          <div className="panel" style={{ padding: "28px 30px", maxWidth: 520, margin: "60px auto" }}>
            <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 8 }}>Not available</div>
            <p className="muted" style={{ fontSize: 13.5, lineHeight: 1.6, margin: 0 }}>
              This is Belline&apos;s internal sales console. Your account does not have
              access to it.
            </p>
            <Link href="/" className="btn" style={{ marginTop: 18, display: "inline-block" }}>
              Back to your dashboard
            </Link>
          </div>
        </main>
      </div>
    );
  }

  const nav = [
    { href: "/sales", label: "Overview" },
    // Inbound, and above the outbound pipeline on purpose: somebody who asked
    // us for a call ten minutes ago is worth more than a thousand scraped rows.
    { href: "/sales/enquiries", label: "Enquiries" },
    { href: "/sales/leads", label: "Pipeline" },
    // The only page that is ever urgent: nothing leaves the building until
    // someone clears this.
    { href: "/sales/approvals", label: "Approvals" },
    { href: "/sales/activity", label: "Agent activity" },
  ];

  return (
    <div className="shell">
      <aside className="sidebar" style={{ background: "var(--navy, #0B1F33)" }}>
        <div className="brand">
          <Brand size={22} tone="var(--gold)" />
          <div
            style={{
              fontSize: 10,
              marginTop: 7,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              fontWeight: 700,
              color: "var(--gold, #C9A227)",
            }}
          >
            Sales console
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
                color: "rgba(255,255,255,0.72)",
              }}
            >
              {item.label}
            </Link>
          ))}

          <div
            style={{
              marginTop: 18,
              paddingTop: 14,
              borderTop: "1px solid rgba(255,255,255,0.12)",
            }}
          >
            <Link
              href="/"
              className="navlink"
              style={{
                padding: "8px 10px",
                borderRadius: 8,
                fontSize: 12.5,
                color: "rgba(255,255,255,0.5)",
              }}
            >
              ← Customer dashboard
            </Link>
          </div>
        </nav>

        <div className="who" style={{ borderTopColor: "rgba(255,255,255,0.12)" }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: "#fff" }}>{user.name}</div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)" }}>Belline</div>
          </div>
          <SignOutButton />
        </div>
      </aside>

      <main className="content">{children}</main>
    </div>
  );
}

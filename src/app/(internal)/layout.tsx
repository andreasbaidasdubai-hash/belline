import Link from "next/link";
import { cookies } from "next/headers";
import Brand from "@/components/Brand";
import { requireUser } from "@/lib/auth-server";
import { SESSION_COOKIE, isBellineStaff } from "@/lib/auth";
import { VIEW_AS_EXIT_PATH, viewAsState } from "@/lib/staff/view-as";
import SignOutButton from "@/components/SignOutButton";
import StaffNav from "./StaffNav";

/**
 * Belline's own console. Not the customer's.
 *
 * A separate route group from `(app)`, with its own layout and its own guard,
 * because the two hold fundamentally different data. `(app)` holds one
 * business's diary and guests; this holds every lead in every market and every
 * customer's account.
 *
 * A customer must never see this, and "must never" is not something to leave
 * to a menu. So:
 *
 *   · separate layout, separate `requireUser` + staff check, checked here and
 *     again in every page and route beneath it
 *   · in the customer shell, one "Staff console" link, shown only to Belline
 *     staff (nav.ts `staffNav`), and the pages refuse everybody else anyway
 *   · a visibly different chrome, so nobody mistakes one for the other while
 *     screen-sharing with a customer
 *
 * The URL is shared today because both run in one process. When this moves
 * behind its own hostname, only the hostname check in `marketing.ts` needs to
 * change: the separation above is already real.
 */
export default async function InternalLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  // Not the role. Every self-serve signup is the owner of its own tenant. The
  // tenant is what says somebody works here — see `isBellineStaff`.
  if (!isBellineStaff(user)) {
    // Staff viewing a customer's dashboard are signed in as that customer.
    const view = viewAsState((await cookies()).get(SESSION_COOKIE)?.value);
    return (
      <div className="shell">
        <main className="content">
          <div className="panel" style={{ padding: "28px 30px", maxWidth: 520, margin: "60px auto" }}>
            <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 8 }}>Not available</div>
            <p className="muted" style={{ fontSize: 13.5, lineHeight: 1.6, margin: 0 }}>
              {view
                ? `You are viewing ${view.businessName}'s dashboard as the customer. Exit the view to go back to the staff console.`
                : "This is Belline's internal console. Your account does not have access to it."}
            </p>
            {view ? (
              <a href={VIEW_AS_EXIT_PATH} className="btn btn-accent" style={{ marginTop: 18, display: "inline-flex" }}>
                Exit view
              </a>
            ) : (
              <Link href="/" className="btn" style={{ marginTop: 18, display: "inline-flex" }}>
                Back to your dashboard
              </Link>
            )}
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="shell staff-shell">
      {/* Dark on purpose: the customer shell is paper and this one is not,
          which is what stops the two being confused on a screen share. */}
      <aside className="sidebar staff-sidebar">
        <div className="brand">
          <Brand size={22} />
          <div className="staff-brand-sub">Staff console</div>
        </div>

        <nav className="nav staff-nav" aria-label="Staff console">
          <StaffNav />
        </nav>

        <div className="who">
          <div style={{ minWidth: 0 }}>
            <div className="staff-who-name">{user.name}</div>
            <div className="staff-who-sub">Belline</div>
          </div>
          <SignOutButton />
        </div>
      </aside>

      <main className="content">{children}</main>
    </div>
  );
}

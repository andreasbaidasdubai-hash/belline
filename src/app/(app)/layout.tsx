import { Suspense } from "react";
import Link from "next/link";
import Brand from "@/components/Brand";
import BackToSetup from "@/components/BackToSetup";
import { navCollapsed } from "@/lib/onboarding/journey";
import { navFor } from "@/lib/nav";
import { requireUser } from "@/lib/auth-server";
import { canManageUsers, canSeeLocation, isBellineStaff } from "@/lib/auth";
import { listLocations } from "@/lib/store";
import { attentionFor } from "@/lib/attention";
import { recallSummary } from "@/lib/booking/recall";
import SignOutButton from "@/components/SignOutButton";
import MobileNav from "@/components/MobileNav";
import SidebarNav from "@/components/SidebarNav";
import CommandPalette from "@/components/CommandPalette";
import LiveRefresh from "@/components/LiveRefresh";

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

  // Everyone due back across the venues this person can see. It sits next to
  // the book rather than under settings because it is a list to be worked, not
  // a page to be read — and a recall list nobody opens is the whole reason
  // practices lose a third of their recare.
  const dueBack = listLocations()
    .filter((l) => canSeeLocation(user, l.id) && l.salon)
    .reduce((n, l) => {
      const { overdue, due } = recallSummary(l);
      return n + overdue + due;
    }, 0);

  const visible = listLocations().filter((l) => canSeeLocation(user, l.id));

  // Until one of their businesses goes live, an owner sees the three places
  // that move setup forward, not the twenty that assume it is done.
  const collapsed = navCollapsed(visible, isBellineStaff(user));

  // The rest is decided in nav.ts: the seven destinations, with every other
  // page one click away under "Everything else". The diary navigation this
  // product grew was retired on 2026-09-16.
  const shape = navFor(user, visible, { outstanding, dueBack });

  const nav = collapsed
    ? [
        { href: "/setup", label: "Setup" },
        { href: "/setup/assistant", label: "Belle" },
        ...(canManageUsers(user) ? [{ href: "/billing", label: "Account" }] : []),
      ]
    : shape.items;

  const advanced = collapsed ? null : shape.advanced;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <Brand size={24} />
          <div className="muted brand-sub" style={{ fontSize: 11, marginTop: 6 }}>
            AI reception
          </div>
        </div>

        {/* On a phone the list below is replaced by a menu button. The
            scrolling strip it used to become was swipeable and looked like
            two links; a menu that cannot be seen is not a menu. */}
        <CommandPalette />

        <MobileNav items={nav} />

        <nav className="nav">
          {/* A client component, so the page you are on can be marked. */}
          <SidebarNav items={nav} />

          {/*
            The way into everything that is not one of the seven.

            Set apart below a rule, like the sales console, because it leads
            to a list of pages rather than to a page. It is the promise that
            makes the simplified navigation safe to turn on: nothing was
            removed, and the way to the rota is one click and a direct link,
            not a support conversation.
          */}
          {advanced && (
            <div
              style={{
                marginTop: 16,
                paddingTop: 14,
                borderTop: "1px solid var(--border)",
              }}
            >
              <Link
                href={advanced.href}
                className="navlink"
                style={{
                  padding: "8px 10px",
                  borderRadius: 8,
                  fontSize: 12.5,
                  color: "var(--muted)",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                {advanced.label}
                <span aria-hidden="true" style={{ marginLeft: "auto", opacity: 0.6 }}>
                  →
                </span>
              </Link>
            </div>
          )}

          {/*
            The way into Belline's own sales console.

            It was left out on the grounds that the console holds other
            businesses' data and should not surface in a customer's shell. That
            conflated two things: a *link* is not data, the nav is built per
            user, and nobody but an owner ever renders this. Leaving it out did
            not protect anything — it just meant the only person allowed in had
            to type the URL from memory, having arrived at the customer
            dashboard because they were already signed in.

            Set apart below a rule rather than listed with the venue's own
            pages, because it leads somewhere that is not about this venue.
          */}
          {isBellineStaff(user) && (
            <div
              style={{
                marginTop: 16,
                paddingTop: 14,
                borderTop: "1px solid var(--border)",
              }}
            >
              <Link
                href="/sales"
                className="navlink"
                style={{
                  padding: "8px 10px",
                  borderRadius: 8,
                  fontSize: 12.5,
                  color: "var(--muted)",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                Sales console
                <span aria-hidden="true" style={{ marginLeft: "auto", opacity: 0.6 }}>
                  →
                </span>
              </Link>
            </div>
          )}
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

      <main className="content">
        <Suspense fallback={null}>
          <BackToSetup />
        </Suspense>
        {children}
      </main>
      <LiveRefresh />
    </div>
  );
}

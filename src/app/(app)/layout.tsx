import { Suspense } from "react";
import Brand from "@/components/Brand";
import BackToSetup from "@/components/BackToSetup";
import { navFor } from "@/lib/nav";
import { requireUser } from "@/lib/auth-server";
import { canSeeLocation } from "@/lib/auth";
import { listLocations, listLocationsFor } from "@/lib/store";
import { setupGreeting } from "@/lib/onboarding/assistant";
import BelleDock from "@/app/setup/BelleDock";
import { belleFaceUrl, dashboardBelleVenue, supportVideoOn } from "@/lib/belle/identity";
import { onViewAs } from "@/lib/belle/server";
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

  const visible = listLocations().filter((l) => canSeeLocation(user, l.id));

  // What still needs a person, across everything this user can see. It rides
  // on Home because it is the only item that is ever urgent — the rest of the
  // dashboard is there to be browsed, this one is there to be cleared.
  const outstanding = visible.reduce((n, l) => n + attentionFor(l).length, 0);

  // Everyone due back across the venues this person can see, on the diary's
  // Recall. A list to be worked, not a page to be read — and a recall list
  // nobody opens is the whole reason practices lose a third of their recare.
  const dueBack = visible
    .filter((l) => l.salon)
    .reduce((n, l) => {
      const { overdue, due } = recallSummary(l);
      return n + overdue + due;
    }, 0);

  // The full menu from the moment the account exists. Until 2026-09-16 it
  // collapsed to Setup and Account until a venue went live, which left an
  // owner who could not finish one step with no dashboard at all. What is left
  // of setup is a checklist on Home; what gates answering real customers is
  // per channel, in onboarding/journey.ts, not the menu.
  //
  // The rest is decided in nav.ts: the owner's destinations, the diary for the
  // accounts that run on it, and Belline's own tools for Belline staff.
  const shape = navFor(user, visible, { outstanding, dueBack });
  const groups = [shape.diary, shape.staff].filter((g) => g !== null);

  // The venue Belle works on, as /setup/assistant chooses it: this account's
  // own, and only one this person may change. Nobody else gets the bell, and
  // nobody on a read-only view-as session: Belle saves, opens tickets and
  // starts video, and a view can do none of them (belle/identity.ts).
  const belleVenue = (await onViewAs()) ? undefined : dashboardBelleVenue(user, listLocationsFor(user.tenantId), null);

  const content = (
    <main className="content">
      <Suspense fallback={null}>
        <BackToSetup />
      </Suspense>
      {children}
    </main>
  );

  return (
    <div className={belleVenue ? "shell has-belle-fab" : "shell"}>
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

        <MobileNav items={shape.items} groups={groups} />

        <nav className="nav">
          {/* A client component, so the page you are on can be marked. The
              diary, for the accounts that run on it, and Belline's own tools
              each sit below a rule: neither is the owner's everyday setup,
              and on a screen share the staff group must be unmistakable. */}
          <SidebarNav items={shape.items} groups={groups} />
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

      {belleVenue ? (
        <BelleDock
          locationId={belleVenue.id}
          greeting={setupGreeting(belleVenue)}
          storageKey="belline.app.belle-dock"
          faceUrl={belleFaceUrl()}
          video={supportVideoOn()}
        >
          {content}
        </BelleDock>
      ) : (
        content
      )}
      <LiveRefresh />
    </div>
  );
}

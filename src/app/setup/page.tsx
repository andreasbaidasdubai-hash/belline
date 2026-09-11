import { redirect } from "next/navigation";
import Brand from "@/components/Brand";
import { requireUser } from "@/lib/auth-server";
import { listLocationsFor } from "@/lib/store";
import { readiness } from "@/lib/onboarding";
import { seedIfEmpty } from "@/lib/seed";
import SetupWizard from "./SetupWizard";

export const dynamic = "force-dynamic";

export const metadata = { title: "Set up Belline" };

/**
 * Setting the venue up, by conversation rather than by form.
 *
 * Outside the `(app)` group on purpose. The dashboard shell is a sidebar with
 * eleven links, and somebody who signed up ninety seconds ago has no use for
 * any of them — they have one job, and every other door on the screen is a way
 * of not doing it.
 */
export default async function SetupPage() {
  seedIfEmpty();
  const user = await requireUser();

  const venue = listLocationsFor(user.tenantId)[0];
  // An owner with no venue has nothing to set up. That should be impossible —
  // signup creates one — so it means they were invited to somebody else's
  // account, and the dashboard is where they belong.
  if (!venue) redirect("/");

  const state = readiness(venue);

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)" }}>
      <header
        style={{
          borderBottom: "1px solid var(--border)",
          background: "var(--panel)",
          padding: "18px 26px",
          display: "flex",
          alignItems: "center",
          gap: 16,
        }}
      >
        <Brand size={24} />
        <span className="muted" style={{ fontSize: 12.5, marginLeft: "auto" }}>
          {venue.name}
        </span>
      </header>

      <main style={{ maxWidth: 720, margin: "0 auto", padding: "44px 26px 90px" }}>
        <SetupWizard
          venueName={venue.name}
          vertical={venue.vertical}
          alreadyReady={state.ready}
          missing={state.missing}
        />
      </main>
    </div>
  );
}

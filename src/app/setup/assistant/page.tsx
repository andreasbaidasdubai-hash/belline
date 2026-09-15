import { redirect } from "next/navigation";
import Brand from "@/components/Brand";
import { requireUser } from "@/lib/auth-server";
import { canEditAgent } from "@/lib/auth";
import { listLocationsFor } from "@/lib/store";
import { readiness } from "@/lib/onboarding";
import { setupGreeting } from "@/lib/onboarding/assistant";
import { seedIfEmpty } from "@/lib/seed";
import SetupAssistant from "./SetupAssistant";

export const dynamic = "force-dynamic";

export const metadata = { title: "Set up with Belle" };

/**
 * Set up by conversation.
 *
 * Outside the dashboard shell for the same reason as /setup: somebody setting
 * up has one job, and eleven sidebar links are eleven ways of not doing it.
 */
export default async function SetupAssistantPage({
  searchParams,
}: {
  searchParams: Promise<{ loc?: string }>;
}) {
  seedIfEmpty();
  const user = await requireUser();
  const { loc } = await searchParams;
  const venues = listLocationsFor(user.tenantId);
  const venue = venues.find((v) => v.id === loc) ?? venues[0];
  if (!venue || !canEditAgent(user, venue.id)) redirect("/");

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
          {venue.name} · <a href="/">Dashboard</a>
        </span>
      </header>
      <main style={{ maxWidth: 980, margin: "0 auto", padding: "36px 22px 80px" }}>
        <h1 style={{ fontFamily: "var(--bl-font-display)", fontWeight: 700, fontSize: 30, letterSpacing: "-0.02em", margin: "0 0 6px" }}>
          Set up with Belle
        </h1>
        <p className="muted" style={{ fontSize: 14.5, margin: "0 0 22px", maxWidth: "60ch", lineHeight: 1.6 }}>
          Answer in your own words. Belle saves each answer as you go and tells you what she saved.
        </p>
        <SetupAssistant
          locationId={venue.id}
          greeting={setupGreeting(venue)}
          initialMissing={readiness(venue).missing.map((m) => m.label)}
        />
      </main>
    </div>
  );
}

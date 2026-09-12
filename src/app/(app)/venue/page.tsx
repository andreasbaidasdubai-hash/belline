import { notFound } from "next/navigation";
import { canEditAgent } from "@/lib/auth";
import { requireUser, resolveLocation } from "@/lib/auth-server";
import { seedIfEmpty } from "@/lib/seed";
import { terms } from "@/lib/verticals";
import { validateVenue } from "@/lib/booking/config";
import { LocationTabs, PageHeader } from "@/components/LocationTabs";
import VenueEditor from "./VenueEditor";
import VersionHistory from "./VersionHistory";
import { historyFor } from "@/lib/brain";

export const dynamic = "force-dynamic";

/**
 * How the venue actually works.
 *
 * The Agent page changes what it says. This changes what the engine does —
 * the room, the price list, the team, the rules — and until it existed, every
 * one of those was a value in a seed file that only a developer could reach.
 *
 * Hidden from floor staff for the same reason the Agent page is: these are the
 * settings a caller experiences as the venue's own word, and changing them is
 * a decision rather than a task.
 */
export default async function VenuePage({
  searchParams,
}: {
  searchParams: Promise<{ loc?: string }>;
}) {
  seedIfEmpty();
  const user = await requireUser();
  const { loc } = await searchParams;
  const location = await resolveLocation(user, loc);
  if (!location) return <p className="muted">No venues are assigned to your account yet.</p>;
  if (!canEditAgent(user, location.id)) notFound();

  const t = terms(location);

  return (
    <>
      <PageHeader
        title="How this venue works"
        subtitle={
          location.restaurant
            ? "The room, the sittings and the house rules. Every change is live on the next call — nothing to deploy."
            : `The ${t.services}, the ${t.staffPlural}, the rooms and the house rules. Every change is live on the next call — nothing to deploy.`
        }
      />
      <LocationTabs base="/venue" active={location.id} />

      <VenueEditor
        locationId={location.id}
        currency={location.currency}
        terms={t}
        initial={{
          policy: location.policy ?? {},
          restaurant: location.restaurant,
          salon: location.salon,
        }}
        // Checked on the server so a venue arriving at this page already
        // misconfigured — seeded years ago, or edited by an older build — is
        // told before it changes anything else.
        initialFindings={validateVenue(location)}
      />

      <VersionHistory
        locationId={location.id}
        versions={historyFor(location)
          .slice(0, 25)
          .map((v) => ({
            number: v.number,
            by: v.authorName,
            at: v.createdAt,
            note: v.note ?? "",
            revertedFrom: v.revertedFrom,
          }))}
      />
    </>
  );
}

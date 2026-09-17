import { notFound } from "next/navigation";
import { canEditAgent } from "@/lib/auth";
import { requireUser, resolveLocation } from "@/lib/auth-server";
import { seedIfEmpty } from "@/lib/seed";
import { currentVenue } from "@/lib/onboarding";
import { venueMarket } from "@/lib/onboarding/rules";
import { onBellineDiary, serviceLengthsRequired } from "@/lib/booking/destination";
import { LocationTabs, PageHeader } from "@/components/LocationTabs";
import { historyFor } from "@/lib/brain";
import SetupWizard from "@/app/setup/SetupWizard";
import VersionHistory from "./VersionHistory";

export const dynamic = "force-dynamic";

/**
 * Your business: the details Belline answers from.
 *
 * The name, the greeting, the address and phone, the hours, what the business
 * offers and the questions people ask — the same form setup ends on, opened on
 * what is saved. It used to be only reachable by running setup again, which
 * moved the owner on through steps they had finished; and this page was the
 * diary's editor, with stylists, rooms and turnaround, for businesses that
 * since the pivot take requests and have none of those.
 *
 * The diary's machinery lives on /venue/diary, for the venues that have it.
 * Hidden from floor staff for the same reason the Agent page is: this is what
 * a caller hears as the business's own word.
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

  return (
    <>
      <PageHeader
        title="Your business"
        subtitle="What Belline tells your customers. Every change is live on the next call — nothing to deploy."
      />
      <LocationTabs base="/venue" active={location.id} />

      <SetupWizard
        // A fresh form per location: switching tabs must not carry one
        // venue's unsaved edits into another's.
        key={location.id}
        mode="dashboard"
        locationId={location.id}
        vertical={location.vertical}
        currency={location.currency}
        current={currentVenue(location)}
        lengthsRequired={serviceLengthsRequired(location)}
        diary={onBellineDiary(location)}
        country={venueMarket(location)}
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

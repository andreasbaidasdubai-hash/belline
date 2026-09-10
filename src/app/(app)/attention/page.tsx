import { requireUser, resolveLocation } from "@/lib/auth-server";
import { seedIfEmpty } from "@/lib/seed";
import { attentionFor, KIND_LABEL } from "@/lib/attention";
import { LocationTabs, PageHeader } from "@/components/LocationTabs";
import Inbox from "./Inbox";

export const dynamic = "force-dynamic";

export default async function AttentionPage({
  searchParams,
}: {
  searchParams: Promise<{ loc?: string }>;
}) {
  seedIfEmpty();
  const user = await requireUser();
  const { loc } = await searchParams;
  const location = await resolveLocation(user, loc);
  if (!location) return <p className="muted">No venues are assigned to your account yet.</p>;

  const items = attentionFor(location);

  return (
    <>
      <PageHeader
        title="Needs you"
        subtitle="Calls Belline handled correctly but could not finish alone. Clear the list and you are up to date."
      />
      <LocationTabs base="/attention" active={location.id} />
      <Inbox items={items} labels={KIND_LABEL} />
    </>
  );
}

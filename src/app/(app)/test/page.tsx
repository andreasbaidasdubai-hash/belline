import { requireUser, resolveLocation } from "@/lib/auth-server";
import { seedIfEmpty } from "@/lib/seed";
import { LocationTabs, PageHeader } from "@/components/LocationTabs";
import Console from "./Console";

export const dynamic = "force-dynamic";

export default async function TestPage({
  searchParams,
}: {
  searchParams: Promise<{ loc?: string }>;
}) {
  seedIfEmpty();
  const user = await requireUser();
  const { loc } = await searchParams;
  const location = await resolveLocation(user, loc);

  if (!location) return <p className="muted">No venues are assigned to your account yet.</p>;

  return (
    <>
      <PageHeader
        title="Test console"
        subtitle="A real call against the real booking engine. Everything you do here shows up in Calls and Bookings."
      />
      <LocationTabs base="/test" active={location.id} />
      <Console locationId={location.id} locationName={location.name} />
    </>
  );
}

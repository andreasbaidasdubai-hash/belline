import { notFound } from "next/navigation";
import { canManageUsers } from "@/lib/auth";
import { requireUser } from "@/lib/auth-server";
import { listLocationsFor } from "@/lib/store";
import { teamFor } from "@/lib/team";
import { PageHeader } from "@/components/LocationTabs";
import TeamManager from "./TeamManager";

export const dynamic = "force-dynamic";

export default async function TeamPage() {
  const user = await requireUser();
  if (!canManageUsers(user)) notFound();

  // This tenant's people and this tenant's venues. Password hashes never
  // cross to the client, even to an owner — and neither, any more, does
  // anybody else's staff list.
  const people = teamFor(user);
  const venues = listLocationsFor(user.tenantId).map((l) => ({ id: l.id, name: l.name }));

  return (
    <>
      <PageHeader
        title="Team"
        subtitle="Who can open this dashboard, and which venues they see. Managers change how the agent behaves; staff read the book and the calls."
      />
      <TeamManager people={people} venues={venues} currentUserId={user.id} />
    </>
  );
}

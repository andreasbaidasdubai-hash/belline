import { notFound } from "next/navigation";
import { canManageUsers } from "@/lib/auth";
import { requireUser } from "@/lib/auth-server";
import { listLocations, listUsers } from "@/lib/store";
import { PageHeader } from "@/components/LocationTabs";
import TeamManager from "./TeamManager";

export const dynamic = "force-dynamic";

export default async function TeamPage() {
  const user = await requireUser();
  if (!canManageUsers(user)) notFound();

  // Password hashes never cross to the client, even to an owner.
  const people = listUsers().map((u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    locationIds: u.locationIds,
    disabled: Boolean(u.disabled),
    lastSeenAt: u.lastSeenAt ?? null,
  }));

  const venues = listLocations().map((l) => ({ id: l.id, name: l.name }));

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

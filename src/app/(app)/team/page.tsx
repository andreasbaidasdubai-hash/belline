import { notFound } from "next/navigation";
import { canManageUsers } from "@/lib/auth";
import { requireUser } from "@/lib/auth-server";
import { listLocationsFor } from "@/lib/store";
import { teamFor } from "@/lib/team";
import { PageHeader } from "@/components/LocationTabs";
import SectionTabs from "@/components/SectionTabs";
import { SETTINGS_TABS } from "@/lib/nav";
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
        title="Settings"
        subtitle="Who can open this dashboard, and which locations they see. Managers change how Belline answers; staff read the Inbox and the calls."
      />
      <SectionTabs tabs={SETTINGS_TABS} label="Settings" />
      <TeamManager people={people} venues={venues} currentUserId={user.id} />
    </>
  );
}

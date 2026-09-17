import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth-server";
import { canManageUsers } from "@/lib/auth";
import { listLocationsFor } from "@/lib/store";
import { userCanSeeLocation } from "@/lib/tenancy";
import { COMMON_TIMEZONES, addAllowance, removalOf } from "@/lib/locations";
import { seedIfEmpty } from "@/lib/seed";
import { PageHeader } from "@/components/LocationTabs";
import LocationsManager from "./LocationsManager";

export const dynamic = "force-dynamic";

/** Every location the business has — add one, change one, archive or delete one. */
export default async function LocationsPage() {
  seedIfEmpty();
  const user = await requireUser();
  if (user.role === "staff") notFound();

  const venues = listLocationsFor(user.tenantId, { includeArchived: true })
    .filter((l) => !l.prospect && !l.demo?.enabled)
    .filter((l) => canManageUsers(user) || userCanSeeLocation(user, l))
    .map((l) => {
      // The same rules the API enforces, worked out here so each card can say
      // what archiving or deleting would do — or why it cannot — before
      // anybody presses anything.
      const removal = removalOf(user, l);
      return {
        id: l.id,
        name: l.name,
        vertical: l.vertical,
        tradeKey: l.tradeKey,
        timezone: l.timezone,
        address: l.address,
        // The business's own number. The Belline number is not edited here.
        phone: l.businessPhone,
        currency: l.currency,
        hours: l.hours,
        closures: l.closures,
        archivedAt: l.archivedAt ?? null,
        hasBellineNumber: Boolean(l.bellineNumber?.number),
        usage: removal.usage,
        archiveBlock: removal.archive,
        deleteBlock: removal.delete,
      };
    });

  const allowance = addAllowance(user);

  return (
    <>
      <PageHeader title="Locations" subtitle="Every branch of the business. Each location has its own diary, number, team and receptionist." />
      <LocationsManager
        venues={venues}
        canManage={canManageUsers(user)}
        timezones={COMMON_TIMEZONES}
        add={allowance.allowed ? { allowed: true, sentence: allowance.sentence } : allowance}
      />
    </>
  );
}

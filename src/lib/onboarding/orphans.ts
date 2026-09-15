import type { Business, Location, Tenant, User } from "../types";

/**
 * Accounts a failed signup left behind.
 *
 * Before signup was atomic, a rejected password still wrote a tenant, a
 * business and a venue, and then no owner. Four were seen. Nobody can sign in
 * to them and nothing links to them, so they are noise in every count.
 *
 * Pure: given the collections, says what is orphaned. It never deletes —
 * that is a decision for a person looking at the list (scripts/orphans.ts).
 */

export interface OrphanReport {
  tenants: Pick<Tenant, "id" | "name" | "createdAt">[];
  businesses: Pick<Business, "id" | "tenantId" | "name" | "createdAt">[];
  locations: Pick<Location, "id" | "tenantId" | "name">[];
}

export function findOrphans(
  db: { tenants: Tenant[]; businesses: Business[]; locations: Location[]; users: User[] },
  keep: string[] = [],
): OrphanReport {
  const withUsers = new Set(db.users.map((u) => u.tenantId));
  const known = new Set(db.tenants.map((t) => t.id));
  // Internal tenants and the ones named in `keep` (the tenant everything was
  // migrated into) are ours, and legitimately have no customer login.
  const exempt = new Set([...keep, ...db.tenants.filter((t) => t.internal).map((t) => t.id)]);
  const orphaned = (tenantId: string) => !exempt.has(tenantId) && (!known.has(tenantId) || !withUsers.has(tenantId));

  return {
    tenants: db.tenants
      .filter((t) => orphaned(t.id))
      .map(({ id, name, createdAt }) => ({ id, name, createdAt })),
    businesses: db.businesses
      .filter((b) => orphaned(b.tenantId))
      .map(({ id, tenantId, name, createdAt }) => ({ id, tenantId, name, createdAt })),
    locations: db.locations
      .filter((l) => !l.internal && orphaned(l.tenantId))
      .map(({ id, tenantId, name }) => ({ id, tenantId, name })),
  };
}

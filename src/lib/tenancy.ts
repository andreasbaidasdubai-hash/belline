import type { Business, Location, Tenant, User } from "./types";
import {
  getBusiness,
  getTenant,
  listLocations,
  listUsers,
  saveBusiness,
  saveTenant,
  saveUser,
  upsertLocation,
} from "./store";

/**
 * Tenancy.
 *
 * Belline started as one venue group and grew into multi-tenant SaaS, so this
 * layer arrived after the data did. Two consequences shape everything here.
 *
 * The first is that it had to be additive. Every existing venue, user, booking
 * and call belongs to somebody already — they just never said so — and the
 * migration's job is to write down what was always true rather than to change
 * anything. `ensureTenancy` is idempotent, runs at every boot behind
 * `seedIfEmpty`, and the day it landed nothing observable changed.
 *
 * The second is that the tenant id has to be *load-bearing* from the start,
 * not decorative. The mistake it exists to prevent is not an attacker — it is
 * a query written next year that forgets, in a codebase where forgetting
 * currently returns somebody else's bookings. So every accessor that can cross
 * a tenant boundary takes the tenant id as its first argument, and the
 * permission check below asks about the tenant before it asks about anything
 * else.
 *
 * Three levels, and the middle one is the one the old model skipped:
 *
 *   Tenant    — who pays.
 *   Business  — what it is called and what it does. "Dental Group."
 *   Location  — a diary. "Dental Group, Dubai Marina."
 *
 * A business with one location is the common case and costs one extra row. A
 * business with three is the case that was impossible before: the services,
 * the staff and the hours differ per branch, the name and the category do not,
 * and "which of your branches is closest?" had nowhere to be answered from.
 */

/**
 * Everything that existed before tenancy belongs here.
 *
 * Which makes it ours. Before self-serve signup there was one installation —
 * Belline's own, with the seeded demo lines and the people who run the
 * company — and that is what was migrated into this tenant. It is marked
 * `internal` below for that reason: the sales console and the prospect tools
 * are gated on the tenant, and the owner of the company has to pass.
 *
 * If a real customer is ever found in here, the fix is to move them to a
 * tenant of their own, not to widen this one.
 */
export const DEFAULT_TENANT_ID = "tnt_default";

/**
 * Ours. Holds Belline's own demo venue — the diary behind the bell on the
 * website — which runs on the same engine as a customer's and must never turn
 * up in a customer's data. It was already excluded by `internal`; now it is
 * excluded by ownership as well, which is the stronger of the two because it
 * does not depend on every future query remembering a flag.
 */
export const BELLINE_TENANT_ID = "tnt_belline";

/** A stable business id for a venue that arrived without one. */
export function businessIdForLocation(locationId: string): string {
  return `biz${locationId.replace(/^loc/, "")}`;
}

function tenant(id: string, name: string, internal?: boolean): Tenant {
  return {
    id,
    name,
    status: "active",
    createdAt: new Date().toISOString(),
    ...(internal ? { internal: true } : {}),
  };
}

function businessFrom(location: Location, tenantId: string): Business {
  return {
    id: businessIdForLocation(location.id),
    tenantId,
    name: location.name,
    category:
      location.vertical === "restaurant"
        ? "Restaurant"
        : location.vertical === "clinic"
          ? "Clinic"
          : "Salon & spa",
    phone: location.phone,
    // Never on by default. A business that has never been asked has not opted
    // in, and the whole value of the flag is that it means something.
    discoverable: false,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Give everything an owner, once.
 *
 * Called from `seedIfEmpty`, which every page, route and script already runs,
 * so there is no separate migration step to remember and no window in which
 * half the data is migrated. Writes only what is missing: on the second boot
 * it touches nothing.
 */
export function ensureTenancy(): void {
  for (const [id, name] of [
    [DEFAULT_TENANT_ID, "Belline"],
    [BELLINE_TENANT_ID, "Belline"],
  ] as const) {
    const existing = getTenant(id);
    if (!existing) {
      saveTenant(tenant(id, name, true));
    } else if (!existing.internal) {
      // Written on a store that predates the flag. Fill the blank and nothing
      // else — the name and the dates are whatever they were.
      saveTenant({ ...existing, internal: true });
    }
  }

  for (const location of listLocations({ includeInternal: true })) {
    // Only ever fill a blank. The first version of this line computed the
    // tenant from `internal` unconditionally, which quietly reassigned every
    // venue to the default tenant on every boot — so the moment there was a
    // second customer, their venues became the first customer's. A migration
    // that keeps running is not a migration; it has to be able to tell "never
    // had an owner" from "has one I did not choose".
    const tenantId =
      location.tenantId || (location.internal ? BELLINE_TENANT_ID : DEFAULT_TENANT_ID);
    const businessId = location.businessId || businessIdForLocation(location.id);

    if (!getBusiness(tenantId, businessId)) {
      saveBusiness(businessFrom(location, tenantId));
    }

    if (location.tenantId !== tenantId || location.businessId !== businessId) {
      upsertLocation({ ...location, tenantId, businessId });
    }
  }

  for (const user of listUsers()) {
    if (!user.tenantId) saveUser({ ...user, tenantId: DEFAULT_TENANT_ID });
  }
}

/**
 * Can this person see this venue?
 *
 * Tenant first, and that order is the point: a venue id belonging to another
 * tenant is refused even if it somehow appears in this user's `locationIds`.
 * The list narrows access inside a tenant and cannot widen it across one.
 */
export function userCanSeeLocation(user: User, location: Location): boolean {
  if (location.tenantId !== user.tenantId) return false;
  return user.locationIds.length === 0 || user.locationIds.includes(location.id);
}

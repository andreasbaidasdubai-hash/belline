import type { Location } from "../types";
import { listPoolRows } from "../store";

/**
 * The venue's Belline number: the number its customers' calls are forwarded
 * to. Empty when it has none yet.
 *
 * `location.phone` is not that on its own. The review step saves the business's
 * own phone into the same field, so a new signup who typed 0502992339 there was
 * shown "forward your calls to 0502992339" — their own mobile — as if it were
 * Belline's line. A number counts as Belline's only when Belline gave it:
 *
 *   - a pool number assigned to this venue (by code or by hand), or
 *   - a number stamped `numberAssignedAt` when it was assigned, or
 *   - the phone of a venue that predates the journey or is ours (demo,
 *     internal, prospect, backfilled live), where the field has only ever held
 *     the line Belline answers.
 *
 * Deliberately no import of pool.ts: that module imports the journey, and the
 * journey asks this.
 */
export function bellineNumberOf(location: Pick<Location, "id" | "phone" | "onboarding" | "internal" | "demo" | "prospect">): string {
  const phone = location.phone.trim();
  const row = listPoolRows().find((r) => r.status === "assigned" && r.locationId === location.id);
  if (row) return row.number;
  if (!phone) return "";
  const o = location.onboarding;
  if (o?.channels.phone?.numberAssignedAt) return phone;
  if (!o || o.activatedBy === "backfill" || location.internal || location.demo?.enabled || location.prospect) return phone;
  // Anything left is a number the owner typed: their own line, not Belline's.
  return "";
}

/** Does the venue have a Belline number yet? */
export function hasBellineNumber(location: Pick<Location, "id" | "phone" | "onboarding" | "internal" | "demo" | "prospect">): boolean {
  return bellineNumberOf(location) !== "";
}

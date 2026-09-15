import { listLocations, upsertLocation } from "../store";
import { addDays, todayIn } from "../time";
import { GRANDFATHER_DAYS, grandfatherExpires } from "./plans";
import { productsOf } from "./usage";

/**
 * Keep the pilot venues on what they bought (addendum §3).
 *
 * A venue paying for the original Starter, Business or Enterprise keeps
 * exactly that — the price, the minutes, Enterprise's uncounted minutes — for
 * 90 days from the day the modular catalogue shipped. "The day it shipped" is
 * not a date anybody can write into the code in advance, so it is stamped
 * here, on the first boot that runs this, once per venue and never moved.
 *
 * A September 2026 bundle is legacy too, but kept indefinitely: nothing is
 * stamped on it.
 *
 * Trials are not grandfathered: a trial is not a purchase, and it simply
 * continues as a trial of the new catalogue.
 */
export function grandfatherLegacyPlans(): number {
  let stamped = 0;
  for (const location of listLocations({ includeInternal: true })) {
    const sub = location.subscription;
    if (!sub || sub.grandfatheredUntil || sub.status !== "active" || !grandfatherExpires(productsOf(sub))) continue;
    upsertLocation({
      ...location,
      subscription: { ...sub, grandfatheredUntil: addDays(todayIn(location.timezone), GRANDFATHER_DAYS) },
    });
    stamped++;
  }
  return stamped;
}

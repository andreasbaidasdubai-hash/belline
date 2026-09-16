import type { BellineNumber, Location, PoolNumber } from "../types";

/**
 * The venue's Belline number: the number its customers' calls are forwarded
 * to, and the one the voice webhook finds it by. Empty when it has none yet.
 *
 * A field read, not a guess. Until 2026-09-16 one `phone` field held both this
 * and the business's own line, and a stopgap here worked out which was which.
 * They are separate fields now (`businessPhone`, `bellineNumber`); stored
 * venues were moved across once by `splitLegacyPhone` below.
 */
export function bellineNumberOf(location: Pick<Location, "bellineNumber">): string {
  return location.bellineNumber?.number.trim() ?? "";
}

/** Does the venue have a Belline number yet? */
export function hasBellineNumber(location: Pick<Location, "bellineNumber">): boolean {
  return bellineNumberOf(location) !== "";
}

const digits = (n: string) => n.replace(/\D/g, "");

/** Two numbers are the same line when their digits are. */
export function sameNumber(a: string, b: string): boolean {
  const x = digits(a);
  return x !== "" && x === digits(b);
}

/** The venue whose Belline number is this one, if any. What /api/twilio/voice routes by. */
export function venueForDialledNumber<T extends Pick<Location, "bellineNumber">>(locations: T[], dialled: string): T | undefined {
  if (!digits(dialled)) return undefined;
  return locations.find((l) => sameNumber(bellineNumberOf(l), dialled));
}

/** A venue as it was stored before the split: one `phone`, no `businessPhone`. */
export type LegacyVenue = Omit<Location, "businessPhone" | "bellineNumber"> & {
  phone?: string;
  businessPhone?: string;
  bellineNumber?: BellineNumber;
};

export interface PhoneSplit {
  businessPhone: string;
  bellineNumber?: BellineNumber;
  /** What was decided, in a line for the boot log. */
  rule: "pool_record" | "staff_marker" | "routed_evidence" | "ours_or_legacy" | "business_phone" | "empty";
}

/**
 * A stored Belline number as E.164 without changing a single digit: spaces and
 * punctuation out of an international number ("+971 4 555 0142" becomes
 * "+97145550142"). The voice webhook matches on digits, so this cannot move a
 * call. Anything not written with its + is kept as it was: reading a country
 * into it could change which calls match.
 */
function routedNumber(raw: string): string {
  const text = raw.trim();
  const d = digits(text);
  return text.startsWith("+") && d ? `+${d}` : text;
}

/**
 * Which of the two a stored venue's single `phone` was. Pure: seed.ts runs it
 * once per venue on boot, and the tests run it on fixtures shaped like
 * production's.
 *
 *   1. A pool row assigned to the venue: that row's number is the Belline
 *      number (via pool, or staff when a person assigned it). If `phone` is a
 *      different number, it is the owner's own line, which the review step
 *      wrote over the Belline number — the bug this split fixes.
 *   2. `numberAssignedAt` stamped on the phone channel, the staff "Record a
 *      number" marker: `phone` is the Belline number (via staff).
 *   3. A venue that is ours or predates the journey — internal, a demo line, a
 *      prospect demo, no onboarding record, or backfilled live: `phone` is the
 *      number Twilio routes to it today, so it stays the Belline number (via
 *      legacy). It is also kept as the business phone, because that is the
 *      number these venues have always given out and nothing else is known.
 *   4. Evidence that Twilio already routes `phone` to a customer venue, for
 *      numbers staff recorded before that marker existed: the number is one
 *      of the pool's (in any state), a forwarding test passed on it, or a
 *      phone call has reached the venue. `phone` is the Belline number (via
 *      legacy), and the business phone is left for the owner to give.
 *   5. Any other customer venue: `phone` is the number the owner typed, their
 *      own line. No Belline number.
 *
 * The business phone is kept exactly as stored (trimmed), so what the agent
 * says and the venue's configuration digest do not move. A Belline number is
 * written E.164 with its digits unchanged, so no call is routed differently.
 */
export function splitLegacyPhone(
  venue: LegacyVenue,
  pool: PoolNumber[],
  evidence: { phoneCalls: number } = { phoneCalls: 0 },
  now: Date = new Date(),
): PhoneSplit {
  const phone = (venue.phone ?? "").trim();
  const at = now.toISOString();
  const row = pool.find((r) => r.status === "assigned" && r.locationId === venue.id);
  if (row) {
    const via = row.assignedBy === "pool" ? "pool" : "staff";
    return {
      businessPhone: phone && !sameNumber(phone, row.number) ? phone : "",
      bellineNumber: {
        number: routedNumber(row.number),
        via,
        assignedAt: row.assignedAt ?? at,
        ...(via === "staff" && row.assignedBy ? { by: row.assignedBy } : {}),
      },
      rule: "pool_record",
    };
  }
  if (!phone) return { businessPhone: "", rule: "empty" };
  const o = venue.onboarding;
  const assignedAt = o?.channels.phone?.numberAssignedAt;
  if (assignedAt) {
    return { businessPhone: "", bellineNumber: { number: routedNumber(phone), via: "staff", assignedAt }, rule: "staff_marker" };
  }
  const ours = !o || o.activatedBy === "backfill" || venue.internal || venue.demo?.enabled || venue.prospect;
  if (ours) {
    return { businessPhone: phone, bellineNumber: { number: routedNumber(phone), via: "legacy", assignedAt: at }, rule: "ours_or_legacy" };
  }
  const routed = pool.some((r) => sameNumber(r.number, phone)) || Boolean(o?.channels.phone?.forwardingVerifiedAt) || evidence.phoneCalls > 0;
  if (routed) {
    return { businessPhone: "", bellineNumber: { number: routedNumber(phone), via: "legacy", assignedAt: at }, rule: "routed_evidence" };
  }
  return { businessPhone: phone, rule: "business_phone" };
}

import crypto from "node:crypto";
import type { AgentConfig, Location, User, Vertical } from "./types";
import { getLocation, upsertLocation, id } from "./store";

/**
 * The Business Brain.
 *
 * Everything Belline needs in order to represent a business, held as
 * structured, versioned, auditable data — not as one long prompt.
 *
 * The distinction is the whole point. A prompt cannot be diffed, cannot be
 * rolled back, cannot say who changed the cancellation policy last Tuesday,
 * and cannot answer "which configuration handled the call the patient is
 * complaining about?". Those four questions are the ones asked after
 * something goes wrong, and a business considering handing over its phone
 * line is entitled to know they have answers.
 *
 * So: every change writes a new version. Versions are immutable. A call
 * records the version that handled it. Rolling back is publishing an older
 * version, which is itself a new version — the history never loses an entry,
 * because a history that can be edited is not evidence of anything.
 */

export type BrainSection =
  | "company"
  | "services"
  | "staff"
  | "policies"
  /**
   * The house rules — notice, horizon, cancellation window, deposits.
   *
   * Separate from `policies`, which is the free text folded into the prompt.
   * These are enforced rather than said, and "who shortened the cancellation
   * window" is exactly the question this history exists to answer.
   */
  | "rules"
  | "room"
  | "faqs"
  | "escalation"
  | "style";

export interface BrainVersion {
  id: string;
  /** 1, 2, 3… within a venue. What a person says out loud. */
  number: number;
  locationId: string;
  createdAt: string;
  /** Who published it. "system" for the seed and for automated backfills. */
  authorId: string;
  authorName: string;
  /** One line, in their words, on what changed and why. */
  note: string;
  /** Which parts of the brain this version touched. */
  touched: BrainSection[];
  /** The version this one was rolled back from, when that is what happened. */
  revertedFrom?: number;
  /** A fingerprint of the content, so an identical republish is visible as one. */
  digest: string;
  /** The configuration itself, frozen. */
  snapshot: BrainSnapshot;
}

/**
 * The parts of a venue that determine what the agent says and does.
 *
 * Deliberately a copy rather than a reference: a version has to mean what it
 * meant when it was published, and a snapshot that pointed at live data would
 * quietly rewrite its own history every time somebody edited a price.
 */
export interface BrainSnapshot {
  company: {
    name: string;
    address: string;
    phone: string;
    timezone: string;
    currency: string;
    vertical: Vertical;
    hours: Location["hours"];
    closures: string[];
  };
  agent: AgentConfig;
  restaurant?: Location["restaurant"];
  salon?: Location["salon"];
  policy?: Location["policy"];
}

export function snapshotOf(location: Location): BrainSnapshot {
  return {
    company: {
      name: location.name,
      address: location.address,
      phone: location.phone,
      timezone: location.timezone,
      currency: location.currency,
      vertical: location.vertical,
      hours: location.hours,
      closures: location.closures,
    },
    agent: location.agent,
    restaurant: location.restaurant,
    salon: location.salon,
    policy: location.policy,
  };
}

function digestOf(snapshot: BrainSnapshot): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(snapshot))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Which sections differ between two snapshots.
 *
 * Coarse on purpose. "Services and policies changed" is what an owner scanning
 * a history wants; a field-level diff is what an engineer wants, and the
 * snapshots are both there to produce one on demand.
 */
export function changedSections(before: BrainSnapshot | null, after: BrainSnapshot): BrainSection[] {
  if (!before) {
    return ["company", "services", "staff", "policies", "rules", "room", "faqs", "escalation", "style"];
  }

  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const touched: BrainSection[] = [];

  if (!same(before.company, after.company)) touched.push("company");
  if (
    !same(before.restaurant?.services, after.restaurant?.services) ||
    !same(before.salon?.services, after.salon?.services)
  ) {
    touched.push("services");
  }
  if (!same(before.salon?.staff, after.salon?.staff)) touched.push("staff");
  // The physical side: tables, sections, rooms and equipment. A change here
  // moves where people sit rather than what they are told, so it is worth
  // seeing separately from the price list.
  if (
    !same(before.restaurant?.tables, after.restaurant?.tables) ||
    !same(before.restaurant?.sections, after.restaurant?.sections) ||
    !same(before.salon?.resources, after.salon?.resources)
  ) {
    touched.push("room");
  }
  if (!same(before.policy, after.policy)) touched.push("rules");
  if (!same(before.agent.policies, after.agent.policies)) touched.push("policies");
  if (!same(before.agent.faqs, after.agent.faqs)) touched.push("faqs");
  if (!same(before.agent.transferNumber, after.agent.transferNumber)) touched.push("escalation");
  if (
    !same(before.agent.persona, after.agent.persona) ||
    !same(before.agent.greeting, after.agent.greeting) ||
    !same(before.agent.voiceId, after.agent.voiceId) ||
    !same(before.agent.voiceModel, after.agent.voiceModel) ||
    !same(before.agent.voiceSpeed, after.agent.voiceSpeed)
  ) {
    touched.push("style");
  }
  return touched;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export function historyFor(location: Location): BrainVersion[] {
  return [...(location.brainHistory ?? [])].sort((a, b) => b.number - a.number);
}

export function currentVersion(location: Location): BrainVersion | undefined {
  return historyFor(location)[0];
}

export function versionNumber(location: Location, number: number): BrainVersion | undefined {
  return historyFor(location).find((v) => v.number === number);
}

export interface PublishResult {
  version: BrainVersion;
  /** False when the content was identical and no version was written. */
  changed: boolean;
}

/**
 * Record the venue's current configuration as a new version.
 *
 * Called after a change is saved rather than instead of saving it: the live
 * venue stays the single source of truth for what the agent reads on the next
 * call, and the history is the record of how it got that way. Making the
 * history authoritative instead would mean every call paying to reconstruct
 * a venue from its changelog.
 */
export function publish(
  locationId: string,
  by: Pick<User, "id" | "name"> | null,
  note: string,
): PublishResult | null {
  const location = getLocation(locationId);
  if (!location) return null;

  const snapshot = snapshotOf(location);
  const digest = digestOf(snapshot);
  const history = historyFor(location);
  const latest = history[0];

  // An identical republish is not a change. Recording it would fill the
  // history with entries that say nothing, and a history nobody reads is not
  // an audit trail.
  if (latest?.digest === digest) return { version: latest, changed: false };

  const version: BrainVersion = {
    id: id("brain"),
    number: (latest?.number ?? 0) + 1,
    locationId,
    createdAt: new Date().toISOString(),
    authorId: by?.id ?? "system",
    authorName: by?.name ?? "System",
    note: note.trim() || "Updated",
    touched: changedSections(latest?.snapshot ?? null, snapshot),
    digest,
    snapshot,
  };

  upsertLocation({
    ...location,
    // Newest last in storage, so the file reads chronologically; the reader
    // sorts. Capped because a venue edited daily for three years should not
    // carry a megabyte of history into every call.
    brainHistory: [...(location.brainHistory ?? []), version].slice(-200),
  });

  return { version, changed: true };
}

/**
 * Restore an earlier version.
 *
 * Publishes it forward as a new version rather than truncating the history.
 * Undoing a mistake is itself an event worth recording — and a history that
 * can be rewritten is not evidence of anything.
 */
export function revertTo(
  locationId: string,
  number: number,
  by: Pick<User, "id" | "name"> | null,
): PublishResult | null {
  const location = getLocation(locationId);
  const target = location && versionNumber(location, number);
  if (!location || !target) return null;

  upsertLocation({
    ...location,
    name: target.snapshot.company.name,
    address: target.snapshot.company.address,
    phone: target.snapshot.company.phone,
    timezone: target.snapshot.company.timezone,
    currency: target.snapshot.company.currency,
    vertical: target.snapshot.company.vertical,
    hours: target.snapshot.company.hours,
    closures: target.snapshot.company.closures,
    agent: target.snapshot.agent,
    restaurant: target.snapshot.restaurant,
    salon: target.snapshot.salon,
  });

  const result = publish(locationId, by, `Reverted to version ${number}`);
  if (result?.changed) {
    const restored = getLocation(locationId)!;
    const withMarker = historyFor(restored).map((v) =>
      v.id === result.version.id ? { ...v, revertedFrom: number } : v,
    );
    upsertLocation({
      ...restored,
      brainHistory: [...withMarker].sort((a, b) => a.number - b.number),
    });
  }
  return result;
}

/**
 * Make sure a venue has at least one version.
 *
 * Seeded venues and venues that predate this file have configuration but no
 * history. Without a baseline the first real edit would show as "everything
 * changed", which is true and useless.
 */
export function ensureBaseline(location: Location): void {
  if ((location.brainHistory?.length ?? 0) > 0) return;
  publish(location.id, null, "Initial configuration");
}

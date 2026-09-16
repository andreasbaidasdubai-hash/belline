import type { User } from "../types";
import { getLocation, listCalls, upsertLocation } from "../store";
import { publish } from "../brain";
import { track } from "../reception/events";
import { factsFrom, journey, recordStep, type Blocker } from "./journey";

/**
 * Going live, as the one place it happens.
 *
 * Both routes that can ask for it (/api/setup/activate and the journey route's
 * "activate" action) call this, and it re-reads the venue and re-runs the
 * journey itself, so a request sent by hand is held to exactly the gate the
 * page shows: every step done, the checks passed against the setup as it is
 * now, nothing readiness() finds missing, and a clinic only once clinics open.
 */

export type ActivateResult =
  | { ok: true; next: string }
  | { ok: false; status: number; error: string; fix?: string; blockers: Blocker[] };

export async function activateVenue(locationId: string, by: Pick<User, "id" | "name">, now: Date = new Date()): Promise<ActivateResult> {
  const location = getLocation(locationId);
  if (!location) return { ok: false, status: 404, error: "Business not found.", blockers: [] };

  const facts = factsFrom(location, listCalls(location.id));
  const out = recordStep(location, { kind: "activate", by: by.id }, facts, now);
  if (!out.ok) {
    return { ok: false, status: out.status, error: out.error, fix: out.fix, blockers: journey(location, facts, now).blockers };
  }

  const saved = upsertLocation(out.location);
  // A line in the history, although nothing the agent says has changed: which
  // version a venue went live on is the first thing asked about its first call.
  publish(saved.id, by, "Went live", { force: true });
  // Never throws; without Postgres it is dropped.
  await track({ tenantId: saved.tenantId, locationId: saved.id, name: "account.activated", payload: { by: by.id } });

  const live = getLocation(saved.id) ?? saved;
  return { ok: true, next: journey(live, factsFrom(live, listCalls(live.id)), now).next?.url ?? "/" };
}

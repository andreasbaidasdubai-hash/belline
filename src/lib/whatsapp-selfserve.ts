import type { Location, OnboardingState } from "./types";
import { getLocation, listLocations, upsertLocation } from "./store";
import { flag } from "./flags";
import { openException } from "./exceptions";
import { freshOnboarding } from "./onboarding/journey";
import type { WhatsAppStatus } from "./whatsapp";
import {
  TOKEN_EXPIRED_MESSAGE,
  finishNumber,
  isTokenError,
  startNumber,
  subscribeApps,
  type Graph,
} from "./whatsapp-provision";

/**
 * WhatsApp for a customer, self-serve, as a set of states.
 *
 * The second-number model from whatsapp.ts: the venue's number lives in
 * Belline's own WhatsApp business account, so the owner never does Meta's
 * paperwork. What the owner does see is where it has got to:
 *
 *   none → pending_code → pending_name → live
 *                              ↘ rejected (Meta refused the name; try again)
 *
 * `pending_name` is Meta reviewing the display name, which takes hours, so a
 * scheduled job asks Meta and moves the venue on. Nothing here is a dead end:
 * our own token expiring opens a ticket and tells the owner it is ours to fix,
 * and a failed lookup offers a retry.
 *
 * WhatsApp is optional. `journey()` never reads any of this, so Go live never
 * waits on it. With `channel.whatsapp.selfserve` off the card says
 * "Coming soon", with a way to ask to be told.
 */

type WaState = NonNullable<OnboardingState["channels"]["whatsapp"]>;

export type WhatsAppCard =
  | { state: "soon" }
  | { state: "unavailable" }
  | { state: "blocked"; message: string }
  | { state: "none" }
  | { state: "pending_code"; number: string }
  | { state: "pending_name"; number: string; since: string }
  | { state: "rejected"; reason: string }
  | { state: "live"; number: string };

function saveWa(location: Location, patch: Partial<WaState> & { status: WaState["status"] }, now: Date): Location {
  const fresh = getLocation(location.id) ?? location;
  const o = fresh.onboarding ?? freshOnboarding();
  const prev = o.channels.whatsapp;
  const since = prev?.status === patch.status ? prev.since : now.toISOString();
  const next: WaState = { ...prev, ...patch, since };
  return upsertLocation({ ...fresh, onboarding: { ...o, channels: { ...o.channels, whatsapp: next } } });
}

/** What the card shows. `lookup` is `whatsappStatus()`, read by the caller. */
export function whatsappCard(location: Location, lookup: WhatsAppStatus, env: Record<string, string | undefined> = process.env): WhatsAppCard {
  if (lookup.state === "connected" && location.onboarding?.channels.whatsapp?.status !== "pending_name") {
    return { state: "live", number: lookup.account.phoneE164 ?? location.onboarding?.channels.whatsapp?.number ?? "" };
  }
  if (!flag("channel.whatsapp.selfserve", env)) return { state: "soon" };
  if (lookup.state === "unavailable") return { state: "unavailable" };
  const wa = location.onboarding?.channels.whatsapp;
  if (wa?.blocked === "token") return { state: "blocked", message: TOKEN_EXPIRED_MESSAGE };
  if (wa?.status === "live" && wa.number) return { state: "live", number: wa.number };
  if (wa?.status === "pending_name" && wa.number) return { state: "pending_name", number: wa.number, since: wa.since };
  if (wa?.status === "rejected") return { state: "rejected", reason: wa.reason ?? "Meta did not accept the number." };
  if (location.whatsappPending) return { state: "pending_code", number: location.whatsappPending.number };
  return { state: "none" };
}

function tokenExpired(location: Location, where: string, now: Date): { ok: false; error: string } {
  saveWa(location, { status: location.onboarding?.channels.whatsapp?.status ?? "none", blocked: "token" }, now);
  openException({
    tenantId: location.tenantId,
    locationId: location.id,
    kind: "whatsapp_token_expired",
    reason: `Meta refused Belline's WhatsApp token while ${where}. Rotate the token; the owner has nothing to do.`,
    context: { where },
    source: "system",
  });
  return { ok: false, error: TOKEN_EXPIRED_MESSAGE };
}

export interface Provisioning {
  graph: Graph;
  wabaId: string;
  now?: Date;
}

/** Step one: add the number and have Meta send the code. */
export async function startWhatsApp(
  location: Location,
  input: { number: string; displayName: string },
  p: Provisioning,
): Promise<{ ok: true; location: Location } | { ok: false; error: string }> {
  const now = p.now ?? new Date();
  const started = await startNumber({ wabaId: p.wabaId, number: input.number, displayName: input.displayName, graph: p.graph });
  if (!started.ok) {
    return started.error === TOKEN_EXPIRED_MESSAGE ? tokenExpired(location, "adding a number", now) : started;
  }
  const number = input.number.replace(/[^\d+]/g, "");
  const fresh = getLocation(location.id) ?? location;
  upsertLocation({
    ...fresh,
    whatsappPending: { number, phoneNumberId: started.phoneNumberId, displayName: input.displayName, startedAt: now.toISOString() },
  });
  return { ok: true, location: saveWa(fresh, { status: "pending_code", number, phoneNumberId: started.phoneNumberId, reason: undefined }, now) };
}

export type Connect = (input: { location: Location; number: string; phoneNumberId: string; pin: string }) => Promise<{ ok: true } | { ok: false; error: string }>;

/**
 * Step two: the code, registration, webhooks, and the account Belle answers
 * on. The venue then waits on Meta's name review in `pending_name`.
 */
export async function finishWhatsApp(
  location: Location,
  code: string,
  p: Provisioning & { connect: Connect },
): Promise<{ ok: true; location: Location } | { ok: false; error: string }> {
  const now = p.now ?? new Date();
  const pending = location.whatsappPending;
  if (!pending) return { ok: false, error: "Nothing is waiting for a code. Start again with the number." };

  const finished = await finishNumber({ phoneNumberId: pending.phoneNumberId, code, graph: p.graph });
  if (!finished.ok) {
    return finished.error === TOKEN_EXPIRED_MESSAGE ? tokenExpired(location, "verifying a code", now) : finished;
  }
  const subscribed = await subscribeApps(p.wabaId, p.graph);
  if (!subscribed.ok) {
    return subscribed.token ? tokenExpired(location, "subscribing the app", now) : { ok: false, error: subscribed.error };
  }
  const connected = await p.connect({ location, number: pending.number, phoneNumberId: pending.phoneNumberId, pin: finished.pin });
  if (!connected.ok) {
    // Verified at Meta but not saved here: the owner is told to try again, and
    // the logs keep the reason. Never Meta's or the database's own words.
    console.error(`[whatsapp] could not save ${location.id}'s account: ${connected.error}`);
    return { ok: false, error: "Belline could not finish saving that just now. Try again in a minute." };
  }
  const fresh = { ...(getLocation(location.id) ?? location) };
  delete fresh.whatsappPending;
  upsertLocation(fresh);
  return { ok: true, location: saveWa(fresh, { status: "pending_name", number: pending.number, phoneNumberId: pending.phoneNumberId }, now) };
}

const APPROVED = new Set(["APPROVED", "AVAILABLE_WITHOUT_REVIEW"]);
const REFUSED = new Set(["DECLINED", "REJECTED"]);

/** Ask Meta how the name review is going, and move the venue on. */
export async function checkWhatsApp(location: Location, graph: Graph, now: Date = new Date()): Promise<WhatsAppCard["state"] | "unchanged"> {
  const wa = location.onboarding?.channels.whatsapp;
  if (wa?.status !== "pending_name" || !wa.phoneNumberId || !graph.get) return "unchanged";
  const reply = await graph.get(wa.phoneNumberId, "name_status,code_verification_status");
  if (!reply.ok) {
    if (isTokenError(reply)) {
      tokenExpired(location, "checking a name review", now);
      return "blocked";
    }
    saveWa(location, { status: "pending_name", checkedAt: now.toISOString() }, now);
    return "unchanged";
  }
  const status = String(reply.body.name_status ?? "").toUpperCase();
  if (APPROVED.has(status)) {
    saveWa(location, { status: "live", checkedAt: now.toISOString(), blocked: undefined }, now);
    return "live";
  }
  if (REFUSED.has(status)) {
    const rejections = (wa.rejections ?? 0) + 1;
    saveWa(
      location,
      {
        status: "rejected",
        rejections,
        checkedAt: now.toISOString(),
        reason: "Meta didn't accept the name shown on WhatsApp. Use your business's name as it appears on your signage, and try again.",
      },
      now,
    );
    if (rejections >= 2) {
      openException({
        tenantId: location.tenantId,
        locationId: location.id,
        kind: "whatsapp_rejected",
        reason: `Meta refused the display name for ${wa.number ?? "the number"} ${rejections} times.`,
        context: { phoneNumberId: wa.phoneNumberId, rejections },
        source: "system",
      });
    }
    return "rejected";
  }
  saveWa(location, { status: "pending_name", checkedAt: now.toISOString() }, now);
  return "unchanged";
}

/** The scheduled job: every venue waiting on Meta's review. Never throws. */
export async function runWhatsAppChecks(graph: Graph, now: Date = new Date()): Promise<{ checked: number; moved: number }> {
  let checked = 0;
  let moved = 0;
  for (const location of listLocations({ includeInternal: true }).filter((l) => l.onboarding?.channels.whatsapp?.status === "pending_name")) {
    try {
      checked++;
      const out = await checkWhatsApp(location, graph, now);
      if (out !== "unchanged") moved++;
    } catch (err) {
      console.error(`[whatsapp] name check failed for ${location.id}:`, err instanceof Error ? err.message : String(err));
    }
  }
  return { checked, moved };
}

/** Giving up on a pending number, or trying again after a refusal. */
export function resetWhatsApp(location: Location, now: Date = new Date()): Location {
  const fresh = { ...(getLocation(location.id) ?? location) };
  delete fresh.whatsappPending;
  upsertLocation(fresh);
  return saveWa(fresh, { status: "none", number: undefined, phoneNumberId: undefined, reason: undefined }, now);
}

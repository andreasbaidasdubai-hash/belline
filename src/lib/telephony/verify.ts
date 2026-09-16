import crypto from "node:crypto";
import type { Call, Location, OnboardingState } from "../types";
import { findCallBySid, getLocation, id, saveCall, upsertLocation } from "../store";
import { freshOnboarding } from "../onboarding/journey";
import { bellineNumberOf } from "./number";
import { openException } from "../exceptions";

/**
 * "I've set it — test it": proving forwarding works without calling anybody.
 *
 * The owner taps the button, and for ten minutes any call arriving on the
 * venue's Belline number is taken as their test. They ring their own business
 * number from another phone and let it ring out; if forwarding works, the call
 * lands here. It is answered with a short script instead of the agent, stored
 * as a test (never billed, never counted), and the phone channel is marked
 * verified.
 *
 * When Twilio says which number forwarded the call (`ForwardedFrom`, or
 * `CalledVia` on some carriers), it has to be the owner's own business number,
 * so a real customer who happens to dial the Belline number directly during
 * the window gets the agent. When Twilio says nothing, the window alone decides.
 */

export const WINDOW_MINUTES = 10;

export const TEST_SCRIPT = "This is your Belline test call. It worked. You can hang up now.";

const digits = (n: string | undefined) => (n ?? "").replace(/\D/g, "");

type Phone = NonNullable<OnboardingState["channels"]["phone"]>;

function withPhone(location: Location, phone: Phone): Location {
  const o = location.onboarding ?? freshOnboarding();
  return { ...location, onboarding: { ...o, channels: { ...o.channels, phone } } };
}

export type WindowState =
  | { state: "none" }
  | { state: "open"; expiresAt: string }
  | { state: "verified"; at: string }
  | { state: "expired"; failedWindows: number };

/**
 * Where the venue's verification stands. An expired window is counted as a
 * failure the first time this notices it, and the second failure opens a ticket.
 */
export function verificationState(location: Location, now: Date = new Date()): WindowState {
  const phone = location.onboarding?.channels.phone;
  if (phone?.forwardingVerifiedAt) return { state: "verified", at: phone.forwardingVerifiedAt };
  const w = phone?.verification;
  if (!w) return phone?.failedWindows ? { state: "expired", failedWindows: phone.failedWindows } : { state: "none" };
  if (Date.parse(w.expiresAt) > now.getTime()) return { state: "open", expiresAt: w.expiresAt };

  const failedWindows = (phone?.failedWindows ?? 0) + 1;
  const next: Phone = { ...phone, failedWindows };
  delete next.verification;
  upsertLocation(withPhone(location, next));
  if (failedWindows >= 2) {
    openException({
      tenantId: location.tenantId,
      locationId: location.id,
      kind: "forwarding_unverified_2x",
      reason: `No forwarded call arrived in ${failedWindows} test windows. Carrier: ${phone?.carrier ?? "not said"}.`,
      context: { carrier: phone?.carrier ?? null, failedWindows },
      source: "system",
    });
  }
  return { state: "expired", failedWindows };
}

export type OpenResult = { ok: true; expiresAt: string } | { ok: false; status: number; error: string };

export function openWindow(location: Location, carrier: Phone["carrier"] | undefined, now: Date = new Date()): OpenResult {
  if (!bellineNumberOf(location)) return { ok: false, status: 409, error: "Your Belline number is not ready yet, so there is nothing to test." };
  const phone = location.onboarding?.channels.phone ?? {};
  if (phone.forwardingVerifiedAt) return { ok: true, expiresAt: now.toISOString() };
  const expiresAt = new Date(now.getTime() + WINDOW_MINUTES * 60_000).toISOString();
  upsertLocation(
    withPhone(location, {
      ...phone,
      ...(carrier ? { carrier } : {}),
      verification: { nonce: crypto.randomInt(1000, 10000).toString(), openedAt: now.toISOString(), expiresAt },
    }),
  );
  return { ok: true, expiresAt };
}

/** The owner's own line, which forwarding should come from. */
function businessNumbers(location: Location): string[] {
  // The business phone first: it is the line the owner forwards.
  return [location.businessPhone, location.onboarding?.escalation?.transferNumber, location.agent.transferNumber].map(digits).filter((d) => d.length >= 8);
}

/**
 * Is this inbound call the owner's test? Twilio's webhook parameters in, a
 * decision out. Pure apart from the clock.
 */
export function isVerificationCall(location: Location, params: Record<string, string>, now: Date = new Date()): boolean {
  const w = location.onboarding?.channels.phone?.verification;
  if (!w || Date.parse(w.expiresAt) <= now.getTime()) return false;
  const belline = bellineNumberOf(location);
  if (digits(params.To) !== digits(belline) || !digits(belline)) return false;
  const via = digits(params.ForwardedFrom || params.CalledVia);
  if (!via) return true;
  const own = businessNumbers(location);
  // Compared on the last nine digits: carriers pass the same line as 04…, 9714… or +9714….
  return own.length === 0 || own.some((n) => n.slice(-9) === via.slice(-9));
}

/**
 * Record the test call and mark forwarding verified. A second webhook for the
 * same CallSid returns the call already recorded.
 */
export function recordVerificationCall(location: Location, params: Record<string, string>, now: Date = new Date()): Call {
  const sid = (params.CallSid ?? "").trim();
  const existing = sid ? findCallBySid(sid) : undefined;
  if (existing) return existing;

  const at = now.toISOString();
  const call = saveCall({
    id: id("call"),
    locationId: location.id,
    channel: "phone",
    from: params.From ?? "unknown",
    startedAt: at,
    endedAt: at,
    status: "completed",
    outcome: null,
    transcript: [{ role: "agent", text: TEST_SCRIPT, at }],
    toolCalls: [],
    latenciesMs: [],
    isTest: true,
    ...(sid ? { callSid: sid } : {}),
    summary: "Forwarding test call",
  } as Call);

  const fresh = getLocation(location.id) ?? location;
  const phone = { ...(fresh.onboarding?.channels.phone ?? {}), forwardingVerifiedAt: at };
  delete phone.verification;
  upsertLocation(withPhone(fresh, phone));
  return call;
}

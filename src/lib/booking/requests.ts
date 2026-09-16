import { createHash, randomUUID } from "node:crypto";
import type { BookingRequest, Call, Location, RequestRules } from "../types";

/**
 * A booking request: the details, for a team that confirms bookings itself.
 *
 * Nothing is reserved and nothing is checked against a diary, because there is
 * no diary Belline can see. The request lands on the call it came from, and
 * attention.ts turns it into an Inbox item that says "confirm with them".
 *
 * Asking twice in one conversation records once. The key is the conversation
 * plus what was asked for, so "Friday at eight for four" repeated is the same
 * request, and "or Saturday" said afterwards is a second one.
 */

export interface RequestInput {
  guestName: string;
  guestPhone: string;
  preferred: string;
  what?: string;
  partySize?: number;
  date?: string;
  startMin?: number;
  notes?: string;
}

export type RequestOutcome =
  | { ok: true; request: BookingRequest; duplicate: boolean }
  | { ok: false; missing: "guest_name" | "guest_phone" | "preferred" | "party_size" | "service"; say: string };

/** What a request asks for when the owner has not said. */
export function defaultRequestRules(location: Pick<Location, "vertical">): RequestRules {
  return { askFor: location.vertical === "restaurant" ? ["partySize"] : ["service"], afterHours: "request", neverSay: [] };
}

export function requestRulesOf(location: Pick<Location, "vertical" | "onboarding">): RequestRules {
  return location.onboarding?.requestRules ?? defaultRequestRules(location);
}

const squash = (s: string | undefined) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

export function requestKey(callId: string, input: RequestInput): string {
  const parts = [callId, input.date ?? "", input.startMin ?? "", squash(input.preferred), squash(input.what), input.partySize ?? ""];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

/**
 * Record the request on the call, or say what is still missing.
 *
 * Mutates `call.bookingRequests`; whoever runs the turn saves the call, as
 * with take_message.
 */
export function takeBookingRequest(location: Location, call: Call, input: RequestInput, now: Date = new Date()): RequestOutcome {
  const rules = requestRulesOf(location);
  const guestName = input.guestName.trim();
  const guestPhone = input.guestPhone.trim();
  const preferred = input.preferred.trim();

  if (!guestName) return { ok: false, missing: "guest_name", say: "Ask for their name first." };
  if (!guestPhone) return { ok: false, missing: "guest_phone", say: "Ask for a contact number, and read it back." };
  if (!preferred) return { ok: false, missing: "preferred", say: "Ask when they would like to come." };
  if (rules.askFor.includes("partySize") && !(input.partySize && input.partySize > 0)) {
    return { ok: false, missing: "party_size", say: "Ask how many people it is for." };
  }
  if (rules.askFor.includes("service") && !input.what?.trim()) {
    return { ok: false, missing: "service", say: "Ask what they would like to book." };
  }

  const clean: RequestInput = {
    guestName,
    guestPhone,
    preferred,
    what: input.what?.trim() || undefined,
    partySize: input.partySize && input.partySize > 0 ? Math.round(input.partySize) : undefined,
    date: input.date,
    startMin: input.startMin,
    // A clinic's request carries no free text at all: that field is where a
    // symptom would end up, and a request needs none to be confirmed.
    notes: location.vertical === "clinic" ? undefined : input.notes?.trim() || undefined,
  };
  const key = requestKey(call.id, clean);
  const existing = call.bookingRequests?.find((r) => r.key === key);
  if (existing) return { ok: true, request: existing, duplicate: true };

  const request: BookingRequest = {
    id: `req_${randomUUID().slice(0, 12)}`,
    key,
    at: now.toISOString(),
    ...Object.fromEntries(Object.entries(clean).filter(([, v]) => v !== undefined)),
  } as BookingRequest;
  call.bookingRequests = [...(call.bookingRequests ?? []), request];
  return { ok: true, request, duplicate: false };
}

/** One line for the Inbox: "Table for 4 · Friday 8pm". */
export function describeRequest(request: BookingRequest): string {
  const what = request.partySize ? `Table for ${request.partySize}` : request.what || "A booking";
  return `${what} · ${request.preferred}`;
}

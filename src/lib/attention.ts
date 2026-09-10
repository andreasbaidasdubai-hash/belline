import type { Call, Location } from "./types";
import { listCalls, saveCall, getCall } from "./store";
import { authorityRules } from "./agent/authority";
import { terms } from "./verticals";

/**
 * What still needs a person.
 *
 * The dashboard's most valuable question is not "how many calls did we take"
 * — it is "is there anything I have to do about them?". An owner opens this
 * product between patients or mid-service; they have ninety seconds, and what
 * they need is a short list they can clear, not a chart.
 *
 * So: every call is either handled or it is not, and only the second kind
 * appears here. An escalation is not a failure — a call correctly sent to a
 * human is the system working — but it *is* a thing somebody must now do
 * something about, and the difference between those two statements is the
 * whole design.
 *
 * Derived rather than stored. An item exists because a call has a property,
 * so a call that was mishandled cannot quietly fail to raise a flag, and a
 * new rule about what deserves attention applies to history immediately.
 */

export type AttentionKind =
  | "escalated"
  | "transferred"
  | "message"
  | "booking_failed"
  | "abandoned";

export interface AttentionItem {
  callId: string;
  locationId: string;
  kind: AttentionKind;
  /** Ordering. Higher is more urgent; an emergency outranks a hang-up. */
  urgency: number;
  /** Who rang. A number when that is all we have. */
  who: string;
  /** What they wanted, in one line. */
  what: string;
  /** Why this is on the list rather than in the handled pile. */
  why: string;
  /** What the person reading this should do. */
  todo: string;
  at: string;
  callbackNumber?: string;
}

/** The caller's own words from the first thing they said. */
function firstAsk(call: Call): string {
  return call.transcript.find((t) => t.role === "caller")?.text ?? "";
}

function whoCalled(call: Call): string {
  const name = call.escalation?.split(":")[0]?.split("(")[0]?.trim();
  if (name && name !== "Caller") return name;
  return call.from && call.from !== "browser-console" ? call.from : "Unknown caller";
}

/**
 * Everything outstanding for a venue, most urgent first.
 *
 * Resolved items drop off entirely. An inbox that keeps what you have already
 * dealt with stops being an inbox within a week.
 */
export function attentionFor(location: Location, includeResolved = false): AttentionItem[] {
  const t = terms(location);
  const rules = authorityRules(location);

  const items = listCalls(location.id)
    .filter((call) => call.status === "completed")
    .filter((call) => includeResolved || !call.attentionResolvedAt)
    // A demo line's calls are strangers kicking the tyres; they are not work.
    .filter((call) => !call.isDemo)
    .flatMap<AttentionItem>((call) => {
      const base = {
        callId: call.id,
        locationId: location.id,
        who: whoCalled(call),
        at: call.endedAt ?? call.startedAt,
        what: call.summary ?? firstAsk(call) ?? "—",
      };

      if (call.outcome === "escalated") {
        const rule = rules.find((r) => r.id === call.authorityRuleId);
        return [
          {
            ...base,
            kind: "escalated",
            urgency: 100,
            why: rule?.reason ?? "Belline judged this beyond what it may answer.",
            todo: `Ring this ${t.guest} back. Belline sent them elsewhere and took no booking.`,
            callbackNumber: call.from,
          },
        ];
      }

      if (call.outcome === "transferred") {
        return [
          {
            ...base,
            kind: "transferred",
            urgency: 70,
            why: "Handed to a person mid-call.",
            todo: "Check somebody picked up, and that it was dealt with.",
            callbackNumber: call.from,
          },
        ];
      }

      if (call.outcome === "message_taken") {
        return [
          {
            ...base,
            kind: "message",
            urgency: 60,
            what: call.escalation ?? base.what,
            why: "Belline could not do this itself, so it took the details.",
            todo: "Call them back.",
            callbackNumber: call.from,
          },
        ];
      }

      // Wanted something, did not get it. The one that quietly costs money:
      // nobody complains, they just book somewhere else.
      if (call.outcome === "answered_question" && !call.bookingId && wantedToBook(call)) {
        return [
          {
            ...base,
            kind: "booking_failed",
            urgency: 50,
            why: `They asked about ${t.booking === "reservation" ? "a table" : "an appointment"} and left without one.`,
            todo: "Worth a call back — this is business that walked.",
            callbackNumber: call.from,
          },
        ];
      }

      // Hung up mid-conversation. Usually nothing; occasionally a caller who
      // gave up on the agent, which is worth knowing about.
      if (call.outcome === "abandoned" && call.transcript.length > 2) {
        return [
          {
            ...base,
            kind: "abandoned",
            urgency: 20,
            why: "The caller rang off part-way through.",
            todo: "Read it back. If Belline was the reason, that is worth fixing.",
            callbackNumber: call.from,
          },
        ];
      }

      return [];
    });

  return items.sort((a, b) => b.urgency - a.urgency || b.at.localeCompare(a.at));
}

/** Did this caller want to book, judging by their own words? */
function wantedToBook(call: Call): boolean {
  const said = call.transcript
    .filter((turn) => turn.role === "caller")
    .map((turn) => turn.text.toLowerCase())
    .join(" ");
  return /\b(book|reserve|reservation|appointment|table|availab|slot|come in)\b/.test(said);
}

/** Mark an item dealt with. The call stays; it just leaves the list. */
export function resolveAttention(callId: string, userId: string): Call | null {
  const call = getCall(callId);
  if (!call) return null;
  return saveCall({
    ...call,
    attentionResolvedAt: new Date().toISOString(),
    attentionResolvedBy: userId,
  });
}

export function reopenAttention(callId: string): Call | null {
  const call = getCall(callId);
  if (!call) return null;
  const { attentionResolvedAt: _a, attentionResolvedBy: _b, ...rest } = call;
  return saveCall(rest as Call);
}

export const KIND_LABEL: Record<AttentionKind, string> = {
  escalated: "Sent elsewhere",
  transferred: "Transferred",
  message: "Message",
  booking_failed: "Left without booking",
  abandoned: "Rang off",
};

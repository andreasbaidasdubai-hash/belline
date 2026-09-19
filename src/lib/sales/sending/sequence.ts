/**
 * The sequence: a first demo email and up to three follow-ups.
 *
 * Every step after the first exists on sufferance. The prospect did not ask to
 * be written to, and the only thing that makes a follow-up defensible is that
 * it stops the instant they show any response at all — a reply, a click into
 * the demo, an unsubscribe, a bounce, a complaint. "Stops" here means stops
 * everywhere: the lead's state, the queued items, and any other sequence
 * touching the same company.
 *
 * Spacing is staff-settable per step but floored by the country rule, so
 * nobody can turn a Swiss four-day gap into a one-day one from a settings
 * screen.
 */

import type { EffectiveCountry } from "./countries";
import type { SequenceState, StopReason } from "./store";

export interface StepDefinition {
  step: number;
  /** What this message is, in the words the staff screens use. */
  label: string;
  /** Days after the previous message, before the country floor is applied. */
  spacingDays: number;
  purpose: string;
}

/**
 * The default shape. Staff can change the spacing; they cannot add a fifth.
 *
 * The gaps widen deliberately. A second message three days later reads as
 * diligence; a fourth message three days after the third reads as a machine.
 */
export const DEFAULT_STEPS: readonly StepDefinition[] = [
  { step: 1, label: "Demo sent", spacingDays: 0, purpose: "The first email, carrying the personalised demo link." },
  { step: 2, label: "Follow-up 1", spacingDays: 4, purpose: "A short nudge: the demo is still there." },
  { step: 3, label: "Follow-up 2", spacingDays: 7, purpose: "One new angle, not a repeat of the first." },
  { step: 4, label: "Final", spacingDays: 11, purpose: "A single closing line. Nothing after this, ever." },
];

export const MAX_STEPS = DEFAULT_STEPS.length;

export interface Spacing {
  /** Index 0 is unused; index n is the gap in days before step n. */
  days: number[];
}

/** Staff spacing, clamped up to the country's minimum. Never down. */
export function spacingFor(country: EffectiveCountry, staff?: Partial<Record<number, number>>): number[] {
  return DEFAULT_STEPS.map((definition) => {
    if (definition.step === 1) return 0;
    const asked = staff?.[definition.step] ?? definition.spacingDays;
    return Math.max(asked, country.minDaysBetweenTouches);
  });
}

export function stepLabel(step: number): string {
  return DEFAULT_STEPS.find((s) => s.step === step)?.label ?? `Step ${step}`;
}

/**
 * How many steps this lead may ever receive.
 *
 * The country rule caps it; DACH is three, the Gulf four.
 */
export function stepsAllowed(country: EffectiveCountry): number {
  return Math.min(country.maxSequenceSteps, MAX_STEPS);
}

/** Every reason a sequence stops, with what to tell a member of staff. */
export const STOP_WORDS: Record<StopReason, string> = {
  replied: "they replied",
  demo_clicked: "they opened the demo",
  unsubscribed: "they unsubscribed",
  bounced: "the address bounced",
  complaint: "they marked it as spam",
  suppressed: "the company is suppressed",
  cap: "the sequence finished",
  staff: "a member of staff stopped it",
};

/**
 * Events that end a sequence on sight.
 *
 * `demo_clicked` is in the list and that is the point of the whole engine: the
 * email exists to earn one click, and once it has, a follow-up saying "did you
 * see the demo" is both pointless and insulting. The lead goes to a person.
 */
export const HALTING: readonly StopReason[] = [
  "replied",
  "demo_clicked",
  "unsubscribed",
  "bounced",
  "complaint",
  "suppressed",
  "staff",
];

export function isHalting(reason: StopReason): boolean {
  return HALTING.includes(reason);
}

export interface AdvanceInput {
  state: SequenceState;
  country: EffectiveCountry;
  spacing: number[];
  sentAt: Date;
}

/**
 * The lead's state after a send has gone out.
 *
 * `completed` rather than `stopped` when the last allowed step has been sent:
 * the difference matters on the screens, because a completed sequence is one
 * that worked as designed and a stopped one is one something interrupted.
 */
export function advance(input: AdvanceInput): SequenceState {
  const step = input.state.step + 1;
  const allowed = stepsAllowed(input.country);
  if (step >= allowed) {
    return {
      ...input.state,
      step,
      status: "completed",
      stopReason: "cap",
      stoppedAt: input.sentAt.toISOString(),
      nextDueAt: null,
      lastSentAt: input.sentAt.toISOString(),
      pausedUntil: null,
      pauseReason: null,
    };
  }
  const gapDays = input.spacing[step] ?? DEFAULT_STEPS[step]?.spacingDays ?? 7;
  return {
    ...input.state,
    step,
    status: "active",
    stopReason: null,
    stoppedAt: null,
    nextDueAt: new Date(input.sentAt.getTime() + gapDays * 86_400_000).toISOString(),
    lastSentAt: input.sentAt.toISOString(),
    // A send is proof the pause is over.
    pausedUntil: null,
    pauseReason: null,
  };
}

/** The state after something halted it. Idempotent: a second stop is a no-op. */
export function halt(state: SequenceState, reason: StopReason, at: Date): SequenceState {
  if (state.status === "stopped") return state;
  return {
    ...state,
    status: "stopped",
    stopReason: reason,
    stoppedAt: at.toISOString(),
    nextDueAt: null,
    // A stop outranks a pause and clears it, so a lead cannot be both.
    pausedUntil: null,
    pauseReason: null,
  };
}

/**
 * The longest a single auto-reply may hold a sequence.
 *
 * An out-of-office that says "back in March" is usually a mistake, a stale
 * rule, or a mailbox nobody owns any more. Six weeks is long enough for a real
 * holiday and short enough that a wrong date does not lose the lead.
 */
export const MAX_PAUSE_DAYS = 42;

/**
 * Stand still until someone is back.
 *
 * This is the whole difference between a working pipeline and one that quietly
 * dies. An out-of-office is evidence that the address is live and that nobody
 * has read the message — the two facts that most argue for writing again
 * later. So: the step does not move, the status stays `active`, the stop
 * reason stays empty, and the only thing that changes is when the sequence
 * next becomes due.
 *
 * Never applied to a sequence that has genuinely stopped: an auto-reply
 * arriving after a human already answered must not resurrect anything.
 */
export function pause(state: SequenceState, until: Date, reason: string, now: Date): SequenceState {
  if (state.status !== "active") return state;
  const ceiling = new Date(now.getTime() + MAX_PAUSE_DAYS * 86_400_000);
  const floor = new Date(now.getTime() + 60_000);
  const at = new Date(Math.min(Math.max(until.getTime(), floor.getTime()), ceiling.getTime()));
  // A later pause wins over an earlier one; an earlier one never shortens a
  // pause already in place, because two auto-replies mean two reasons to wait.
  const existing = state.pausedUntil ? Date.parse(state.pausedUntil) : 0;
  const pausedUntil = new Date(Math.max(at.getTime(), existing)).toISOString();
  return {
    ...state,
    pausedUntil,
    pauseReason: reason.slice(0, 200),
    // The next step is pushed out to the resume moment if it fell inside the
    // pause. Left alone otherwise: a follow-up already further away is fine.
    nextDueAt:
      state.nextDueAt && state.nextDueAt < pausedUntil ? pausedUntil : state.nextDueAt,
  };
}

/** Back from holiday. A no-op on a sequence that was not paused. */
export function resume(state: SequenceState): SequenceState {
  if (!state.pausedUntil) return state;
  return { ...state, pausedUntil: null, pauseReason: null };
}

/** True when this sequence is standing still at `now`. */
export function isPaused(state: SequenceState, now: Date): boolean {
  return state.pausedUntil !== null && state.pausedUntil > now.toISOString();
}

export function blankState(leadId: number, companyId: number | null, countryCode: string | null): SequenceState {
  return {
    leadId,
    companyId,
    step: 0,
    status: "active",
    stopReason: null,
    stoppedAt: null,
    nextDueAt: null,
    lastSentAt: null,
    countryCode,
    pausedUntil: null,
    pauseReason: null,
  };
}

/** Sequences whose next step is due, for the follow-up planner. */
export function dueNow(states: readonly SequenceState[], now: Date): SequenceState[] {
  const at = now.toISOString();
  return states.filter(
    (s) =>
      s.status === "active" &&
      s.step > 0 &&
      s.nextDueAt !== null &&
      s.nextDueAt <= at &&
      // Paused is not due. Without this line an out-of-office becomes a
      // follow-up to somebody's holiday auto-responder, on the same day.
      !(s.pausedUntil !== null && s.pausedUntil > at),
  );
}

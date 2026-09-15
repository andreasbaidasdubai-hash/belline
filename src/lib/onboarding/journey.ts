import type { Call, DestinationKind, Location, OnboardingState } from "../types";
import { readiness } from "./index";
import { listCalls } from "../store";

/**
 * From signup to answering real calls, as one ordered list.
 *
 * Onboarding used to be spread over /setup, /venue, /agents, /website,
 * /integrations and /golive, and every surface decided for itself what "set
 * up" meant. This is the one answer: the /setup shell, the home page, the nav
 * and (later) Belle and the lifecycle emails all read `journey()`.
 *
 * Pure. It takes the venue and a few counted facts, and derives every step
 * from stored state, never from a "current step" pointer. That is what makes
 * resuming free: close the tab on step five, sign in next week, and the same
 * facts give step five again.
 *
 * `readiness()` stays, as a sub-check of Go live — a venue can pass every step
 * and still have no services, and that is a blocker, not a detail.
 */

export const STEP_IDS = ["business", "import", "review", "bookings", "rules", "channels", "test", "golive", "first-week"] as const;
export type StepId = (typeof STEP_IDS)[number];

export interface Step {
  id: StepId;
  /** 1-based, as shown on the rail. */
  n: number;
  title: string;
  /** The label of the step's one primary button. */
  action: string;
  url: string;
  done: boolean;
}

export interface Blocker {
  step: StepId;
  label: string;
  /** Where to fix it. Editors outside /setup carry ?from=setup for the way back. */
  fix: string;
}

export interface Journey {
  steps: Step[];
  /** The first step not done, or null once every step is. */
  next: Step | null;
  activated: boolean;
  canGoLive: boolean;
  blockers: Blocker[];
}

/** What the venue's calls say, counted outside so `journey()` stays pure. */
export interface JourneyFacts {
  /** Real calls forwarded to Belline. */
  phoneCalls: number;
  /** Real conversations through the website chat or voice widget. */
  webConversations: number;
  /** The owner talking to it in the test console. */
  testConversations: number;
  /** Real enquiries on any channel since going live. */
  enquiriesSinceLive: number;
}

export const NO_FACTS: JourneyFacts = { phoneCalls: 0, webConversations: 0, testConversations: 0, enquiriesSinceLive: 0 };

const META: Record<StepId, { title: string; action: string }> = {
  business: { title: "Your business", action: "Continue" },
  import: { title: "Read your business", action: "Read my business" },
  review: { title: "Check what it knows", action: "Looks right" },
  bookings: { title: "Where bookings go", action: "Use this" },
  rules: { title: "Your rules", action: "Confirm these rules" },
  channels: { title: "Phone and website", action: "Continue" },
  test: { title: "Try it", action: "Talk to it" },
  golive: { title: "Go live", action: "Go live" },
  "first-week": { title: "Your first week", action: "Open the dashboard" },
};

/** The steps an owner must finish before Go live is offered. */
const BEFORE_LIVE: StepId[] = ["business", "import", "review", "bookings", "rules", "channels", "test"];

const DAY_MS = 24 * 60 * 60 * 1000;

export function stepUrl(id: StepId): string {
  return `/setup/${id}`;
}

export function isStepId(value: string): value is StepId {
  return (STEP_IDS as readonly string[]).includes(value);
}

/** An empty record, as a new signup starts with it. */
export function freshOnboarding(): OnboardingState {
  return { version: 1, channels: {} };
}

/**
 * Has this venue gone live?
 *
 * A venue with no record at all predates the journey and has not been
 * backfilled yet (seed.ts does it on boot). It is treated as live, because the
 * alternative is collapsing a paying customer's dashboard for the few
 * milliseconds before the backfill runs.
 */
export function isActivated(location: Location): boolean {
  return !location.onboarding || Boolean(location.onboarding.activatedAt);
}

export function journey(location: Location, facts: JourneyFacts = NO_FACTS, now: Date = new Date()): Journey {
  const o = location.onboarding ?? freshOnboarding();
  const activated = isActivated(location);

  const doneBeforeLive: Record<Exclude<StepId, "golive" | "first-week">, boolean> = {
    business: true,
    // Setting it up by hand skips the reading, and that counts.
    import: Boolean(o.importedAt || o.reviewedAt),
    review: Boolean(o.reviewedAt),
    bookings: Boolean(o.destination),
    rules: Boolean(o.rulesConfirmedAt),
    // At least one way in. A forwarded call or a website conversation is the
    // proof until the automatic forwarding test and widget detection exist.
    channels: Boolean(
      o.channels.web?.detectedAt || o.channels.phone?.forwardingVerifiedAt || facts.phoneCalls > 0 || facts.webConversations > 0,
    ),
    // Until the automatic checks exist, the owner having talked to it in the
    // test console is the evidence. A recorded run replaces it when it lands.
    test: Boolean(o.tests?.passed || facts.testConversations > 0),
  };

  // A venue that went live already did everything before it, whatever the
  // record says: venues live before the journey existed have no import date.
  const done = (id: StepId): boolean => {
    if (id === "golive") return activated;
    if (id === "first-week") {
      const since = o.activatedAt ? Date.parse(o.activatedAt) : NaN;
      return activated && facts.enquiriesSinceLive > 0 && Number.isFinite(since) && now.getTime() - since >= 7 * DAY_MS;
    }
    return activated || doneBeforeLive[id];
  };

  const steps: Step[] = STEP_IDS.map((id, i) => ({ id, n: i + 1, ...META[id], url: stepUrl(id), done: done(id) }));
  const next = steps.find((s) => !s.done) ?? null;

  const blockers: Blocker[] = [];
  if (!activated) {
    for (const step of steps.filter((s) => BEFORE_LIVE.includes(s.id) && !s.done)) {
      blockers.push({ step: step.id, label: `${step.title} is not finished yet`, fix: step.url });
    }
    for (const m of readiness(location).missing) {
      blockers.push({ step: "review", label: `${m.label} is still missing`, fix: `${m.where}?from=setup` });
    }
  }

  return { steps, next, activated, canGoLive: !activated && blockers.length === 0, blockers };
}

/** Count the facts `journey()` needs from a venue's calls. */
export function factsFrom(location: Location, calls: Call[]): JourneyFacts {
  const real = calls.filter((c) => !c.isDemo);
  const since = location.onboarding?.activatedAt;
  return {
    phoneCalls: real.filter((c) => c.channel === "phone").length,
    webConversations: real.filter((c) => c.channel === "embed" || c.channel === "webchat").length,
    testConversations: real.filter((c) => c.channel === "browser").length,
    enquiriesSinceLive: since ? real.filter((c) => c.channel !== "browser" && c.startedAt >= since).length : 0,
  };
}

/** `journey()` for a stored venue, with its facts read from the store. */
export function journeyFor(location: Location, now: Date = new Date()): Journey {
  return journey(location, factsFrom(location, listCalls(location.id)), now);
}

/**
 * Collapse the dashboard nav to Setup, Belle and Account?
 *
 * Only for somebody all of whose venues are still being set up. Belline staff
 * always see everything, and one live venue is enough for the full nav.
 */
export function navCollapsed(locations: Location[], staff: boolean): boolean {
  const own = locations.filter((l) => !l.internal && !l.demo?.enabled);
  return !staff && own.length > 0 && own.every((l) => !isActivated(l));
}

/**
 * The record for a venue that predates the journey. Null when it has one.
 *
 * A venue already answering real calls is marked live, from its first
 * published version, on Belline's own diary — which is what it was using, so
 * nothing about how it books changes. Our demo, internal and prospect venues
 * count as live too, and so does anything in the tenants that predate signup
 * (`legacyTenant`), which is the original venue group. Anything else was a
 * trial part way through setup: it gets no activation, and a review date only
 * if what it saved is already complete.
 */
export function backfillOnboarding(
  location: Location,
  facts: JourneyFacts,
  now: Date = new Date(),
  legacyTenant = false,
): Location | null {
  if (location.onboarding) return null;
  const at = now.toISOString();
  const since = location.brainHistory?.[0]?.createdAt ?? at;
  const live = Boolean(
    legacyTenant ||
      location.internal ||
      location.demo?.enabled ||
      location.prospect ||
      location.phone.trim() ||
      location.subscription?.status === "active" ||
      facts.phoneCalls > 0 ||
      facts.webConversations > 0,
  );
  const onboarding: OnboardingState = live
    ? { version: 1, channels: {}, activatedAt: since, activatedBy: "backfill", destination: { kind: "belline", setAt: since }, backfilledAt: at }
    : { version: 1, channels: {}, ...(readiness(location).ready ? { reviewedAt: since } : {}), backfilledAt: at };
  return { ...location, onboarding };
}

/** Record a saved review. `imported` when what was saved was read from a website or files. */
export function markReviewed(location: Location, fields: string[], imported: boolean, now: Date = new Date()): Location {
  const o = location.onboarding ?? freshOnboarding();
  const at = now.toISOString();
  return {
    ...location,
    onboarding: { ...o, ...(imported ? { importedAt: at } : {}), reviewedAt: at, reviewedFields: fields },
  };
}

export type StepAction =
  | { kind: "destination"; destination: DestinationKind }
  | { kind: "rules" }
  | { kind: "activate"; by: string };

export type StepResult = { ok: true; location: Location } | { ok: false; status: number; error: string; fix?: string };

/**
 * Only destinations Belline can honour today are accepted. Belline's own diary
 * is the booking engine every venue already runs on. Requests-only, Google,
 * Outlook and partner systems each need an adapter that is not built yet, and
 * accepting them here would promise a booking outcome nobody delivers.
 */
export const AVAILABLE_DESTINATIONS: DestinationKind[] = ["belline"];

/** Apply one owner action to the record. The server calls this; it re-checks the journey itself. */
export function recordStep(location: Location, action: StepAction, facts: JourneyFacts, now: Date = new Date()): StepResult {
  const o = location.onboarding ?? freshOnboarding();
  const at = now.toISOString();

  if (action.kind === "destination") {
    if (!AVAILABLE_DESTINATIONS.includes(action.destination)) {
      return { ok: false, status: 422, error: "That option is not available yet. Choose Belline's diary for now; you can change it later." };
    }
    return { ok: true, location: { ...location, onboarding: { ...o, destination: { kind: action.destination, setAt: at } } } };
  }

  if (action.kind === "rules") {
    return { ok: true, location: { ...location, onboarding: { ...o, rulesConfirmedAt: at } } };
  }

  // Go live. Refused here as well as hidden on screen, so a direct request
  // cannot switch on a venue that has not finished.
  if (o.activatedAt) return { ok: false, status: 409, error: "This business is already live." };
  const j = journey(location, facts, now);
  if (!j.canGoLive) {
    const first = j.blockers[0];
    return { ok: false, status: 409, error: first ? `${first.label}.` : "Setup is not finished yet.", fix: first?.fix };
  }
  return { ok: true, location: { ...location, onboarding: { ...o, activatedAt: at, activatedBy: action.by } } };
}

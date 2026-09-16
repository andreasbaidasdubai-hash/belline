import type { Call, DestinationKind, Location, OnboardingState } from "../types";
import { readiness } from "./index";
import { listCalls } from "../store";
import { flag } from "../flags";
import { googleUsable } from "../booking/destination";
import { applyRules, type RulesInput } from "./rules";
import { testsCurrent, testsPassed } from "./selftest-state";
import { bellineNumberOf } from "../telephony/number";

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
  test: { title: "Try it", action: "Run the checks" },
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

export interface JourneyOptions {
  /** `vertical.clinic.selfserve`. Read from the flags when not given. */
  clinicSelfServe?: boolean;
}

export function journey(location: Location, facts: JourneyFacts = NO_FACTS, now: Date = new Date(), opts: JourneyOptions = {}): Journey {
  const clinicSelfServe = opts.clinicSelfServe ?? flag("vertical.clinic.selfserve");
  const o = location.onboarding ?? freshOnboarding();
  const activated = isActivated(location);

  const doneBeforeLive: Record<Exclude<StepId, "golive" | "first-week">, boolean> = {
    business: true,
    // Setting it up by hand skips the reading, and that counts.
    import: Boolean(o.importedAt || o.reviewedAt),
    review: Boolean(o.reviewedAt),
    bookings: Boolean(o.destination),
    rules: Boolean(o.rulesConfirmedAt),
    // At least one way in: the widget seen on the site, forwarding proved by a
    // test call, a real conversation on either, or WhatsApp connected.
    channels: Boolean(
      o.channels.web?.detectedAt ||
        o.channels.phone?.forwardingVerifiedAt ||
        o.channels.whatsapp?.status === "live" ||
        facts.phoneCalls > 0 ||
        facts.webConversations > 0,
    ),
    // The automatic checks, passed, against the setup as it is now. Talking to
    // it in the test console is useful, and proves nothing about the eight
    // conversations the checks grade.
    test: testsPassed(location),
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
      const label =
        step.id === "test" && o.tests && !testsCurrent(location)
          ? "You changed your setup after the last checks. Run the checks again"
          : step.id === "test" && o.tests && !o.tests.passed
            ? "Some checks did not pass. Fix them and run the checks again"
            : step.id === "test"
              ? "The eight checks have not been run yet"
              : `${step.title} is not finished yet`;
      blockers.push({ step: step.id, label, fix: step.url });
    }
    for (const m of readiness(location).missing) {
      blockers.push({ step: "review", label: `${m.label} is still missing`, fix: `${m.where}?from=setup` });
    }
    // Clinics can set up and try Belline, but not answer real patients until
    // the health-data opinion is in and the flag is on.
    if (location.vertical === "clinic" && !clinicSelfServe) {
      blockers.push({
        step: "golive",
        label: "Clinics open soon. Until then clinics are in a requests-only preview: you can set up and run the checks, and we will tell you when going live opens",
        fix: "/setup/test",
      });
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

// ---------------------------------------------------------------------------
// Using the dashboard is not answering customers
// ---------------------------------------------------------------------------
//
// Until 2026-09-16 the dashboard menu collapsed to Setup and Account until a
// venue went live, and each setup step refused to open until the one before it
// was done. An owner who could not paste a line into their website was stuck.
//
// Two different questions had been answered as one:
//
//   Using the dashboard — always, from the moment the account exists. Every
//   step opens in any order and can be skipped; what is left is a checklist on
//   Today, not a wall.
//
//   Answering real customers — only once the owner has said so (Go live), the
//   eight checks have passed, nothing readiness() needs is missing, and the
//   channel is connected. Checked per channel: a venue that goes live with its
//   phone answers the phone, and its website chat starts answering on its own
//   the moment the widget is on the site, without another Go live.

/** The steps shown as the setup checklist on Today: everything before going live. */
export const CHECKLIST: readonly StepId[] = BEFORE_LIVE;

export interface Checklist {
  items: Step[];
  done: number;
  total: number;
  /** The first item not done, for the one "next" button. */
  next: Step | null;
}

export function checklistOf(j: Journey): Checklist {
  const items = j.steps.filter((s) => CHECKLIST.includes(s.id));
  const done = items.filter((s) => s.done).length;
  return { items, done, total: items.length, next: items.find((s) => !s.done) ?? null };
}

/**
 * Where "Continue" or "Skip for now" goes from a step: the next unfinished step
 * after it, or the first unfinished one before it, or the dashboard.
 */
export function stepAfter(j: Journey, from: StepId): Step | null {
  const at = STEP_IDS.indexOf(from);
  const later = j.steps.find((s, i) => i > at && !s.done && s.id !== "first-week");
  if (later) return later;
  return j.steps.find((s) => !s.done && s.id !== from && s.id !== "first-week") ?? null;
}

export type ChannelId = "phone" | "web" | "whatsapp";
export const CHANNEL_IDS: readonly ChannelId[] = ["phone", "web", "whatsapp"];

/**
 *   live        answering real customers now
 *   waiting     connected or part way there, and not answering yet: the reason says why
 *   not_set_up  nothing done on this channel
 */
export type ChannelState = "live" | "waiting" | "not_set_up";

export interface ChannelStatus {
  id: ChannelId;
  label: string;
  state: ChannelState;
  /** One honest sentence. */
  detail: string;
  /** Where to act on it. */
  href: string;
}

/** Is the channel connected: a real way for a customer to reach Belline on it? */
export function channelConnected(location: Location, id: ChannelId, facts: JourneyFacts = NO_FACTS, opts: { whatsappConnected?: boolean } = {}): boolean {
  const o = location.onboarding;
  switch (id) {
    case "phone":
      return Boolean(bellineNumberOf(location) && (o?.channels.phone?.forwardingVerifiedAt || facts.phoneCalls > 0));
    case "web":
      return Boolean(location.embed?.enabled && (o?.channels.web?.detectedAt || facts.webConversations > 0));
    case "whatsapp":
      return Boolean(opts.whatsappConnected || o?.channels.whatsapp?.status === "live");
  }
}

/**
 * May Belline answer a real customer on this venue at all?
 *
 * The owner's Go live, which the journey only allows once the checks passed
 * against the setup, nothing readiness() needs is missing and a channel is
 * connected. A venue that predates the journey, and our own demo and internal
 * venues (backfilled live), answer as they always have.
 */
export function answersRealCustomers(location: Location): boolean {
  return isActivated(location);
}

/** Said to a real caller on a venue that has not gone live. Nothing about setup, trials or money. */
export function notLiveMessage(name: string): string {
  return `Thank you for calling ${name}. Nobody is able to take your call on this line just now. Please try again a little later.`;
}

/** Every channel's state, for Today, the channels step and the Channels screen. */
export function channelStatuses(
  location: Location,
  facts: JourneyFacts = NO_FACTS,
  opts: { whatsappConnected?: boolean; now?: Date; clinicSelfServe?: boolean } = {},
): ChannelStatus[] {
  const live = answersRealCustomers(location);
  const j = live ? null : journey(location, facts, opts.now, { clinicSelfServe: opts.clinicSelfServe });
  // Why a connected channel is not answering yet: the first blocker other than
  // "connect a channel", which it already is.
  const blocker = j?.blockers.find((b) => b.step !== "channels");
  const waitingWhy = blocker
    ? `Connected, not answering customers yet: ${blocker.label.charAt(0).toLowerCase()}${blocker.label.slice(1)}.`
    : "Connected. It starts answering customers when you press Go live.";
  const o = location.onboarding;

  const phone = ((): ChannelStatus => {
    const base = { id: "phone" as const, label: "Phone", href: "/golive" };
    if (channelConnected(location, "phone", facts)) {
      return live
        ? { ...base, state: "live", detail: `Forwarded calls are answered. Customers keep dialling the number they already have.` }
        : { ...base, state: "waiting", detail: waitingWhy };
    }
    if (bellineNumberOf(location)) {
      return { ...base, state: "waiting", detail: "You have a Belline number. Forward your line to it and make one test call." };
    }
    return { ...base, state: "not_set_up", detail: "Your Belline number is being prepared." };
  })();

  const web = ((): ChannelStatus => {
    const base = { id: "web" as const, label: "Website chat", href: "/website" };
    if (channelConnected(location, "web", facts)) {
      return live ? { ...base, state: "live", detail: "The chat on your website is answering visitors." } : { ...base, state: "waiting", detail: waitingWhy };
    }
    if (location.embed?.enabled) {
      return {
        ...base,
        state: "waiting",
        detail: live
          ? "Switched on, and not seen on your website yet. It answers as soon as the line of code is on your site."
          : "Switched on, and not seen on your website yet.",
      };
    }
    return { ...base, state: "not_set_up", detail: "Not added to your website yet." };
  })();

  const whatsapp = ((): ChannelStatus => {
    const base = { id: "whatsapp" as const, label: "WhatsApp", href: "/integrations" };
    if (channelConnected(location, "whatsapp", facts, opts)) {
      return live ? { ...base, state: "live", detail: "Belline answers your second WhatsApp number." } : { ...base, state: "waiting", detail: waitingWhy };
    }
    if (o?.channels.whatsapp && o.channels.whatsapp.status !== "none") {
      return { ...base, state: "waiting", detail: "Being connected." };
    }
    return { ...base, state: "not_set_up", detail: "Not set up." };
  })();

  return [phone, web, whatsapp];
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
  | { kind: "destination"; destination: DestinationKind; bookingLink?: string }
  | { kind: "integration"; integration: string }
  | { kind: "rules"; rules?: RulesInput }
  | { kind: "activate"; by: string };

export type StepResult =
  | { ok: true; location: Location }
  | { ok: false; status: number; error: string; fix?: string; field?: string };

/** Systems an owner can ask Belline to connect to. Asking records interest; nothing more. */
export const INTEGRATIONS: Record<string, string> = {
  fresha: "Fresha",
  sevenrooms: "SevenRooms",
  opentable: "OpenTable",
  treatwell: "Treatwell",
  google: "Google Calendar",
  outlook: "Outlook",
  whatsapp: "WhatsApp",
  other: "another booking system",
};

/**
 * Is Belline's own diary offered to this venue?
 *
 * Kept for accounts that already book into it, and for new signups only when
 * FLAG_BELLINE_DIARY is on. A clinic is never offered it while clinics are a
 * requests-only preview.
 */
export function bellineDiaryOffered(location: Location, env: Record<string, string | undefined> = process.env): boolean {
  if (location.vertical === "clinic" && !flag("vertical.clinic.selfserve", env)) return false;
  return flag("belline.diary", env) || location.onboarding?.destination?.kind === "belline" || isActivated(location);
}

/** An owner's own booking page: a public http(s) address, or why not. */
export function checkBookingLink(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  const text = raw.trim();
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return { ok: false, error: "That booking link does not look like a web address." };
  }
  if (!/^https?:$/.test(url.protocol) || !url.hostname.includes(".") || text.length > 300 || /\s/.test(text)) {
    return { ok: false, error: "That booking link does not look like a web address." };
  }
  return { ok: true, url: url.toString() };
}

/** Apply one owner action to the record. The server calls this; it re-checks the journey itself. */
export function recordStep(location: Location, action: StepAction, facts: JourneyFacts, now: Date = new Date()): StepResult {
  const o = location.onboarding ?? freshOnboarding();
  const at = now.toISOString();

  if (action.kind === "destination") {
    const kind = action.destination;
    if (kind === "requests") {
      let bookingLink: string | undefined;
      if (action.bookingLink?.trim()) {
        const link = checkBookingLink(action.bookingLink);
        if (!link.ok) return { ok: false, status: 422, error: link.error, field: "bookingLink" };
        bookingLink = link.url;
      }
      return {
        ok: true,
        location: { ...location, onboarding: { ...o, destination: { kind, ...(bookingLink ? { bookingLink } : {}), setAt: at } } },
      };
    }
    if (kind === "belline" && bellineDiaryOffered(location)) {
      return { ok: true, location: { ...location, onboarding: { ...o, destination: { kind, setAt: at } } } };
    }
    // Google, once its flag is on, can be chosen only with a working
    // connection: choosing it unconnected would promise bookings nobody makes.
    if (kind === "google" && flag("booking.google")) {
      if (googleUsable(location)) {
        return { ok: true, location: { ...location, onboarding: { ...o, destination: { kind, setAt: at } } } };
      }
      return {
        ok: false,
        status: 409,
        error: "Connect Google Calendar first, then choose it here.",
        fix: `/api/integrations/google?locationId=${encodeURIComponent(location.id)}&from=setup`,
      };
    }
    // Outlook and partner systems have no adapter yet, so choosing one would
    // promise bookings nobody makes. The owner can ask to be told.
    return {
      ok: false,
      status: 422,
      error: "That option is not ready yet. Start with booking requests; you can ask to be told when it is ready.",
    };
  }

  if (action.kind === "integration") {
    const id = action.integration.trim().toLowerCase();
    if (!(id in INTEGRATIONS)) return { ok: false, status: 422, error: "We do not know that booking system." };
    const requested = [...new Set([...(o.integrationRequests ?? []), id])];
    return { ok: true, location: { ...location, onboarding: { ...o, integrationRequests: requested } } };
  }

  if (action.kind === "rules") {
    if (!o.destination) {
      return { ok: false, status: 409, error: "Choose where bookings go first.", fix: stepUrl("bookings") };
    }
    const out = applyRules({ ...location, onboarding: o }, action.rules ?? {}, now);
    if (!out.ok) return { ok: false, status: 422, error: out.error, field: out.field };
    return { ok: true, location: out.location };
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

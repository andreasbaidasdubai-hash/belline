import type { Location, Subscription, User, Vertical, WeeklyHours } from "../types";
import {
  id,
  saveBusiness,
  saveTenant,
  upsertLocation,
  findUserByEmail,
  deleteUser,
  removeBusiness,
  removeLocation,
  removeTenant,
} from "../store";
import { createUser } from "../auth";
import { ensureBaseline } from "../brain";
import { checkShape } from "../leads/email";
import { extractFromSources, readSite, type Extracted, type ModelCall, type SourceFile } from "../prospect";
import { TRIAL, checkSelection } from "../billing/plans";
import { MARKETS, isMarket, marketDefaults, marketOf, type Market } from "../markets";
import { passwordProblem, tradeFromParam, tradeLabel, verticalForTrade } from "../signup-rules";
import { DPA_VERSION, TOS_VERSION } from "../legal";
import { todayIn } from "../time";
import { MENU_QUESTION, type Confirmed, type CurrentVenue } from "./review";
import { serviceLengthsRequired, takesRequestsOnly } from "../booking/destination";

/**
 * Getting a business live without a person in the loop.
 *
 * Belline's funnel used to end at a form that emailed somebody, who booked a
 * call, on which an engineer configured a venue by hand. For a product priced
 * at one receptionist-hour a month, that is four humans too many — and it is
 * the reason "Get Belline" was not an honest button.
 *
 * What replaces it is two things, and the second is the interesting one.
 *
 * **Signup** creates a tenant, a business, a venue and an owner in one step,
 * on a free trial with no card. Nothing here asks for money yet; the card is a
 * decision for the end of the fortnight, when the thing has already answered
 * some calls.
 *
 * **Setup is a conversation, not a form.** A salon owner does not want to type
 * their opening hours, their price list and eight FAQs into a web form — they
 * want to hand over their website and be asked about the bits it does not say.
 * So that is the shape: paste a URL, Belline reads it, shows you what it
 * understood, and asks only about the gaps.
 *
 * That reader already existed. It was built to make personalised sales demos —
 * paste a prospect's website, get a venue that sounds like them — and it turns
 * out that a sales demo and an onboarding wizard are the same machine pointed
 * at different people. The difference is what happens afterwards: a demo
 * expires and is never promoted, while this one is the customer's own venue
 * and they confirm every field before it answers a telephone.
 *
 * That confirmation step is not a formality. Everything the reader produces is
 * a model's impression of a public web page. It is good, and it is wrong often
 * enough that an unreviewed price or an invented stylist would reach a real
 * customer on a real call. So the draft is always shown, always editable, and
 * never live until a person has said yes.
 */

export interface SignupInput {
  businessName: string;
  email: string;
  password: string;
  /**
   * What they do, from the checkout's list (signup-rules.ts `TRADES`).
   *
   * Optional, because the question is: "Something else" and no answer at all
   * both arrive here as nothing, and both get the appointment diary. This is
   * never an engine: "garage" is a trade, and the engine it runs on is worked
   * out from the list.
   */
  trade?: string;
  /**
   * The engine, where the caller already knows it. Belle and the tests name
   * it directly; the checkout sends `trade` and lets it be worked out. Empty
   * is the same as not saying, and gets the appointment diary.
   */
  vertical?: Vertical | "";
  /**
   * The venue's clock. `signUp` ignores it and uses the market's, because a
   * browser's zone says where the owner is sitting, not where the business
   * is. Adding a location to an existing account (locations.ts) still sets it.
   */
  timezone?: string;
  /** What they picked on the checkout page, remembered as what the trial is trialling. */
  products?: unknown[];
  /** The country the business is in. Currency and timezone follow from it. Unset is the UAE. */
  market?: Market | string;
  /** The owner confirmed an email the typo check queried ("did you mean …?"). */
  emailConfirmed?: boolean;
  /** Ticked the Terms box. Recorded with the versions (legal.ts) when true. */
  acceptedTerms?: boolean;
}

export type SignupField = "businessName" | "email" | "password" | "vertical" | "market" | "terms";

export type SignupResult =
  | { ok: true; user: User; location: Location }
  | {
      ok: false;
      field: SignupField;
      error: string;
      /** A likely intended address, for a "Use …" button. */
      didYouMean?: string;
      /** Where to sign in instead, when the address already has an account. */
      signIn?: string;
    };

/** Injectable for the checks, so a failure half way through can be forced. */
export interface SignupDeps {
  ensureBaseline?: typeof ensureBaseline;
  createUser?: typeof createUser;
}

/**
 * A month, every channel on, no card, and a cap on voice minutes and
 * text conversations so an unattended trial cannot run up a bill
 * (billing/plans.ts `TRIAL`, which is the only place the length is set).
 */
function trialSubscription(timezone: string, picked?: unknown[], market?: unknown): Subscription {
  const today = todayIn(timezone);
  const ends = new Date(`${today}T12:00:00Z`);
  ends.setUTCDate(ends.getUTCDate() + TRIAL.days);
  const where = marketOf(market);
  const chosen = picked?.length ? checkSelection(picked, where) : null;
  return {
    // What they picked on the checkout page, or the bundle the trial is built
    // around. Every channel is on during the trial either way; the choice is
    // remembered so the end of the trial can offer it back. Choosing is a
    // decision for the end of the trial, not the start of it.
    products: chosen?.ok ? chosen.products : [...TRIAL.products],
    market: where,
    cycle: "monthly",
    startedOn: today,
    status: "trialing",
    trial: { endsOn: ends.toISOString().slice(0, 10), minutes: TRIAL.minutes, conversations: TRIAL.conversations },
  };
}

function everyDay(start: number, end: number): WeeklyHours {
  return Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, [{ start, end }]]));
}

/**
 * The venue a new customer starts with.
 *
 * Deliberately almost empty. It has hours, a greeting and nothing else,
 * because the alternative — seeding plausible services and a fictional
 * stylist — means a venue that looks configured and answers wrongly. An
 * obviously blank diary is a prompt to finish setting up; a confidently wrong
 * one is a support ticket.
 */
export function blankVenue(input: SignupInput, tenantId: string, businessId: string): Location {
  const defaults = marketDefaults(input.market);
  const timezone = input.timezone || defaults.timezone;
  const name = input.businessName.trim();
  // An empty answer is "Something else", not an engine: `||`, never `??`.
  const vertical = input.vertical || verticalForTrade(input.trade);
  const isRestaurant = vertical === "restaurant";
  const tradeKey = tradeFromParam(input.trade);

  return {
    id: id("loc"),
    tenantId,
    businessId,
    name,
    vertical,
    ...(tradeKey ? { tradeKey } : {}),
    timezone,
    businessPhone: "",
    address: "",
    // From the market, never guessed from the timezone: every Europe/* zone
    // used to get pounds, including a UAE business set up from Zurich.
    currency: defaults.currency,
    hours: everyDay(9 * 60, 18 * 60),
    closures: [],
    subscription: trialSubscription(timezone, input.products, input.market),
    // Not live, nothing reviewed: the journey starts at reading the business.
    onboarding: { version: 1, channels: {} },
    agent: {
      displayName: "Belline",
      greeting: `Thank you for calling ${name}, this is Belline. How can I help?`,
      voiceId: process.env.ELEVENLABS_VOICE_ID ?? "21m00Tcm4TlvDq8ikWAM",
      model: "claude-sonnet-5",
      persona:
        "Warm, brief and unhurried. You sound like the best person on their front desk on a good day.",
      policies: [],
      faqs: [],
      maxCallSeconds: 480,
      bookingHorizonDays: 60,
    },
    ...(isRestaurant
      ? {
          restaurant: {
            tables: [],
            services: [],
            maxCoversPerSlot: 12,
            slotMinutes: 15,
            maxPartySize: 8,
            largePartyPolicy:
              "For a party larger than eight, take their details and tell them the team will call back.",
          },
        }
      : {
          salon: { services: [], staff: [], resources: [], slotMinutes: 15 },
        }),
  };
}

/**
 * Create an account.
 *
 * Public and unauthenticated by design — that is the whole point of it. Which
 * also means every field is validated here rather than trusted, and the email
 * goes through the same checker the website's form uses, because a customer
 * who mistypes their address at signup never receives anything and never
 * knows why.
 *
 * All or nothing. Every check runs before the first write — the password
 * included, which used to be checked last, after a tenant, a business and a
 * venue had already been saved for an account nobody could sign in to. And if
 * a write itself fails part way, what was written is removed again before the
 * error goes any further.
 */
export async function signUp(input: SignupInput, deps: SignupDeps = {}): Promise<SignupResult> {
  const businessName = input.businessName.trim();
  if (businessName.length < 2) {
    return { ok: false, field: "businessName", error: "What is the business called?" };
  }
  if (businessName.length > 120) {
    return { ok: false, field: "businessName", error: "That name is too long." };
  }

  const email = input.email.trim().toLowerCase();
  const shape = checkShape(email);
  if (!shape.valid) {
    return {
      ok: false,
      field: "email",
      error: shape.suggestion
        ? `That does not look right. Did you mean ${shape.suggestion}?`
        : (shape.reason ?? "That does not look like an email address."),
      didYouMean: shape.suggestion,
    };
  }
  // A well-formed address one letter away from a big provider ("gmial.com")
  // is asked about once. It may be real, so "keep what I typed" is allowed.
  if (shape.suggestion && !input.emailConfirmed) {
    return {
      ok: false,
      field: "email",
      error: `Did you mean ${shape.suggestion}?`,
      didYouMean: shape.suggestion,
    };
  }
  if (findUserByEmail(email)) {
    return {
      ok: false,
      field: "email",
      error: "There is already an account with that address. Sign in instead.",
      signIn: `/login?email=${encodeURIComponent(email)}`,
    };
  }

  const problem = passwordProblem(input.password);
  if (problem) return { ok: false, field: "password", error: problem };

  // Only an explicit engine can be wrong. An absent one — and "Something
  // else", which arrives as "" — is a valid thing to be, and gets the
  // appointment diary. What the customer picked from the checkout's list
  // travels in `trade` and is never read as an engine, so "garage" is a
  // perfectly good trade and never a `vertical`.
  const stated = input.vertical || undefined;
  if (stated && !["restaurant", "salon", "clinic"].includes(stated)) {
    return { ok: false, field: "vertical", error: "Choose the kind of business, or leave it empty." };
  }
  const tradeKey = tradeFromParam(input.trade);
  const vertical: Vertical = stated ?? verticalForTrade(input.trade);

  // The market is where the business is, and it has to be one we can serve.
  if (input.market !== undefined && !(isMarket(input.market) && MARKETS[input.market].status === "live")) {
    return { ok: false, field: "market", error: "Belline is not open in that country yet." };
  }
  const where = marketDefaults(input.market);

  // A tenant of their own, from the first second. Nothing about this account
  // shares a boundary with anybody else's.
  const tenantId = id("tnt");
  const businessId = id("biz");
  const now = new Date().toISOString();
  const written: { user?: string; location?: string; business?: boolean; tenant?: boolean } = {};

  try {
    saveTenant({
      id: tenantId,
      name: businessName,
      status: "active",
      createdAt: now,
      ...(input.acceptedTerms
        ? { onboarding: { terms: { tosVersion: TOS_VERSION, dpaVersion: DPA_VERSION, acceptedAt: now, acceptedBy: email } } }
        : {}),
    });
    written.tenant = true;
    saveBusiness({
      id: businessId,
      tenantId,
      name: businessName,
      // Only when they said — the trade they picked, in their own words, so a
      // vet and a car garage are not both filed as "Salon & spa". An unnamed
      // trade is filled in from their website at the next step rather than
      // guessed here.
      category: tradeKey || stated ? tradeLabel(tradeKey, vertical) : undefined,
      email,
      // Never on by default. Appearing in a consumer search is a decision the
      // merchant makes, not one they discover.
      discoverable: false,
      createdAt: now,
    });
    written.business = true;

    const location = upsertLocation(
      blankVenue(
        { ...input, vertical, trade: tradeKey, market: where.market, timezone: where.timezone },
        tenantId,
        businessId,
      ),
    );
    written.location = location.id;
    (deps.ensureBaseline ?? ensureBaseline)(location);

    const created = (deps.createUser ?? createUser)({
      email,
      name: businessName,
      password: input.password,
      role: "owner",
      tenantId,
    });
    if (!created.ok) {
      // Only reachable in a race: somebody took the address between the check
      // above and here.
      rollback(tenantId, businessId, written);
      return { ok: false, field: "email", error: created.error };
    }
    written.user = created.user.id;

    return { ok: true, user: created.user, location };
  } catch (err) {
    rollback(tenantId, businessId, written);
    throw err;
  }
}

/** Undo a signup that failed part way, newest write first. */
function rollback(
  tenantId: string,
  businessId: string,
  written: { user?: string; location?: string; business?: boolean; tenant?: boolean },
): void {
  const steps: (() => void)[] = [
    () => written.user && deleteUser(written.user),
    () => written.location && removeLocation(written.location),
    () => written.business && removeBusiness(businessId),
    () => written.tenant && removeTenant(tenantId),
  ];
  for (const step of steps) {
    try {
      step();
    } catch (err) {
      // Keep undoing the rest. What is left is what scripts/orphans.ts lists.
      console.error(`[signup] rollback step failed for ${tenantId}:`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Setup, from a website
// ---------------------------------------------------------------------------

/**
 * What Belline understood, and what it still needs to ask.
 *
 * The gaps are the point. A form asks thirty questions because it has no idea
 * which ones it already knows the answer to; this asks four, because it read
 * the rest.
 */
export interface Draft {
  found: Extracted;
  /** The page that was read, or "" when the owner only handed over documents. */
  sourceUrl: string;
  /** How many documents were read alongside (or instead of) the page. */
  documents?: number;
  /** Fields the page did not answer, in the order worth asking about. */
  gaps: Gap[];
}

export interface Gap {
  field: "address" | "phone" | "hours" | "services" | "staff" | "policies";
  /** Asked the way a person would ask it, not the way a database would. */
  question: string;
  why: string;
}

/** What setup can be read from: a website, up to three documents, or both. */
export interface SetupSources {
  website?: string;
  files?: SourceFile[];
}

/** Injectable for the checks, so no test fetches a page or calls a model. */
export interface DraftDeps {
  model?: ModelCall;
  readSite?: typeof readSite;
}

export async function draftFromWebsite(rawUrl: string, deps: DraftDeps = {}): Promise<Draft> {
  return draftFromSources({ website: rawUrl }, deps);
}

/**
 * Read a business off its website and whatever documents the owner handed
 * over, in one model call, into one draft. The documents are read and
 * dropped: nothing here writes anything.
 */
export async function draftFromSources(sources: SetupSources, deps: DraftDeps = {}): Promise<Draft> {
  const website = sources.website?.trim();
  const files = sources.files ?? [];
  if (!website && !files.length) {
    throw new Error("Paste your website address, or add a price list or brochure.");
  }

  const site = website ? await (deps.readSite ?? readSite)(website) : undefined;
  const found = await extractFromSources({ site, files }, deps.model);
  const where = site
    ? files.length
      ? "your site or documents"
      : "your site"
    : files.length === 1
      ? "your document"
      : "your documents";

  const gaps: Gap[] = [];

  if (!found.address.trim()) {
    gaps.push({
      field: "address",
      question: "What is the address?",
      why: "Callers ask where you are, and ask about parking.",
    });
  }
  if (!found.services.length) {
    gaps.push({
      field: "services",
      question:
        found.vertical === "restaurant"
          ? "How long does a table usually turn, by party size?"
          : "What do you offer?",
      why: "A name is enough. Add how long each takes and what it costs if you like; with no price, Belline says your team will confirm it.",
    });
  } else if (found.services.some((s) => !s.price)) {
    gaps.push({
      field: "services",
      question: `A few of these have no price on ${where}. Add one, or leave it empty.`,
      why: "With no price, Belline tells the customer your team will confirm it. It never invents one.",
    });
  }
  if (found.vertical !== "restaurant" && !found.staff.length) {
    gaps.push({
      field: "staff",
      question: "Who works there, and who does what?",
      why: "So it only offers somebody who can actually do the treatment asked for.",
    });
  }
  gaps.push({
    field: "hours",
    question: "Are these your opening hours?",
    why: "Websites go stale here more than anywhere else.",
  });
  gaps.push({
    field: "policies",
    question: "Anything Belline must never do, or must always say?",
    why: "Deposits, cancellation, lateness — the rules your team already follow.",
  });

  return { found, sourceUrl: site?.url.href ?? "", documents: files.length, gaps };
}

/**
 * The note on the published version: where this setup came from. Says how
 * many documents, never which — their names are not kept.
 */
export function setupNote(website: string, documents = 0): string {
  let host = "";
  const raw = website.trim();
  if (raw) {
    try {
      host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname;
    } catch {
      host = raw.slice(0, 120);
    }
  }
  const count = Math.max(0, Math.min(3, Math.floor(Number(documents) || 0)));
  const docs = count ? `${count} ${count === 1 ? "document" : "documents"}` : "";
  if (host && docs) return `Set up from ${host} and ${docs}`;
  if (host || docs) return `Set up from ${host || docs}`;
  return "Set up by hand";
}

/**
 * Write a confirmed draft onto a venue.
 *
 * Takes only what was reviewed. Nothing reaches a live venue straight from the
 * reader — the caller of this function has shown a person every field and been
 * told yes, which is the difference between this and the sales demo the reader
 * was built for.
 */
export function applyDraft(location: Location, confirmed: Confirmed): Location {
  const hours = confirmed.hours ?? location.hours;
  let faqs = confirmed.faqs ?? location.agent.faqs;

  const next: Location = {
    ...location,
    name: confirmed.name?.trim() || location.name,
    // An empty string is a cleared field, not a missing one: the review form
    // always sends what is on screen.
    address: confirmed.address !== undefined ? confirmed.address.trim() : location.address,
    // The business's own phone. The Belline number is not on the review form.
    businessPhone: confirmed.phone !== undefined ? confirmed.phone.trim() : location.businessPhone,
    hours,
  };

  if (location.vertical === "restaurant") {
    // A menu is something to answer questions about, never something to book:
    // a table is booked, the lamb shoulder is not. So it is filed as one FAQ
    // the agent reads, replacing the last menu it was given.
    if (confirmed.services) {
      faqs = faqs.filter((f) => f.q !== MENU_QUESTION);
      const items = confirmed.services.filter((s) => s.name.trim());
      if (items.length) {
        const priced = (s: { name: string; price: number }) =>
          s.price > 0 ? `${s.name.trim()} (${location.currency} ${Math.round(s.price)})` : s.name.trim();
        faqs = [...faqs, { q: MENU_QUESTION, a: `${items.map(priced).join("; ")}.` }];
      }
    }
  } else if (confirmed.services || confirmed.staff) {
    const salon = location.salon ?? { services: [], staff: [], resources: [], slotMinutes: 15 };
    const taken = new Set<string>();
    const idFor = (prefix: string, name: string) => {
      const base = `${prefix}_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 24) || "item"}`;
      let candidate = base;
      for (let n = 2; taken.has(candidate); n++) candidate = `${base}_${n}`;
      taken.add(candidate);
      return candidate;
    };
    const match = <T extends { name: string }>(list: T[], name: string) =>
      list.find((x) => x.name.trim().toLowerCase() === name.trim().toLowerCase());

    // A service keeps its id when its name is unchanged, so bookings already
    // made against it still point at something.
    const services = confirmed.services
      ? confirmed.services.map((s) => {
          const was = match(salon.services, s.name);
          const id = was && !taken.has(was.id) ? was.id : idFor("svc", s.name);
          taken.add(id);
          return {
            ...(was ?? {}),
            id,
            name: s.name.trim(),
            // Never a made-up length: 0 is "not given", which a business
            // that confirms its own bookings never needs, and which the diary
            // refuses to offer a time for (booking/salon.ts).
            durationMin: Math.round(s.durationMin || 0) >= 5 ? Math.round(s.durationMin) : 0,
            // Held after the appointment and never quoted to the guest. Fifteen
            // minutes is the number every salon uses when asked, and it is editable.
            bufferMin: was?.bufferMin ?? 15,
            price: Math.max(0, Math.round(s.price || 0)),
          };
        })
      : salon.services;
    const serviceIds = services.map((s) => s.id);

    const staff = confirmed.staff
      ? confirmed.staff.map((name) => {
          const was = match(salon.staff, name);
          if (!was) {
            return {
              id: idFor("stf", name),
              name: name.trim(),
              // Everyone can do everything until somebody says otherwise. The opposite
              // default — nobody can do anything — produces a venue that can never
              // offer a slot, which reads as broken rather than as unfinished.
              serviceIds,
              hours,
              timeOff: [],
            };
          }
          taken.add(was.id);
          const kept = was.serviceIds.filter((sid) => serviceIds.includes(sid));
          return {
            ...was,
            serviceIds: kept.length ? kept : serviceIds,
            // Somebody on the venue's old hours follows the new ones; a person
            // with their own rota keeps it.
            hours: JSON.stringify(was.hours) === JSON.stringify(location.hours) ? hours : was.hours,
          };
        })
      : salon.staff.map((s) => ({
          ...s,
          serviceIds: s.serviceIds.filter((sid) => serviceIds.includes(sid)).length
            ? s.serviceIds.filter((sid) => serviceIds.includes(sid))
            : serviceIds,
        }));

    next.salon = { ...salon, services, staff };
  }

  next.agent = {
    ...location.agent,
    greeting: confirmed.greeting?.trim() || location.agent.greeting,
    faqs,
    policies: confirmed.policies ?? location.agent.policies,
  };

  return upsertLocation(next);
}

/** The venue as the review form starts from it (review.ts `CurrentVenue`). */
export function currentVenue(location: Location): CurrentVenue {
  return {
    name: location.name,
    vertical: location.vertical,
    greeting: location.agent.greeting,
    address: location.address,
    phone: location.businessPhone,
    hours: location.hours,
    services:
      location.vertical === "restaurant"
        ? []
        : (location.salon?.services ?? []).map((s) => ({ name: s.name, durationMin: s.durationMin, price: s.price ?? 0 })),
    staff: location.vertical === "restaurant" ? [] : (location.salon?.staff ?? []).map((s) => s.name),
    faqs: location.agent.faqs,
    policies: location.agent.policies,
  };
}

/** Is this venue ready to answer a telephone? */
export function readiness(location: Location): {
  ready: boolean;
  missing: { label: string; where: string }[];
} {
  const missing: { label: string; where: string }[] = [];

  if (!location.address.trim()) missing.push({ label: "An address", where: "/agents" });
  // A business that confirms its own bookings needs no tables, sittings,
  // services or rota in Belline: nothing is booked against them.
  if (takesRequestsOnly(location)) {
    // Only what every business needs, below.
  } else if (location.vertical === "restaurant") {
    if (!location.restaurant?.tables.length) {
      missing.push({ label: "Your tables", where: "/venue" });
    }
    if (!location.restaurant?.services.length) {
      missing.push({ label: "Service times", where: "/venue" });
    }
  } else {
    if (!location.salon?.services.length) {
      missing.push({ label: "What you offer", where: "/venue" });
    }
    if (!location.salon?.staff.length) {
      missing.push({ label: "Who works there", where: "/venue" });
    }
    // Set up before the diary was chosen, when lengths were not asked for.
    if (serviceLengthsRequired(location) && location.salon?.services.some((s) => !(s.durationMin > 0))) {
      missing.push({ label: "How long each service takes", where: "/setup/review" });
    }
  }
  if (!location.agent.faqs.length) {
    missing.push({ label: "A few common questions", where: "/agents" });
  }

  return { ready: missing.length === 0, missing };
}

import type { Location, Subscription, User, Vertical, WeeklyHours } from "../types";
import { id, saveBusiness, saveTenant, upsertLocation, findUserByEmail } from "../store";
import { createUser } from "../auth";
import { ensureBaseline } from "../brain";
import { checkShape } from "../leads/email";
import { extractBusiness, readSite, type Extracted } from "../prospect";
import { PLANS } from "../billing/plans";
import { todayIn } from "../time";

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
  /** What they do. Picks the engine: a table is not an appointment. */
  vertical: Vertical;
  /** Where they are, so "tomorrow at four" means their four. */
  timezone?: string;
}

export type SignupResult =
  | { ok: true; user: User; location: Location }
  | { ok: false; field: "businessName" | "email" | "password" | "vertical"; error: string };

/** Fourteen days, and a cap on minutes so an unattended trial cannot run up a bill. */
const TRIAL_DAYS = 14;
const TRIAL_MINUTES = 30;

function trialSubscription(timezone: string): Subscription {
  const today = todayIn(timezone);
  const ends = new Date(`${today}T12:00:00Z`);
  ends.setUTCDate(ends.getUTCDate() + TRIAL_DAYS);
  return {
    // The plan they are trialling is the one the website leads with. Choosing
    // a plan is a decision for the end of the trial, not the start of it.
    planId: PLANS[0].id,
    cycle: "monthly",
    startedOn: today,
    status: "trialing",
    trial: { endsOn: ends.toISOString().slice(0, 10), minutes: TRIAL_MINUTES },
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
function blankVenue(input: SignupInput, tenantId: string, businessId: string): Location {
  const timezone = input.timezone || "Asia/Dubai";
  const name = input.businessName.trim();
  const isRestaurant = input.vertical === "restaurant";

  return {
    id: id("loc"),
    tenantId,
    businessId,
    name,
    vertical: input.vertical,
    timezone,
    phone: "",
    address: "",
    currency: timezone.startsWith("Europe") ? "GBP" : "AED",
    hours: everyDay(9 * 60, 18 * 60),
    closures: [],
    subscription: trialSubscription(timezone),
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
 */
export async function signUp(input: SignupInput): Promise<SignupResult> {
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
    return { ok: false, field: "email", error: shape.reason ?? "That does not look like an email address." };
  }
  if (findUserByEmail(email)) {
    return {
      ok: false,
      field: "email",
      error: "There is already an account with that address. Sign in instead.",
    };
  }

  if (!["restaurant", "salon", "clinic"].includes(input.vertical)) {
    return { ok: false, field: "vertical", error: "Choose the kind of business." };
  }

  // A tenant of their own, from the first second. Nothing about this account
  // shares a boundary with anybody else's.
  const tenantId = id("tnt");
  const businessId = id("biz");
  const now = new Date().toISOString();

  saveTenant({ id: tenantId, name: businessName, status: "active", createdAt: now });
  saveBusiness({
    id: businessId,
    tenantId,
    name: businessName,
    category:
      input.vertical === "restaurant"
        ? "Restaurant"
        : input.vertical === "clinic"
          ? "Clinic"
          : "Salon & spa",
    email,
    // Never on by default. Appearing in a consumer search is a decision the
    // merchant makes, not one they discover.
    discoverable: false,
    createdAt: now,
  });

  const location = upsertLocation(blankVenue(input, tenantId, businessId));
  ensureBaseline(location);

  const created = createUser({
    email,
    name: businessName,
    password: input.password,
    role: "owner",
    tenantId,
  });
  if (!created.ok) {
    return { ok: false, field: "password", error: created.error };
  }

  return { ok: true, user: created.user, location };
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
  sourceUrl: string;
  /** Fields the page did not answer, in the order worth asking about. */
  gaps: Gap[];
}

export interface Gap {
  field: "address" | "phone" | "hours" | "services" | "staff" | "policies";
  /** Asked the way a person would ask it, not the way a database would. */
  question: string;
  why: string;
}

export async function draftFromWebsite(rawUrl: string): Promise<Draft> {
  const { url, text } = await readSite(rawUrl);
  const found = await extractBusiness(text, url);

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
          : "What do you offer, roughly how long does each take, and what does it cost?",
      why: "Belline will not offer a time it cannot honour, so it needs the lengths.",
    });
  } else if (found.services.some((s) => !s.price)) {
    gaps.push({
      field: "services",
      question: "A few of these have no price on your site. What should Belline say?",
      why: "It will never invent one — it will say it does not know, which sounds worse.",
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

  return { found, sourceUrl: url.href, gaps };
}

/**
 * Write a confirmed draft onto a venue.
 *
 * Takes only what was reviewed. Nothing reaches a live venue straight from the
 * reader — the caller of this function has shown a person every field and been
 * told yes, which is the difference between this and the sales demo the reader
 * was built for.
 */
export function applyDraft(
  location: Location,
  confirmed: {
    name?: string;
    address?: string;
    phone?: string;
    greeting?: string;
    hours?: WeeklyHours;
    services?: { name: string; durationMin: number; price: number }[];
    staff?: string[];
    faqs?: { q: string; a: string }[];
    policies?: string[];
  },
): Location {
  const next: Location = {
    ...location,
    name: confirmed.name?.trim() || location.name,
    address: confirmed.address?.trim() || location.address,
    phone: confirmed.phone?.trim() || location.phone,
    hours: confirmed.hours ?? location.hours,
    agent: {
      ...location.agent,
      greeting: confirmed.greeting?.trim() || location.agent.greeting,
      faqs: confirmed.faqs ?? location.agent.faqs,
      policies: confirmed.policies ?? location.agent.policies,
    },
  };

  if (confirmed.services && location.vertical !== "restaurant") {
    const services = confirmed.services.map((s, i) => ({
      id: `svc${i + 1}`,
      name: s.name,
      durationMin: Math.max(5, Math.round(s.durationMin || 30)),
      // Held after the appointment and never quoted to the guest. Fifteen
      // minutes is the number every salon uses when asked, and it is editable.
      bufferMin: 15,
      price: Math.max(0, Math.round(s.price || 0)),
    }));
    const staff = (confirmed.staff ?? []).map((name, i) => ({
      id: `stf${i + 1}`,
      name,
      // Everyone can do everything until somebody says otherwise. The opposite
      // default — nobody can do anything — produces a venue that can never
      // offer a slot, which reads as broken rather than as unfinished.
      serviceIds: services.map((s) => s.id),
      hours: next.hours,
      timeOff: [],
    }));
    next.salon = { ...(location.salon ?? { resources: [], slotMinutes: 15 }), services, staff };
  }

  return upsertLocation(next);
}

/** Is this venue ready to answer a telephone? */
export function readiness(location: Location): {
  ready: boolean;
  missing: { label: string; where: string }[];
} {
  const missing: { label: string; where: string }[] = [];

  if (!location.address.trim()) missing.push({ label: "An address", where: "/agents" });
  if (location.vertical === "restaurant") {
    if (!location.restaurant?.tables.length) {
      missing.push({ label: "Your tables", where: "/agents" });
    }
    if (!location.restaurant?.services.length) {
      missing.push({ label: "Service times", where: "/agents" });
    }
  } else {
    if (!location.salon?.services.length) {
      missing.push({ label: "What you offer", where: "/agents" });
    }
    if (!location.salon?.staff.length) {
      missing.push({ label: "Who works there", where: "/agents" });
    }
  }
  if (!location.agent.faqs.length) {
    missing.push({ label: "A few common questions", where: "/agents" });
  }

  return { ready: missing.length === 0, missing };
}

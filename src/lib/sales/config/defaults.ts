import type { FlagName } from "../../flags";
import type { Channel, Compliance, PartialAgentConfig, SendWindow } from "./schema";

/**
 * Seed configuration.
 *
 * Everything here is data, not code — it is written to the database once by
 * `npm run sales:seed` and edited from the dashboard afterwards. It exists in
 * a file so that a fresh database is useful immediately and so that the
 * compliance defaults are reviewable in a diff, which is where a lawyer's
 * comments should land.
 */

/**
 * The base every inheritance chain starts from. Deliberately conservative:
 * an agent created with an empty config inherits a review-mode, email-only,
 * consent-requiring posture rather than a permissive one. Getting this wrong
 * in the safe direction costs a config edit; the other direction costs a
 * regulator's letter.
 */
export const DEFAULT_CONFIG: PartialAgentConfig = {
  discovery: { search_terms: [], max_results_per_run: 50, sources: ["csv"] },
  regions: [],
  languages: ["en"],
  default_language: "en",
  ideal_customer_profile: { must: {}, prefer: {}, exclude: {} },
  belline_services: [],
  qualification_rules: {
    min_score_to_contact: 55,
    require_contactable: ["email"],
    require_evidence_for_claims: true,
  },
  research_prompt: "",
  scoring: {
    weights: {},
    penalties: {},
    bands: { hot: 75, warm: 55 },
  },
  outreach_strategy: {
    channels: ["email"],
    sequence: "default-v1",
    tone: "professional, direct, specific",
    cta: "reply_question",
    max_words_first_touch: 90,
    send_window: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00", tz: "UTC" },
    daily_send_cap: 25,
  },
  compliance: {
    email_requires_prior_consent: false,
    prefer_company_level_contact: false,
    person_level_requires_review: false,
    phone_requires_dnc_screen: false,
    max_sequence_steps: 4,
    min_days_between_touches: 2,
    company_touch_cap_90d: 6,
    holidays: [],
  },
  budget: { daily_usd: 5, monthly_usd: 100 },
};

// ---------------------------------------------------------------------------
// Countries
// ---------------------------------------------------------------------------

export interface CountrySeed {
  code: string;
  name: string;
  default_languages: string[];
  default_timezone: string;
  currency: string;
  compliance_profile: Compliance;
  regions: string[];
  /** Channels a vertical agent in this country may draw from. Intersected down. */
  channels: Channel[];
  send_window: SendWindow;
}

export const COUNTRIES: CountrySeed[] = [
  {
    code: "AE",
    name: "United Arab Emirates",
    default_languages: ["en", "ar"],
    default_timezone: "Asia/Dubai",
    currency: "AED",
    // PDPL (Federal Decree-Law 45/2021) plus TDRA rules on unsolicited
    // electronic communication. Free-zone entities (DIFC, ADGM) fall under
    // stricter GDPR-like regimes — see COMPLIANCE.md §1.
    compliance_profile: {
      email_requires_prior_consent: false,
      prefer_company_level_contact: false,
      person_level_requires_review: false,
      phone_requires_dnc_screen: true,
      max_sequence_steps: 4,
      min_days_between_touches: 2,
      company_touch_cap_90d: 6,
      holidays: [],
    },
    regions: ["Dubai", "Abu Dhabi", "Sharjah", "Ajman", "Ras Al Khaimah"],
    channels: ["email", "linkedin", "phone"],
    // The Gulf working week is Monday–Friday, with Friday a short day.
    send_window: { days: [1, 2, 3, 4, 5], start: "08:30", end: "17:00", tz: "Asia/Dubai" },
  },
  {
    code: "SA",
    name: "Saudi Arabia",
    default_languages: ["ar", "en"],
    default_timezone: "Asia/Riyadh",
    currency: "SAR",
    // PDPL (M/19 of 2021, amended 2023), SDAIA-enforced and consent-forward.
    // Target the company, not the person.
    compliance_profile: {
      email_requires_prior_consent: false,
      prefer_company_level_contact: true,
      person_level_requires_review: true,
      phone_requires_dnc_screen: true,
      max_sequence_steps: 3,
      min_days_between_touches: 3,
      company_touch_cap_90d: 4,
      holidays: [],
    },
    regions: ["Riyadh", "Jeddah", "Dammam", "Khobar", "Mecca", "Medina"],
    channels: ["email", "linkedin", "phone"],
    send_window: { days: [0, 1, 2, 3, 4], start: "09:00", end: "17:00", tz: "Asia/Riyadh" },
  },
  {
    code: "CH",
    name: "Switzerland",
    default_languages: ["de", "fr", "en"],
    default_timezone: "Europe/Zurich",
    currency: "CHF",
    // The strictest of the three. UWG Art. 3(1)(o) requires prior consent for
    // mass advertising by telecommunications, prosecutable on complaint; the
    // revised FADP governs the personal data. Email is therefore consent-gated
    // and the practical channels are LinkedIn and (star-screened) phone.
    compliance_profile: {
      email_requires_prior_consent: true,
      prefer_company_level_contact: true,
      person_level_requires_review: true,
      phone_requires_dnc_screen: true,
      max_sequence_steps: 2,
      min_days_between_touches: 4,
      company_touch_cap_90d: 3,
      holidays: [],
    },
    regions: ["Zürich", "Genève", "Basel", "Bern", "Lausanne", "Zug", "Lugano"],
    channels: ["linkedin", "email", "phone"],
    send_window: { days: [1, 2, 3, 4, 5], start: "08:00", end: "17:00", tz: "Europe/Zurich" },
  },
];

// ---------------------------------------------------------------------------
// Verticals
// ---------------------------------------------------------------------------

export interface VerticalSeed {
  slug: string;
  name: string;
  parent_slug?: string;
  /**
   * What to type into a lead source to find these businesses.
   *
   * Several terms per vertical because one never covers a market: a Dubai
   * practice lists itself as a "dental clinic", a "dental centre" or a
   * "dentist" more or less at random, and each term returns a different
   * twenty results. The connector dedupes on place_id across them.
   */
  searchTerms: string[];
  /** Mirrors src/lib/verticals.ts so outreach copy uses the trade's own words. */
  terms: { customer: string; customers: string; staff: string; booking: string; venue: string };
  default_icp: PartialAgentConfig["ideal_customer_profile"];
}

export const VERTICALS: VerticalSeed[] = [
  {
    slug: "dentists",
    name: "Dental practices",
    searchTerms: ["dental clinic", "dentist", "dental centre", "orthodontist"],
    terms: {
      customer: "patient",
      customers: "patients",
      staff: "dentist",
      booking: "appointment",
      venue: "practice",
    },
    default_icp: {
      must: { has_phone: true, appointment_based: true },
      prefer: { review_count_min: 40, rating_min: 3.8, practitioner_count_min: 3 },
      exclude: { solo_operation: true, chains_above: 40 },
    },
  },
  {
    slug: "clinics",
    name: "Medical clinics",
    searchTerms: ["medical clinic", "polyclinic", "aesthetic clinic", "dermatology clinic"],
    terms: {
      customer: "patient",
      customers: "patients",
      staff: "practitioner",
      booking: "appointment",
      venue: "clinic",
    },
    default_icp: {
      must: { has_phone: true, appointment_based: true },
      prefer: { review_count_min: 50, rating_min: 3.8, practitioner_count_min: 4 },
      exclude: { solo_operation: true, chains_above: 40 },
    },
  },
  {
    slug: "salons",
    name: "Salons and spas",
    searchTerms: ["hair salon", "beauty salon", "spa", "nail salon"],
    terms: {
      customer: "client",
      customers: "clients",
      staff: "stylist",
      booking: "appointment",
      venue: "salon",
    },
    default_icp: {
      must: { has_phone: true, appointment_based: true },
      prefer: { review_count_min: 60, rating_min: 4.0, practitioner_count_min: 4 },
      exclude: { solo_operation: true },
    },
  },
  {
    slug: "restaurants",
    name: "Restaurants",
    searchTerms: ["restaurant", "fine dining restaurant", "bistro"],
    terms: {
      customer: "guest",
      customers: "guests",
      staff: "host",
      booking: "reservation",
      venue: "restaurant",
    },
    default_icp: {
      must: { has_phone: true },
      prefer: { review_count_min: 150, rating_min: 4.0 },
      exclude: { chains_above: 60 },
    },
  },
  {
    /**
     * Everything else.
     *
     * The four above are where the pilot is, not the limit of who this sells
     * to: answering the phone and taking a booking request is the same job at
     * a garage, a physiotherapist, a tutor or a letting agent. Without a row
     * here, an agent pointed at any other trade got no vocabulary at all, and
     * the wrong-word guard ran against an empty list and checked nothing.
     */
    slug: "businesses",
    name: "Other businesses",
    searchTerms: ["appointments", "bookings", "services"],
    terms: {
      customer: "customer",
      customers: "customers",
      staff: "the team",
      booking: "appointment",
      venue: "business",
    },
    default_icp: {
      must: { has_phone: true },
      prefer: { review_count_min: 40, rating_min: 3.8 },
      exclude: {},
    },
  },
];

/** The row any business outside the named trades falls back to. */
export const GENERIC_VERTICAL = "businesses";

/**
 * What a trade calls its customers, and what it must never call them.
 *
 * This was a hardcoded map of four slugs with `forbidden: []` as its fallback,
 * so for any other trade the vocabulary guard — the one that stops a clinic
 * being told about its "guests" — ran and checked nothing while looking like
 * it worked. An inert guard is worse than an absent one.
 *
 * Derived from the registry instead, which keeps the list non-empty for every
 * business type including the generic one: "customer" is right for a garage
 * and wrong for a dentist, and both of those directions matter.
 */
export function vocabularyFor(slug: string | null | undefined): {
  word: string;
  forbidden: string[];
} {
  const row =
    VERTICALS.find((v) => v.slug === slug) ??
    VERTICALS.find((v) => v.slug === GENERIC_VERTICAL)!;
  const word = row.terms.customer;
  const forbidden = [...new Set(VERTICALS.map((v) => v.terms.customer))]
    .filter((other) => other !== word)
    .sort();
  return { word, forbidden };
}

// ---------------------------------------------------------------------------
// What Belline sells
// ---------------------------------------------------------------------------

/**
 * `proof` is the only place an outreach message may take a capability claim
 * from. If a claim is not in here with a source, no agent may make it — the
 * pre-send guard checks this. Sources are internal references for now; replace
 * them with customer-verifiable evidence as it exists, and delete any claim
 * that cannot be backed.
 *
 * What this used to sell was Belline's own diary: checking real availability,
 * booking, moving and cancelling, respecting table combinations and kitchen
 * pacing. That is not the product any more. Belline works with whatever the
 * business already books with — it answers, captures the request, hands over
 * their booking link, takes a message and escalates — so those are the claims,
 * and booking into a calendar is a claim that unlocks with its flag and not
 * before.
 */
export interface ServiceSeed {
  slug: string;
  name: string;
  description: string;
  verticals: string[];
  /**
   * Citable only while this flag is on.
   *
   * Absent means always citable. A flagged service is still listed, seeded and
   * visible — it simply may not be sold until the thing it describes exists.
   */
  flag?: FlagName;
  proof: { claim: string; source: string }[];
}

export const SERVICES: ServiceSeed[] = [
  {
    slug: "missed_call_recovery",
    name: "Missed call recovery",
    description: "Answers the calls that currently ring out, so the booking is not lost.",
    verticals: [],
    proof: [
      {
        claim: "Answers calls that would otherwise go unanswered, at any hour.",
        source: "product",
      },
    ],
  },
  {
    slug: "after_hours_answering",
    name: "After-hours answering",
    description: "Takes calls outside opening hours and books into the same diary.",
    verticals: [],
    proof: [{ claim: "Available 24/7, including outside opening hours.", source: "product" }],
  },
  {
    slug: "booking_requests",
    name: "Booking requests",
    description:
      "Takes the request — who, what, when, and a number to call back — and hands it to the team.",
    verticals: [],
    proof: [
      {
        claim: "Takes a booking request and passes it to the team to confirm.",
        source: "product",
      },
    ],
  },
  {
    slug: "booking_link",
    name: "Their own booking link",
    description:
      "Sends the business's own booking link to the caller, where that is how they take bookings.",
    verticals: [],
    proof: [{ claim: "Hands over the business's own booking link.", source: "product" }],
  },
  {
    slug: "message_taking",
    name: "Message taking",
    description: "Takes a message and makes sure the team sees it.",
    verticals: [],
    proof: [{ claim: "Takes a message for the team.", source: "product" }],
  },
  {
    slug: "escalation",
    name: "Escalation",
    description:
      "Puts the urgent ones through to a person, or flags them for someone to pick up.",
    verticals: [],
    proof: [
      {
        claim: "Transfers the caller to the team's own number when it matters.",
        source: "src/lib/agent/tools.ts transfer_call",
      },
    ],
  },
  {
    slug: "calendar_booking",
    name: "Booking into their calendar",
    description: "Reads the business's own calendar and books into it.",
    verticals: [],
    // Not sellable until the integration is verified. See src/lib/flags.ts:
    // Google issues credentials for scopes it has not approved you for, so
    // nothing in the environment can turn this on by itself.
    flag: "booking.google",
    proof: [
      {
        claim: "Checks the business's own calendar for free time before offering it.",
        source: "pending Google verification",
      },
    ],
  },
  {
    slug: "faq_handling",
    name: "FAQ handling",
    description: "Answers the questions the front desk answers forty times a day.",
    verticals: [],
    proof: [{ claim: "Answers common questions from the venue's own information.", source: "product" }],
  },
  {
    slug: "multilingual_support",
    name: "Multilingual answering",
    description: "Handles callers in more than one language on the same number.",
    verticals: [],
    // Deliberately narrow. The README is explicit that the prompt and speech
    // configuration are English-only today and that Gulf Arabic and Swiss
    // German need testing against real callers. Until that testing exists, no
    // agent may promise them.
    proof: [
      {
        claim: "Language is configured per location.",
        source: "src/lib/types.ts AgentConfig",
      },
    ],
  },
  {
    slug: "call_overflow",
    name: "Call overflow",
    description: "Picks up when the existing team is already on the phone.",
    verticals: [],
    proof: [{ claim: "Handles concurrent calls without a queue.", source: "product" }],
  },
  {
    slug: "lead_qualification",
    name: "Lead qualification",
    description: "Asks the qualifying questions before a human ever picks up.",
    verticals: [],
    proof: [{ claim: "Collects caller details and intent before escalating.", source: "product" }],
  },
];

// ---------------------------------------------------------------------------
// Sequences
// ---------------------------------------------------------------------------

export const SEQUENCES = [
  {
    key: "default-v1",
    name: "Default four-step",
    scope: {},
    steps: [
      { day: 1, channel: "email", purpose: "Personalised first contact" },
      { day: 3, channel: "email", purpose: "One concrete use case for their situation" },
      { day: 7, channel: "email", purpose: "Offer the live demo — call it yourself" },
      { day: 14, channel: "email", purpose: "Short, polite close-out" },
    ],
  },
  {
    key: "gulf-dental-v1",
    name: "Gulf dental — four step",
    scope: { vertical: "dentists", country: "AE" },
    steps: [
      { day: 1, channel: "email", purpose: "Personalised first contact" },
      { day: 3, channel: "email", purpose: "Missed-call cost, specific to their practice" },
      { day: 7, channel: "email", purpose: "Offer the live demo — call it yourself" },
      { day: 14, channel: "email", purpose: "Short, polite close-out" },
    ],
  },
  {
    key: "swiss-consent-v1",
    name: "Switzerland — two step, consent-gated",
    scope: { country: "CH" },
    // Two steps, not four: UWG Art. 3(1)(o) makes a long unsolicited sequence
    // materially harder to defend than a single approach.
    steps: [
      { day: 1, channel: "linkedin", purpose: "Connection with a specific observation" },
      { day: 5, channel: "email", purpose: "One follow-up, only where a basis is recorded" },
    ],
  },
];

// ---------------------------------------------------------------------------
// The first agent
// ---------------------------------------------------------------------------

/**
 * UAE Dental: legally the most straightforward of the three countries,
 * English-first so nothing waits on translation, phone-first booking culture so
 * the Belline pitch is at its strongest, and dense enough in Dubai to fill a
 * pipeline from one city.
 */
export const FIRST_AGENT_CONFIG: PartialAgentConfig = {
  discovery: {
    search_terms: ["dental clinic", "dentist", "dental centre"],
    // Deliberately small. The first runs are for reading the output by hand,
    // not for filling a pipeline — and every result costs money.
    max_results_per_run: 50,
    sources: ["google_places", "csv"],
  },
  regions: ["Dubai", "Abu Dhabi"],
  languages: ["en", "ar"],
  default_language: "en",
  ideal_customer_profile: {
    must: { has_phone: true, appointment_based: true },
    prefer: {
      location_count_min: 2,
      review_count_min: 40,
      rating_min: 3.8,
      practitioner_count_min: 3,
    },
    exclude: { solo_operation: true, chains_above: 40, keywords_in_name: ["mobile", "home visit"] },
  },
  belline_services: [
    "missed_call_recovery",
    "after_hours_answering",
    "booking_requests",
    "booking_link",
    "message_taking",
    "escalation",
    "faq_handling",
    // Not multilingual_support: offered to the model as a service, it became
    // "answers in English or Arabic" in a real draft. Belline is English-only.
    // Not calendar_booking: flag-gated, and the flag is off — citing it would
    // be selling an integration nobody has verified.
  ],
  qualification_rules: {
    min_score_to_contact: 55,
    require_contactable: ["email", "phone"],
    require_evidence_for_claims: true,
  },
  research_prompt:
    "Focus on how patients currently book — phone, WhatsApp, or an online system — and name the " +
    "system if the page shows one. Note whether the practice runs more than one branch, how many " +
    "dentists are listed, whether it opens on weekends or late, and whether any reviews mention " +
    "unanswered calls, hold times or difficulty booking. Note the languages the practice advertises.",
  scoring: {
    weights: {
      // Two location signals on purpose. `multi_location` asks the yes/no
      // question; `location_count` grades it, so a thirteen-branch group
      // outranks a two-branch one instead of tying with it. Without the
      // second, the largest prospects in the market are invisible.
      multi_location: 15,
      location_count: 10,
      review_volume: 12,
      long_hours: 10,
      weekend_open: 6,
      appointment_based: 12,
      high_ticket: 8,
      practitioner_count: 8,
      phone_first: 15,
      whatsapp_booking: 6,
      review_complaints_about_calls: 12,
      after_hours_gap: 10,
      premium_positioning: 6,
      recent_expansion: 8,
      demo_used: 20,
    },
    penalties: {
      permanently_closed: -100,
      solo_operation: -25,
      no_phone: -40,
      no_appointments: -30,
      outside_region: -50,
      wrong_vertical: -60,
    },
    bands: { hot: 75, warm: 55 },
  },
  outreach_strategy: {
    channels: ["email"],
    sequence: "gulf-dental-v1",
    tone: "polished, premium, direct; no US-style hype, no exclamation marks",
    cta: "demo_call",
    max_words_first_touch: 90,
    send_window: { days: [1, 2, 3, 4, 5], start: "08:30", end: "17:00", tz: "Asia/Dubai" },
    daily_send_cap: 40,
  },
  budget: { daily_usd: 12, monthly_usd: 250 },
};

/** COMPLIANCE.md §5 — activation is refused until every item is true. */
export const LAUNCH_CHECKLIST: Record<string, boolean> = {
  compliance_profile_reviewed: false,
  sending_domain_authenticated: false,
  sending_domain_warmed: false,
  suppression_list_imported: false,
  opt_out_tested: false,
  service_proof_populated: false,
  send_window_and_holidays_set: false,
  budget_caps_verified: false,
  dry_run_reviewed: false,
};

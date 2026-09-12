import type { AgentConfig, Location, StaffMember, WeeklyHours } from "./types";
import { isEmpty, listLocations, replaceAll, upsertLocation } from "./store";
import { ensureBaseline } from "./brain";
import { bellineVenue } from "./seed-belline";
import { DEFAULT_TENANT_ID, businessIdForLocation, ensureTenancy } from "./tenancy";

const H = (h: number, m = 0) => h * 60 + m;

function everyDay(start: number, end: number): WeeklyHours {
  return Object.fromEntries(
    [0, 1, 2, 3, 4, 5, 6].map((d) => [d, [{ start, end }]]),
  );
}

function weekdaysOnly(
  days: number[],
  start: number,
  end: number,
): WeeklyHours {
  return Object.fromEntries(
    [0, 1, 2, 3, 4, 5, 6].map((d) => [d, days.includes(d) ? [{ start, end }] : []]),
  );
}

// ---------------------------------------------------------------------------
// Demo tenant 1 — restaurant
// ---------------------------------------------------------------------------

const restaurant: Location = {
  id: "loc_azure",
  tenantId: DEFAULT_TENANT_ID,
  businessId: businessIdForLocation("loc_azure"),
  name: "Azure Table",
  vertical: "restaurant",
  timezone: "Asia/Dubai",
  phone: "+971 4 555 0142",
  address: "Marina Walk, Dubai Marina",
  currency: "AED",
  // A plan, so the billing page has something real to show in a demo. The
  // anniversary is the 1st, which keeps the worked example legible; the
  // period arithmetic is exercised properly against the awkward dates in
  // scripts/check-billing.ts rather than here.
  subscription: { planId: "business", cycle: "monthly", startedOn: "2026-09-01", status: "active" },
  hours: everyDay(H(12), H(23, 30)),
  closures: [],
  agent: {
    displayName: "Sofia",
    greeting:
      "Good evening, Azure Table, this is Sofia. How can I help you?",
    returningGreeting:
      "Good evening, Azure Table, this is Sofia. Lovely to hear from you again, {name} — what can I do for you?",
    voiceId: process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM",
    // Haiku by default: measured at ~1.3s to the first spoken word against
    // ~2.8s for Opus, and a caller reads three seconds of silence as a dead
    // line. Switch a venue to Opus on the Agent page when its policies are
    // intricate enough to be worth the wait.
    model: "claude-haiku-4-5",
    persona:
      "Warm, efficient, and unhurried. You sound like a senior host who has worked the floor for years — never rushed, never robotic, never over-apologetic.",
    policies: [
      "Never promise a specific table number or the terrace — say you will note the request and the team will do their best.",
      "Parties of 9 or more are events, not reservations: take a name and number and tell the caller the events manager will call back within the day.",
      "Do not quote menu prices beyond the set menus listed below; offer to text the menu link instead.",
      "If a caller asks about a food allergy, take the detail into the notes and say the kitchen will be briefed — never confirm a dish is safe yourself.",
    ],
    faqs: [
      {
        q: "Where are you and is there parking?",
        a: "Marina Walk, ground floor of the promenade. Valet at the entrance, 30 dirhams, and there is paid public parking in the Marina Mall structure two minutes away.",
      },
      {
        q: "What is the dress code?",
        a: "Smart casual. No beachwear or sports shorts in the evening.",
      },
      {
        q: "Do you have vegan and gluten-free options?",
        a: "Yes, there is a full vegan section on the menu and most dishes can be made gluten-free — mention it when booking and the kitchen will be ready.",
      },
      {
        q: "Is there a set menu?",
        a: "Yes — a three-course business lunch at 145 dirhams on weekdays, and a five-course tasting menu at 395 dirhams in the evening.",
      },
      {
        q: "Are children welcome?",
        a: "Absolutely, we have high chairs and a children's menu.",
      },
    ],
    transferNumber: "+971 4 555 0100",
    maxCallSeconds: 420,
    bookingHorizonDays: 90,
  },
  // Twenty minutes' notice, so the host sees a booking coming rather than
  // hearing the door; four hours to cancel without a conversation; and a
  // deposit on the parties that hurt when they do not turn up. All three are
  // things this restaurant would say on the phone anyway — the point of
  // putting them here is that the agent now says them at the right moment,
  // and cannot quietly break them.
  policy: {
    minNoticeMin: 20,
    cancellationWindowHours: 4,
    deposit: {
      amount: 100,
      per: "person",
      minPartySize: 6,
      wording:
        "For a table of six or more we take a hundred dirhams a head as a deposit, taken off the bill on the night. The team will send a link.",
    },
  },
  restaurant: {
    slotMinutes: 15,
    maxCoversPerSlot: 14,
    // A manager who can see two tables putting their coats on may seat four
    // more. The agent never can - pacing is what keeps the pass alive.
    overbookPerSlot: 4,
    maxPartySize: 8,
    // Ten minutes to clear, wipe and re-lay. Without it the book promises
    // 21:30 on a table whose 20:00 sitting is still finding its coats.
    resetMinutes: 10,
    maxCombine: 3,
    largePartyPolicy:
      "Parties of nine or more are handled by the events manager, who will call back the same day.",
    sections: [
      // Fill the room before the terrace: an empty dining room reads as a bad
      // restaurant, and the terrace sells itself once the sun is down.
      { id: "Main", priority: 2 },
      {
        id: "Terrace",
        priority: 1,
        // The terrace has its own pass and a smaller one. Twelve covers a slot
        // out there is a service; sixteen is an apology.
        maxCoversPerSlot: 8,
      },
      {
        id: "Counter",
        // Six seats at the pass, sold as an experience rather than seated as a
        // table. The agent takes the enquiry; a person takes the booking.
        online: false,
        priority: 0,
      },
    ],
    tables: [
      { id: "t1", name: "1", minSeats: 1, maxSeats: 2, section: "Main" },
      { id: "t2", name: "2", minSeats: 1, maxSeats: 2, section: "Main" },
      { id: "t3", name: "3", minSeats: 2, maxSeats: 2, section: "Main" },
      { id: "t4", name: "4", minSeats: 2, maxSeats: 4, section: "Main" },
      { id: "t5", name: "5", minSeats: 2, maxSeats: 4, section: "Main" },
      { id: "t6", name: "6", minSeats: 3, maxSeats: 4, section: "Main" },
      { id: "t7", name: "7", minSeats: 4, maxSeats: 6, section: "Main" },
      { id: "t8", name: "8", minSeats: 5, maxSeats: 8, section: "Main" },
      // The two window two-tops push together and nothing else out there does
      // — 22 is against a planter and 23 is round.
      { id: "t20", name: "20", minSeats: 2, maxSeats: 2, section: "Terrace", combinesWith: ["t21"] },
      { id: "t21", name: "21", minSeats: 2, maxSeats: 2, section: "Terrace", combinesWith: ["t20"] },
      { id: "t22", name: "22", minSeats: 2, maxSeats: 4, section: "Terrace", combinesWith: [] },
      { id: "t23", name: "23", minSeats: 4, maxSeats: 6, section: "Terrace", combinesWith: [] },
      { id: "c1", name: "Counter", minSeats: 1, maxSeats: 6, section: "Counter" },
    ],
    services: [
      {
        id: "lunch",
        name: "lunch",
        days: [0, 1, 2, 3, 4],
        start: H(12),
        end: H(16),
        lastSeating: H(14, 45),
        turnTimes: [
          { upTo: 2, minutes: 75 },
          { upTo: 4, minutes: 90 },
          { upTo: 8, minutes: 105 },
        ],
      },
      {
        id: "dinner",
        name: "dinner",
        days: [0, 1, 2, 3, 4, 5, 6],
        start: H(18),
        end: H(23, 30),
        lastSeating: H(22, 15),
        turnTimes: [
          { upTo: 2, minutes: 90 },
          { upTo: 4, minutes: 105 },
          { upTo: 6, minutes: 120 },
          { upTo: 8, minutes: 135 },
        ],
      },
      {
        id: "brunch",
        name: "weekend brunch",
        days: [5, 6],
        start: H(12, 30),
        end: H(16, 30),
        lastSeating: H(15),
        turnTimes: [
          { upTo: 4, minutes: 120 },
          { upTo: 8, minutes: 150 },
        ],
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Demo tenant 2 — salon
// ---------------------------------------------------------------------------

const salonHours = weekdaysOnly([1, 2, 3, 4, 5, 6], H(9), H(19));

const stylist = (
  id: string,
  name: string,
  serviceIds: string[],
  days: number[],
  start = H(9),
  end = H(18),
): StaffMember => ({
  id,
  name,
  serviceIds,
  hours: weekdaysOnly(days, start, end),
  timeOff: [],
});

const salon: Location = {
  id: "loc_lumiere",
  tenantId: DEFAULT_TENANT_ID,
  businessId: businessIdForLocation("loc_lumiere"),
  name: "Lumière Hair & Beauty",
  vertical: "salon",
  timezone: "Europe/Zurich",
  phone: "+41 44 555 21 80",
  address: "Bahnhofstrasse 42, 8001 Zürich",
  currency: "CHF",
  // On trial, and in a venue whose own currency is not the one we bill in —
  // both are states the billing page has to get right, so the demo data
  // exercises them rather than showing three copies of the happy path.
  subscription: {
    planId: "starter",
    cycle: "monthly",
    startedOn: "2026-09-04",
    status: "trialing",
    trial: { endsOn: "2026-09-18", minutes: 25 },
  },
  hours: salonHours,
  closures: [],
  agent: {
    displayName: "Elena",
    greeting: "Lumière, good morning, this is Elena speaking.",
    returningGreeting:
      "Lumière, good morning — Elena here. Good to hear from you again, {name}. What can I book for you?",
    voiceId: process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM",
    // Haiku by default: measured at ~1.3s to the first spoken word against
    // ~2.8s for Opus, and a caller reads three seconds of silence as a dead
    // line. Switch a venue to Opus on the Agent page when its policies are
    // intricate enough to be worth the wait.
    model: "claude-haiku-4-5",
    persona:
      "Calm, precise, and quietly upmarket. You never oversell. You confirm the price before booking because colour work surprises people.",
    policies: [
      "Always state the price and the total duration before confirming a colour appointment.",
      "Colour services for a new client require a patch test at least 48 hours before — if the caller has never been in, say so and offer to book the patch test first.",
      "Cancellations inside 24 hours are charged at 50 percent. Say this once, at the point of booking, not repeatedly.",
      "Never guarantee a specific stylist is available before checking.",
    ],
    faqs: [
      {
        q: "Where are you?",
        a: "Bahnhofstrasse 42, first floor, two minutes from Paradeplatz.",
      },
      {
        q: "Do you take walk-ins?",
        a: "For a fringe trim or a blow-dry, usually yes if you call ahead. Colour and cuts are by appointment.",
      },
      {
        q: "How do I pay?",
        a: "Card, Twint, or cash. We do not take American Express.",
      },
      {
        q: "Do you do bridal or event styling?",
        a: "Yes, that is booked as a consultation first — I can put you in for a fifteen minute consultation with one of the seniors.",
      },
    ],
    transferNumber: "+41 44 555 21 81",
    maxCallSeconds: 420,
    bookingHorizonDays: 120,
  },
  // Twenty-four hours to cancel, which the agent already says out loud in its
  // policies — now it is also a rule the booking carries, so the salon can see
  // which cancellations were late instead of taking the caller's word for it.
  policy: { cancellationWindowHours: 24, lateCancelFee: 65, minNoticeMin: 60 },
  salon: {
    slotMinutes: 15,
    // Colour develops whether or not anybody is standing over it, and this is
    // the salon that proves it: with the phases below, Marie's Thursday fits
    // three colour clients instead of two.
    dovetail: true,
    services: [
      { id: "cut_w", name: "Ladies cut & finish", durationMin: 60, bufferMin: 15, price: 130, recallDays: 56 },
      { id: "cut_m", name: "Gents cut", durationMin: 30, bufferMin: 10, price: 75, recallDays: 28 },
      { id: "blowdry", name: "Blow-dry", durationMin: 45, bufferMin: 10, price: 85 },
      {
        id: "colour_root",
        name: "Root colour",
        durationMin: 90,
        bufferMin: 20,
        price: 190,
        resourceType: "colour_station",
        // Thirty minutes applying, forty developing, twenty washing off and
        // finishing. The middle forty are the stylist's to sell.
        phases: [
          { name: "Apply", durationMin: 30 },
          { name: "Develop", durationMin: 40, staffFree: true },
          { name: "Finish", durationMin: 20 },
        ],
        recallDays: 42,
      },
      {
        id: "balayage",
        name: "Balayage",
        durationMin: 180,
        bufferMin: 30,
        price: 380,
        resourceType: "colour_station",
        phases: [
          { name: "Section & paint", durationMin: 75 },
          { name: "Develop", durationMin: 45, staffFree: true },
          { name: "Wash, tone & finish", durationMin: 60 },
        ],
        recallDays: 84,
      },
      {
        id: "treatment",
        name: "Keratin treatment",
        durationMin: 120,
        bufferMin: 20,
        price: 260,
        phases: [
          { name: "Apply", durationMin: 45 },
          { name: "Process", durationMin: 30, staffFree: true },
          { name: "Seal & blow out", durationMin: 45 },
        ],
      },
      { id: "consult", name: "Consultation", durationMin: 15, bufferMin: 0, price: 0 },
      { id: "patch", name: "Patch test", durationMin: 10, bufferMin: 0, price: 0 },
      // Sold with a colour, never on its own — fifteen minutes on somebody
      // else's appointment rather than a visit anybody makes a trip for.
      { id: "gloss", name: "Gloss finish", durationMin: 15, bufferMin: 0, price: 45, addOnOnly: true },
    ],
    staff: [
      {
        ...stylist(
          "st_marie",
          "Marie",
          ["cut_w", "cut_m", "blowdry", "colour_root", "balayage", "consult", "patch", "gloss"],
          [2, 3, 4, 5, 6],
        ),
        role: "Senior stylist",
        // Twelve years in: quicker on a cut, and priced accordingly. Level
        // pricing is how this trade actually sells, and quoting the wall price
        // for a senior colourist is an argument at the till.
        durationOverrides: { cut_w: 45, colour_root: 75 },
        priceOverrides: { cut_w: 165, colour_root: 230, balayage: 440 },
        breaks: weekdaysOnly([2, 3, 4, 5, 6], H(13), H(13, 45)),
      },
      {
        ...stylist("st_jonas", "Jonas", ["cut_w", "cut_m", "blowdry", "consult"], [1, 2, 3, 4, 5]),
        role: "Stylist",
        breaks: weekdaysOnly([1, 2, 3, 4, 5], H(12, 30), H(13, 15)),
      },
      {
        ...stylist(
          "st_aisha",
          "Aisha",
          ["cut_w", "blowdry", "colour_root", "treatment", "consult", "patch", "gloss"],
          [1, 3, 4, 5, 6],
          H(10),
          H(19),
        ),
        role: "Colourist",
      },
    ],
    resources: [
      { id: "cs1", name: "Colour station 1", type: "colour_station" },
      { id: "cs2", name: "Colour station 2", type: "colour_station" },
    ],
  },
};

// ---------------------------------------------------------------------------
// Demo tenant 3 — dental and aesthetic clinic
//
// The market study put clinics at 4–5× the monthly value of a salon, and the
// diary is the same shape: qualified practitioners, timed treatments, shared
// rooms, turnaround between patients. What changes is the vocabulary and the
// rules — a clinic must never sound like it is giving medical advice.
// ---------------------------------------------------------------------------

const clinic: Location = {
  id: "loc_meridian",
  tenantId: DEFAULT_TENANT_ID,
  businessId: businessIdForLocation("loc_meridian"),
  name: "Meridian Dental & Aesthetics",
  vertical: "clinic",
  timezone: "Asia/Dubai",
  phone: "+971 4 555 0390",
  address: "Al Wasl Road, Jumeirah 1, Dubai",
  currency: "AED",
  hours: weekdaysOnly([0, 1, 2, 3, 4, 6], H(9), H(20)),
  closures: [],
  agent: {
    displayName: "Layla",
    greeting: "Good morning, Meridian Dental and Aesthetics, Layla speaking. How can I help?",
    returningGreeting:
      "Good morning, Meridian, this is Layla. Good to hear from you again, {name} — how can I help?",
    voiceId: process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM",
    // Haiku by default: measured at ~1.3s to the first spoken word against
    // ~2.8s for Opus, and a caller reads three seconds of silence as a dead
    // line. Switch a venue to Opus on the Agent page when its policies are
    // intricate enough to be worth the wait.
    model: "claude-haiku-4-5",
    persona:
      "Composed, discreet and precise. You sound like an experienced practice coordinator: reassuring without being familiar, and never rushed, because people ringing a clinic are often anxious.",
    policies: [
      "Never give clinical advice, never estimate a diagnosis, and never say whether something is urgent. If a caller describes symptoms, book the soonest appropriate appointment and offer to have a clinician call back.",
      "If a caller describes facial swelling, uncontrolled bleeding, a knocked-out tooth, or trauma, tell them to attend an emergency department and offer to transfer them now. Do not attempt to book them.",
      "Quote the consultation fee only. Treatment prices depend on examination and must never be quoted over the phone.",
      "A first visit is always a consultation, never the treatment itself, however specific the caller is about what they want.",
      "Take the insurer's name if the caller mentions insurance, note it, and say the team will confirm coverage before the appointment. Never confirm that a treatment is covered.",
      "Never discuss another patient, confirm whether someone is a patient, or repeat clinical details back to anyone but the patient themselves.",
    ],
    faqs: [
      {
        q: "Where are you and is there parking?",
        a: "Al Wasl Road in Jumeirah 1, next to the pharmacy. There is free parking behind the building and valet from six in the evening.",
      },
      {
        q: "Do you take insurance?",
        a: "We work with most major insurers. Tell me who you're with and I'll note it, and the team will confirm exactly what's covered before your visit.",
      },
      {
        q: "How much is a consultation?",
        a: "The dental consultation is 350 dirhams including x-rays, and the aesthetic consultation is 400 dirhams, which is credited against treatment if you go ahead.",
      },
      {
        q: "Do you see children?",
        a: "Yes, from age three, with Dr Haddad.",
      },
      {
        q: "What if I need to cancel?",
        a: "Just let us know at least twenty-four hours ahead and there's no charge. Inside that we do charge the consultation fee.",
      },
      {
        q: "Do you have appointments outside working hours?",
        a: "We're open until eight in the evening on weekdays and Saturdays, and closed Fridays.",
      },
    ],
    transferNumber: "+971 4 555 0391",
    maxCallSeconds: 480,
    bookingHorizonDays: 120,
  },
  // A clinic's rules are harder than a restaurant's and for better reasons:
  // a chart has to be pulled and a surgery prepared, so two hours' notice is
  // the floor; the cancellation window is the one already quoted in the FAQ
  // above; and a patient who has missed twice is not refused by a machine —
  // the agent takes the request and a person rings them back.
  policy: {
    minNoticeMin: 120,
    cancellationWindowHours: 24,
    noShowsBeforeReview: 2,
    maxOpenPerGuest: 3,
  },
  salon: {
    slotMinutes: 15,
    services: [
      {
        id: "dent_consult",
        name: "Dental consultation",
        durationMin: 30,
        bufferMin: 10,
        price: 350,
        // A first visit is a history, a chart and a set of x-rays before
        // anybody looks in a mouth. Booking it as thirty minutes is how a
        // practice runs forty minutes late by half past ten.
        newGuestDurationMin: 45,
      },
      {
        id: "hygiene",
        name: "Hygiene and polish",
        durationMin: 45,
        bufferMin: 15,
        price: 550,
        // The hour is the hygienist's; ten minutes of it, near the end, is the
        // dentist's for the exam. A practice that cannot say this blocks a
        // whole hour of dentist time per cleaning — which is why their
        // dentist's diary looks full while the dentist sits idle.
        secondary: { role: "dentist", atMin: 35, durationMin: 10 },
        // Six months. This one number is the whole of dental recall, and the
        // recall list is what the practice is actually buying.
        recallDays: 182,
      },
      { id: "filling", name: "Composite filling", durationMin: 60, bufferMin: 15, price: 750, resourceType: "surgery" },
      { id: "root_canal", name: "Root canal treatment", durationMin: 120, bufferMin: 20, price: 2900, resourceType: "surgery" },
      {
        id: "whitening",
        name: "Whitening",
        durationMin: 75,
        bufferMin: 15,
        price: 2200,
        // A surgery and the lamp. The old single-resource field checked
        // whichever came first and let the other be double-booked.
        resourceTypes: ["surgery", "whitening_lamp"],
        phases: [
          { name: "Prepare & isolate", durationMin: 25 },
          { name: "Activate", durationMin: 30, staffFree: true },
          { name: "Remove & finish", durationMin: 20 },
        ],
      },
      { id: "aes_consult", name: "Aesthetic consultation", durationMin: 30, bufferMin: 10, price: 400 },
      {
        id: "injectables",
        name: "Injectables",
        durationMin: 45,
        bufferMin: 15,
        price: 1800,
        resourceType: "treatment_room",
        // Prescription-only, whoever else has been on the course.
        role: "doctor",
        recallDays: 120,
      },
      { id: "skin", name: "Skin treatment", durationMin: 60, bufferMin: 20, price: 950, resourceType: "treatment_room", recallDays: 42 },
    ],
    staff: [
      {
        ...stylist("dr_haddad", "Dr Haddad", ["dent_consult", "hygiene", "filling", "root_canal", "whitening"], [0, 1, 2, 3, 4], H(9), H(18)),
        role: "dentist",
        breaks: weekdaysOnly([0, 1, 2, 3, 4], H(13), H(14)),
      },
      {
        ...stylist("dr_novak", "Dr Novak", ["dent_consult", "hygiene", "filling", "whitening"], [1, 2, 3, 4, 6], H(11), H(20)),
        role: "dentist",
      },
      {
        ...stylist("dr_saeed", "Dr Saeed", ["aes_consult", "injectables", "skin"], [0, 2, 3, 4, 6], H(10), H(19)),
        role: "doctor",
      },
      {
        ...stylist("nurse_rana", "Rana", ["hygiene", "skin"], [0, 1, 2, 3, 4], H(9), H(17)),
        role: "hygienist",
      },
    ],
    resources: [
      { id: "surg1", name: "Surgery 1", type: "surgery" },
      { id: "surg2", name: "Surgery 2", type: "surgery" },
      { id: "room1", name: "Treatment room", type: "treatment_room" },
      { id: "lamp1", name: "Whitening lamp", type: "whitening_lamp" },
    ],
  },
};

/**
 * The seeded venues double as the public demo line — they are fictional, so
 * there is nothing to protect, and a prospect hears the vertical they
 * actually run rather than a generic script. Caps are deliberately tight:
 * this is a shop window, not a service.
 */
function asDemoLine(location: Location, disclosure: string): Location {
  return {
    ...location,
    demo: {
      enabled: true,
      // Four minutes cut prospects off mid-evaluation: the greeting, a
      // booking, a change to it and a couple of awkward questions is the
      // whole point of ringing, and that does not fit. Six minutes does.
      // The daily cap comes down to keep the worst-case spend about level —
      // 30 calls at six minutes is close to 40 at four.
      maxCallsPerDay: 30,
      maxCallSeconds: 360,
      clearBookingsDaily: true,
      disclosure,
    },
  };
}

const FIXTURES = [
  // Belline itself. The bell on the website opens a real call to this, so it
  // is a fixture rather than something set up by hand — a demonstration that
  // depends on somebody remembering to configure it is a demonstration that
  // is broken the first time the data directory is rebuilt.
  bellineVenue,
  asDemoLine(
    restaurant,
    "You've reached the Belline demonstration line for restaurants.",
  ),
  asDemoLine(salon, "You've reached the Belline demonstration line for salons."),
  asDemoLine(
    clinic,
    "You've reached the Belline demonstration line for clinics.",
  ),
];

/**
 * Fill in agent settings added after a venue was first saved.
 *
 * Venue config lives on disk and is edited by the operator, so a new field
 * would otherwise stay `undefined` forever on existing venues and the
 * feature behind it would look broken. Only untouched keys are filled —
 * anything the operator has set is left exactly as they set it.
 */
function backfillAgentDefaults(): void {
  for (const stored of listLocations({ includeInternal: true })) {
    const fixture = FIXTURES.find((f) => f.id === stored.id);
    if (!fixture) continue;

    const missing = (Object.keys(fixture.agent) as (keyof AgentConfig)[]).filter(
      (key) => stored.agent[key] === undefined,
    );
    // `demo` is a top-level field, so it needs its own check — an agent-only
    // backfill would silently skip it and the demo line would never arm.
    const needsDemo = stored.demo === undefined && fixture.demo !== undefined;
    if (missing.length === 0 && !needsDemo) continue;

    const agent = { ...stored.agent };
    for (const key of missing) {
      (agent as Record<string, unknown>)[key] = fixture.agent[key];
    }
    upsertLocation({
      ...stored,
      agent,
      demo: stored.demo ?? fixture.demo,
    });
  }
}

/**
 * Add demo venues that exist as fixtures but not yet in the store.
 *
 * Without this, a venue added to the fixtures after first run never appears —
 * the store is not empty, so seeding is skipped, and the new vertical looks
 * broken rather than absent. Only ever inserts; never overwrites a venue an
 * operator has since edited.
 */
function addMissingVenues(): void {
  const known = new Set(listLocations({ includeInternal: true }).map((l) => l.id));
  for (const fixture of FIXTURES) {
    if (!known.has(fixture.id)) upsertLocation(fixture);
  }
  refreshInternalVenues();
}

/**
 * Keep our own venues matching the code that defines them.
 *
 * Belline's own venue is configured here, not in the dashboard — nobody edits
 * it, and the rule that protects a customer's edits works against us on it.
 * Shortening its greeting changed the fixture and nothing else: the stored
 * copy kept the old wording, on a line that is the first thing anybody hears
 * of the product.
 *
 * Only venues marked `internal`, and only their agent settings — bookings,
 * calls and the brain history stay exactly as they are, because those are
 * real and ours to keep.
 */
function refreshInternalVenues(): void {
  for (const fixture of FIXTURES.filter((f) => f.internal)) {
    const stored = listLocations({ includeInternal: true }).find((l) => l.id === fixture.id);
    if (!stored) continue;
    upsertLocation({
      ...stored,
      hours: fixture.hours,
      requiresEmail: fixture.requiresEmail,
      demo: fixture.demo,
      agent: fixture.agent,
      salon: fixture.salon,
      // Only ever fill a blank, unlike the fields above. The others are
      // configuration nobody edits at runtime; this one holds a key that a
      // stored venue may have had minted for it, and overwriting that would
      // break the widget on a live site to match a fixture.
      embed: stored.embed ?? fixture.embed,
    });
  }
}

/** Populate the store the first time the app runs. Idempotent. */
export function seedIfEmpty(): void {
  if (isEmpty()) {
    replaceAll({ locations: FIXTURES, bookings: [], calls: [] });
    ensureTenancy();
    baselineBrains();
    return;
  }
  addMissingVenues();
  backfillAgentDefaults();
  // Before the brains: a baseline is written against a venue, and a venue
  // without an owner is not one we want to write history for.
  ensureTenancy();
  baselineBrains();
}

/**
 * Give every venue a version 1.
 *
 * Seeded venues and venues that predate the Business Brain have a
 * configuration but no history. Without a baseline the first real edit reads
 * as "everything changed" — true, and useless to anyone scanning the history
 * for what somebody actually did.
 */
function baselineBrains(): void {
  for (const location of listLocations({ includeInternal: true })) ensureBaseline(location);
}

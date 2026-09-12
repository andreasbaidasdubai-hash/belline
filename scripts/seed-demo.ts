/**
 * Demo data.
 *
 * An empty dashboard demos badly — every number is zero and guest
 * recognition has nothing to recognise. This fills a plausible week: a
 * normal service, a couple of regulars with history, and a handful of calls
 * that already happened.
 *
 *   npm run demo          fill in
 *   npm run demo -- reset wipe bookings and calls first
 */

import { seedIfEmpty } from "../src/lib/seed";
import { createBooking } from "../src/lib/booking";
import {
  id,
  listBookings,
  listLocations,
  replaceAll,
  saveBooking,
  saveCall,
} from "../src/lib/store";
import type { Booking, Call, Location } from "../src/lib/types";
import { addDays, todayIn } from "../src/lib/time";

const H = (h: number, m = 0) => h * 60 + m;

seedIfEmpty();

if (process.argv.includes("reset")) {
  replaceAll({ bookings: [], calls: [] });
  console.log("cleared bookings and calls");
}

const locations = listLocations();
const restaurant = locations.find((l) => l.vertical === "restaurant")!;
const salon = locations.find((l) => l.vertical === "salon")!;

let made = 0;
let skipped = 0;
let calls = 0;

function book(
  location: Location,
  input: Parameters<typeof createBooking>[1],
  status: Booking["status"] = "confirmed",
): Booking | null {
  // Seeding writes history as well as tonight's book, and history is in the
  // past — which the house rules refuse for the agent and allow for a person
  // working the diary. This script is the second of those.
  const result = createBooking(location, { staffOverride: true, ...input });
  if (!result.ok) {
    skipped++;
    return null;
  }
  made++;
  // Past visits are history, not tonight's book.
  if (status !== "confirmed") {
    return saveBooking({ ...result.booking, status });
  }
  return result.booking;
}

// ---------------------------------------------------------------------------
// Azure Table
// ---------------------------------------------------------------------------

const rToday = todayIn(restaurant.timezone);

// A regular. Three dinners behind her, one ahead — this is what makes the
// agent open with "lovely to hear from you again".
const NADIA = { guestName: "Nadia Haddad", guestPhone: "+971 50 447 2210" };
for (const back of [46, 27, 9]) {
  book(
    restaurant,
    {
      ...NADIA,
      date: addDays(rToday, -back),
      startMin: H(20),
      partySize: 2,
      notes: back === 9 ? "Prefers the terrace, away from the speakers" : "",
      source: "voice",
    },
    "completed",
  );
}
book(restaurant, {
  ...NADIA,
  date: addDays(rToday, 4),
  startMin: H(20, 30),
  partySize: 2,
  notes: "Terrace if possible",
  source: "voice",
});

const tonight: [string, string, number, number, string][] = [
  ["Marcus Reiner", "+971 55 310 8842", H(18, 30), 2, ""],
  ["Priya Anand", "+971 50 220 7719", H(19), 4, "Birthday — small cake at the end"],
  ["Tom Callaghan", "+971 56 884 1203", H(19, 30), 2, ""],
  ["Yusuf Rahman", "+971 50 991 4406", H(20), 6, "One guest is coeliac"],
  ["Elena Brunner", "+971 52 663 0055", H(20, 30), 3, ""],
  ["David Okafor", "+971 55 447 9928", H(21), 2, "Anniversary"],
];
for (const [guestName, guestPhone, startMin, partySize, notes] of tonight) {
  book(restaurant, { guestName, guestPhone, date: rToday, startMin, partySize, notes, source: "voice" });
}

for (const [guestName, guestPhone, startMin, partySize] of [
  ["Sofia Marchetti", "+971 50 118 3374", H(19), 4],
  ["James Whitfield", "+971 56 220 1190", H(20), 2],
  ["Aisha Karim", "+971 55 776 3321", H(21), 5],
] as [string, string, number, number][]) {
  book(restaurant, {
    guestName,
    guestPhone,
    date: addDays(rToday, 1),
    startMin,
    partySize,
    source: "voice",
  });
}

// ---------------------------------------------------------------------------
// Lumière
// ---------------------------------------------------------------------------

const sToday = todayIn(salon.timezone);

// A colour client on a six-week cycle, always with the same stylist.
const CLAUDIA = { guestName: "Claudia Meier", guestPhone: "+41 79 224 6631" };
for (const back of [84, 42]) {
  book(
    salon,
    {
      ...CLAUDIA,
      date: addDays(sToday, -back),
      startMin: H(10),
      serviceIds: ["colour_root"],
      staffId: "st_marie",
      source: "voice",
    },
    "completed",
  );
}
book(salon, {
  ...CLAUDIA,
  date: addDays(sToday, 3),
  startMin: H(10),
  serviceIds: ["colour_root"],
  staffId: "st_marie",
  notes: "Same shade as last time",
  source: "voice",
});

const salonDay: [string, string, number, string[], string][] = [
  ["Beatrice Vogt", "+41 78 445 1102", H(9, 30), ["cut_w"], ""],
  ["Lukas Amrein", "+41 76 330 8845", H(10, 30), ["cut_m"], ""],
  ["Sandra Keller", "+41 79 662 4417", H(11), ["cut_w", "blowdry"], ""],
  ["Nora Frei", "+41 78 229 5530", H(13, 30), ["balayage"], "Going lighter than last time"],
  ["Miriam Steiner", "+41 79 884 2016", H(15), ["blowdry"], "Wedding on Saturday"],
];
for (const [guestName, guestPhone, startMin, serviceIds, notes] of salonDay) {
  book(salon, { guestName, guestPhone, date: sToday, startMin, serviceIds, notes, source: "voice" });
}

// ---------------------------------------------------------------------------
// Meridian Dental & Aesthetics
// ---------------------------------------------------------------------------

const clinic = locations.find((l) => l.vertical === "clinic")!;
const cToday = todayIn(clinic.timezone);

// A recall patient — hygiene every six months, same practitioner.
const OMAR = { guestName: "Omar Al Nuaimi", guestPhone: "+971 50 663 8814" };
// Whole numbers of weeks, so each visit lands on a weekday Dr Haddad works —
// otherwise the engine correctly refuses to book him and the demo loses a visit.
for (const back of [364, 182]) {
  book(
    clinic,
    {
      ...OMAR,
      date: addDays(cToday, -back),
      startMin: H(9, 30),
      serviceIds: ["hygiene"],
      staffId: "dr_haddad",
      source: "voice",
    },
    "completed",
  );
}
book(clinic, {
  ...OMAR,
  date: addDays(cToday, 6),
  startMin: H(9, 30),
  serviceIds: ["hygiene"],
  staffId: "dr_haddad",
  notes: "Sensitivity on the upper left — mentioned on the call",
  source: "voice",
});

const clinicDay: [string, string, number, string[], string, string][] = [
  ["Hana Darwish", "+971 55 214 7790", H(9), ["dent_consult"], "dr_haddad", "New patient, referred by her sister"],
  ["Peter Lindqvist", "+971 50 884 3312", H(10), ["filling"], "dr_haddad", ""],
  ["Yasmin Farouk", "+971 56 771 0028", H(11), ["aes_consult"], "dr_saeed", "Asked about pricing — quoted consultation only"],
  ["Mateo Rossi", "+971 52 339 6641", H(13, 30), ["hygiene"], "nurse_rana", ""],
  ["Lara Haddad", "+971 55 908 4417", H(14, 30), ["injectables"], "dr_saeed", "Insurance: Daman — team to confirm cover"],
  ["Nabil Kassem", "+971 50 447 2019", H(16), ["root_canal"], "dr_haddad", "In discomfort, brought forward from Thursday"],
];
for (const [guestName, guestPhone, startMin, serviceIds, staffId, notes] of clinicDay) {
  book(clinic, { guestName, guestPhone, date: cToday, startMin, serviceIds, staffId, notes, source: "voice" });
}

for (const [guestName, guestPhone, startMin, serviceIds] of [
  ["Sofia Nasser", "+971 56 220 8845", H(11), ["whitening"]],
  ["Karim Barakat", "+971 50 119 3376", H(15), ["dent_consult"]],
] as [string, string, number, string[]][]) {
  book(clinic, { guestName, guestPhone, date: addDays(cToday, 1), startMin, serviceIds, source: "voice" });
}

// ---------------------------------------------------------------------------
// A few calls that already happened
// ---------------------------------------------------------------------------

function call(
  location: Location,
  minutesAgo: number,
  from: string,
  outcome: Call["outcome"],
  summary: string,
  turns: [Call["transcript"][number]["role"], string][],
  latencies: number[],
  bookingRefName?: string,
): void {
  const startedAt = new Date(Date.now() - minutesAgo * 60_000);
  const booking = bookingRefName
    ? listBookings({ locationId: location.id }).find((b) => b.guestName === bookingRefName)
    : undefined;

  saveCall({
    id: id("call"),
    locationId: location.id,
    channel: "phone",
    from,
    startedAt: startedAt.toISOString(),
    endedAt: new Date(startedAt.getTime() + turns.length * 9_000).toISOString(),
    status: "completed",
    outcome,
    summary,
    transcript: turns.map(([role, text], i) => ({
      role,
      text,
      at: new Date(startedAt.getTime() + i * 9_000).toISOString(),
      ...(role === "agent" && latencies[Math.floor(i / 2)]
        ? { latencyMs: latencies[Math.floor(i / 2)] }
        : {}),
    })),
    toolCalls: [],
    latenciesMs: latencies,
    bookingId: booking?.id,
  });
  calls++;
}

call(
  restaurant,
  38,
  "+971 50 220 7719",
  "booking_created",
  "Booked a four-top at seven for a birthday",
  [
    ["agent", "Good evening, Azure Table, this is Sofia. How can I help you?"],
    ["caller", "Hi, do you have anything for four people tonight around seven?"],
    ["agent", "Let me look. Yes, I can do seven o'clock for four. Can I take a name?"],
    ["caller", "Priya Anand. It's my husband's birthday actually."],
    ["agent", "Lovely. I'll note the birthday and let the kitchen know. Best number for you?"],
    ["caller", "Oh five zero, two two zero, seven seven one nine."],
    ["agent", "Perfect, that's four at seven tonight for Priya Anand. Your reference is in the confirmation. See you this evening."],
  ],
  [820, 940, 760, 880],
  "Priya Anand",
);

call(
  restaurant,
  126,
  "+971 50 447 2210",
  "booking_created",
  "Regular — booked her usual two-top on the terrace",
  [
    ["agent", "Good evening, Azure Table, this is Sofia. Lovely to hear from you again, Nadia Haddad — what can I do for you?"],
    ["caller", "Oh, hello! Can I get the usual on Friday?"],
    ["agent", "A table for two? I have half past eight on Friday. Shall I put you on the terrace again?"],
    ["caller", "Yes please, that's perfect."],
    ["agent", "Done — Friday, half past eight, terrace noted. See you then."],
  ],
  [690, 810, 720],
  "Nadia Haddad",
);

call(
  restaurant,
  200,
  "+971 54 118 9002",
  "message_taken",
  "Private dining enquiry for 20 — passed to the events manager",
  [
    ["agent", "Good afternoon, Azure Table, this is Sofia. How can I help you?"],
    ["caller", "I'm looking to book for about twenty people for a corporate dinner."],
    ["agent", "That's one for our events manager, who'll call you back today. Can I take your name and number?"],
    ["caller", "Khalid Nasser, oh five four, one one eight, nine zero zero two."],
    ["agent", "Thank you Khalid, they'll be in touch this afternoon."],
  ],
  [740, 900, 680],
);

call(
  clinic,
  22,
  "+971 50 447 2019",
  "booking_changed",
  "Patient in discomfort — brought a root canal forward to today",
  [
    ["agent", "Good morning, Meridian Dental and Aesthetics, Layla speaking. How can I help?"],
    ["caller", "I've got an appointment Thursday but the tooth is really painful now."],
    ["agent", "I'm sorry to hear that. I can't advise on the pain itself, but let me see what we have sooner. Dr Haddad has four o'clock today — would that work?"],
    ["caller", "Yes please. Is it going to be expensive?"],
    ["agent", "The root canal is two thousand nine hundred dirhams, though Dr Haddad will confirm after examining you. I've moved you to four o'clock today and noted the discomfort."],
  ],
  [760, 880, 690],
  "Nabil Kassem",
);

call(
  clinic,
  95,
  "+971 55 908 4417",
  "booking_created",
  "Booked injectables, insurance noted for the team to confirm",
  [
    ["agent", "Good morning, Meridian Dental and Aesthetics, Layla speaking. How can I help?"],
    ["caller", "I'd like to book injectables. Do you take Daman?"],
    ["agent", "I'll note Daman and the team will confirm exactly what's covered before your visit. Dr Saeed has half past two today, or Thursday morning."],
    ["caller", "Today's good. Lara Haddad."],
    ["agent", "Half past two today with Dr Saeed, under Lara Haddad. I've noted the insurance. See you this afternoon."],
  ],
  [820, 910, 740],
  "Lara Haddad",
);

call(
  salon,
  75,
  "+41 78 229 5530",
  "booking_changed",
  "Moved a balayage from Tuesday to today",
  [
    ["agent", "Lumière, good morning, this is Elena speaking."],
    ["caller", "Hi, I need to move my appointment on Tuesday."],
    ["agent", "I have your balayage with Marie. What day suits you better?"],
    ["caller", "Could I do this afternoon instead?"],
    ["agent", "Half past one is free with Marie. That's three hours, three hundred and eighty francs. Shall I move it?"],
    ["caller", "Yes, thank you."],
    ["agent", "Moved to half past one today. See you shortly."],
  ],
  [710, 850, 790, 660],
  "Nora Frei",
);

console.log(
  `\n  ${made} bookings created, ${skipped} skipped (slot already taken), ${calls} calls logged.\n` +
    `  Try it: open the test console, put +971 50 447 2210 in "Calling from", and start a call.\n`,
);

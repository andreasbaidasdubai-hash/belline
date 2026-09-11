/**
 * Content for the marketing site's generated pages.
 *
 * The four vertical pages are the same page with different knowledge, so they
 * are data rather than four copies of a file that would drift apart the first
 * time a headline changed.
 *
 * The call scenes are the important part. Every line is what the agent
 * actually says on that trade's line — the same register, the same refusal,
 * the same read-back — because the page's whole claim is that you are hearing
 * the product rather than a script written about it. Each vertical shows two:
 * one where Belline handles the call, and one where it declines to. An
 * operator deciding whether to trust this is buying the second one.
 */

export interface Scene {
  label: string;
  when: string;
  /** [who, what] — "caller" or "agent". */
  turns: [string, string][];
  outcome: { tag: string; what: string; human?: boolean };
}

export interface Vertical {
  slug: string;
  /** Nav label and <h1> subject. */
  name: string;
  title: string;
  description: string;
  headline: string;
  lead: string;
  image: string;
  imageAlt: string;
  /** What this trade's diary is actually made of. */
  constraints: { head: string; body: string }[];
  /** The line the agent must not cross, stated plainly. */
  boundary: string;
  scenes: Scene[];
}

const DENTAL_SCENES: Scene[] = [
  {
    label: "Books it",
    when: "Tuesday, 19:47",
    turns: [
      ["caller", "Hi — I need to get my daughter in for a check-up. After school if you can."],
      ["agent", "Of course. I've got Thursday at quarter past four with Dr Reid, or Friday at half four."],
      ["caller", "Thursday's better."],
      ["agent", "Thursday at four fifteen, then. Can I take her name and a mobile number?"],
    ],
    outcome: { tag: "Booked", what: "Thu 16:15 · Dr Reid · Check-up" },
  },
  {
    label: "Hands it over",
    when: "Wednesday, 08:12",
    turns: [
      ["caller", "I had a filling done yesterday and it's really painful. Is that normal?"],
      ["agent", "I'm not able to advise on that, and I'm not going to guess at it."],
      [
        "agent",
        "Let me take your number and exactly what you've told me — the clinical team will ring you back, and I'm marking it urgent.",
      ],
    ],
    // Kein "ich stelle Sie durch". Belline legt keine Anrufe zusammen; das ist
    // nicht gebaut. Die Seite darf nur behaupten, was die Leitung tut — sonst
    // erfährt es der Kunde beim ersten echten Anruf statt hier.
    outcome: { tag: "Flagged urgent", what: "Clinical team · callback · nothing booked", human: true },
  },
];

const CLINIC_SCENES: Scene[] = [
  {
    label: "Books it",
    when: "Monday, 07:54",
    turns: [
      ["caller", "I'd like to come in about a mole on my shoulder I'm not happy with."],
      ["agent", "That would start as a consultation with one of the dermatologists — about twenty minutes."],
      ["agent", "There's Thursday at nine, or Friday at half eleven."],
      ["caller", "Friday, please."],
    ],
    outcome: { tag: "Booked", what: "Fri 11:30 · Consultation · 20 min" },
  },
  {
    label: "Hands it over",
    when: "Thursday, 21:06",
    turns: [
      ["caller", "My chest has felt tight since this afternoon and I'm a bit short of breath."],
      ["agent", "That needs proper medical attention now, not an appointment."],
      ["agent", "Please ring 999, or go straight to your nearest A&E. I'm not the right place for this."],
    ],
    outcome: { tag: "Escalated", what: "Directed to emergency care · no booking taken", human: true },
  },
];

const SALON_SCENES: Scene[] = [
  {
    label: "Books it",
    when: "Saturday, 17:31",
    turns: [
      ["caller", "Could I get a cut and colour with Marta sometime next week?"],
      [
        "agent",
        "Marta's in Tuesday and Thursday. Ten o'clock Tuesday, or two on Thursday — the two together run about three hours.",
      ],
      ["caller", "Tuesday at ten, please."],
      ["agent", "Done. That's Tuesday the fourteenth at ten, with Marta."],
    ],
    outcome: { tag: "Booked", what: "Tue 10:00 · Marta · Cut + colour · 3h" },
  },
  {
    label: "Holds the line",
    when: "Friday, 18:40",
    turns: [
      ["caller", "I want the full head of bleach tomorrow morning, first thing."],
      [
        "agent",
        "I can get you in — but bleach needs a patch test forty-eight hours before, and we haven't done one for you.",
      ],
      ["agent", "I can book the patch test tomorrow and the colour for Monday. Would that work?"],
    ],
    outcome: { tag: "Policy held", what: "Patch test Sat 09:00 · Colour Mon 10:00" },
  },
];

const RESTAURANT_SCENES: Scene[] = [
  {
    label: "Books it",
    when: "Friday, 19:47",
    turns: [
      ["caller", "Have you got anything Friday around eight? There'll be six of us."],
      ["agent", "Let me look. Eight fifteen I can do six on the terrace, or quarter to nine inside."],
      ["caller", "Terrace, if it's not too cold."],
      ["agent", "Terrace it is — Friday at eight fifteen, table for six. And a name?"],
    ],
    outcome: { tag: "Booked", what: "Fri 20:15 · 6 covers · Terrace" },
  },
  {
    label: "Hands it over",
    when: "Tuesday, 11:02",
    turns: [
      ["caller", "We're looking at a corporate dinner — twenty-two people, private if possible."],
      ["agent", "That's past what I can book myself, and a party that size wants a person on it."],
      ["agent", "I've taken your number and the date — events will call you back this morning."],
    ],
    outcome: { tag: "Message taken", what: "Events callback · 22 covers · flagged", human: true },
  },
];

export const VERTICALS: Vertical[] = [
  {
    slug: "dental",
    name: "Dental",
    title: "Belline for dental practices — Someone always answers",
    description:
      "An AI receptionist for dental practices. It books check-ups and hygiene appointments against your real diary, and hands anything clinical straight to your team.",
    headline: "The practice is with a patient. The phone still rings.",
    lead:
      "Belline answers when the chair is occupied and after you close. It books against the real diary — the right surgery, the right clinician, the right length — and it does not answer a clinical question, ever.",
    image: "/img/dental.jpg",
    imageAlt: "A dental treatment room between patients — the chair empty, the light off.",
    constraints: [
      {
        head: "Clinicians, not slots",
        body: "A hygienist's diary is not a dentist's. Belline only offers a clinician qualified for the appointment being asked for.",
      },
      {
        head: "Surgeries as a separate constraint",
        body: "Two clinicians free does not mean two surgeries free. Rooms and equipment are booked alongside people, not assumed.",
      },
      {
        head: "A first visit is a consultation",
        body: "New patients book an assessment, never the treatment itself — no matter how confidently they ask for it.",
      },
      {
        head: "The cleanup buffer is held, not quoted",
        body: "Turnaround sits in the diary after the appointment. The patient hears their time; the practice keeps its margin.",
      },
    ],
    boundary:
      "Belline will not discuss a diagnosis, interpret a symptom, or advise on medication. Anything clinical, anything urgent, and anything it is unsure of goes to a person immediately — and it says so plainly rather than hedging.",
    scenes: DENTAL_SCENES,
  },
  {
    slug: "clinics",
    name: "Clinics",
    title: "Belline for private clinics — Someone always answers",
    description:
      "An AI receptionist for private and aesthetic clinics. It books consultations against real practitioner and room availability, and escalates anything clinical to a human.",
    headline: "Patients ring at eight in the evening. Reception closed at five.",
    lead:
      "Belline answers out of hours and while your team is with patients. It books consultations against the practitioners and rooms that are genuinely free — and it knows the difference between an enquiry and an emergency.",
    image: "/img/clinics.jpg",
    imageAlt: "A reception sign and a service bell on a counter, nobody behind it.",
    constraints: [
      {
        head: "Practitioners and rooms, separately",
        body: "A treatment room, a laser, a surgery — each is booked in its own right. A free practitioner with no room is not an appointment.",
      },
      {
        head: "Consultation before treatment",
        body: "A caller asking for injectables gets a consultation. The treatment is booked by a clinician, after an assessment.",
      },
      {
        head: "Preparation instructions, in your words",
        body: "Approved pre-appointment information only — what you wrote, read back as you wrote it. Nothing generated on the spot.",
      },
      {
        head: "Minimum notice and horizon",
        body: "It will not book tomorrow morning if you need two days, and it will not book eleven months out because someone asked.",
      },
    ],
    boundary:
      "Belline is reception, not a clinician. It gives no diagnosis, no symptom interpretation and no medical advice. Anything that sounds urgent is directed to emergency care and no appointment is taken — a booking would be the wrong answer at that moment.",
    scenes: CLINIC_SCENES,
  },
  {
    slug: "salons",
    name: "Salons",
    title: "Belline for salons and spas — Someone always answers",
    description:
      "An AI receptionist for salons and spas. It books the right stylist for the service, chains treatments correctly, and holds your patch-test and deposit policies.",
    headline: "Both hands are in someone's hair. The phone rings anyway.",
    lead:
      "Belline answers mid-service and after close. It knows which stylist can do which service, how long the chain actually takes, and which policies it is not allowed to bend.",
    image: "/img/salons.jpg",
    imageAlt: "A brass service bell on a wooden reception counter.",
    constraints: [
      {
        head: "Only stylists qualified for the service",
        body: "A colour goes to a colourist. If a caller asks for someone who cannot do it, Belline says so and offers who can.",
      },
      {
        head: "Chains run back to back",
        body: "A cut and colour is one continuous appointment of the right length, not two bookings that happen to be adjacent.",
      },
      {
        head: "Shared stations and rooms",
        body: "Colour stations and treatment rooms are finite. Two colourists free and one station is one appointment.",
      },
      {
        head: "Patch tests and deposits are not negotiable",
        body: "If your policy needs forty-eight hours, Belline holds it — politely, with an alternative, and without being talked out of it.",
      },
    ],
    boundary:
      "Belline will not quote a price you have not given it, promise a result, or waive a deposit or patch-test rule to keep a caller happy. Complaints and anything about a previous service go to a person.",
    scenes: SALON_SCENES,
  },
  {
    slug: "restaurants",
    name: "Restaurants",
    title: "Belline for restaurants — Someone always answers",
    description:
      "An AI receptionist for restaurants. It takes reservations against real table availability, respects turn times and kitchen pacing, and escalates large parties.",
    headline: "Friday, half past seven, and nobody can reach the phone.",
    lead:
      "Belline answers through service. It holds the same constraints your host holds — turn times, pacing, which table actually fits — so it can commit to a time without anyone checking it afterwards.",
    image: "/img/restaurants.jpg",
    imageAlt: "A restaurant counter being laid before service, the room still dark.",
    constraints: [
      {
        head: "Turn times grow with the party",
        body: "A deuce is ninety minutes; a six-top is two hours. The table is held for as long as the party will really take.",
      },
      {
        head: "Kitchen pacing beats an empty floor",
        body: "Covers seated per quarter hour are capped however many tables look free. A full diary the kitchen cannot serve is not a win.",
      },
      {
        head: "The tightest table that fits",
        body: "Two people take the deuce, not the six-top you will want at nine. Combinations only within the same section.",
      },
      {
        head: "Last seating is respected",
        body: "It will not seat a table the kitchen cannot finish, and it will not quietly book past the close you set.",
      },
    ],
    boundary:
      "Large parties, private dining and events are taken as a message with a callback, not booked. Complaints go to a person. Belline will not invent a dish, an allergen answer or a policy you have not given it.",
    scenes: RESTAURANT_SCENES,
  },
];

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
 * one where Belline takes the request, and one where it declines or hands it
 * over. An operator deciding whether to trust this is buying the second one.
 *
 * Belline does not book into any calendar or booking system today, so no
 * scene offers or confirms a time: the agent takes the details and the time
 * the caller would like, and the team confirms. When a calendar connection is
 * Available, a scene may say "Booked in your calendar" — not before.
 * check-webchat pins this.
 *
 * Changing an agent line drops its recorded clip (public/audio/manifest.json
 * is keyed by the exact text) and that scene falls back to the silent timed
 * transcript until `npm run voices` is run with a speech key.
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
  /** The rules Belline follows in conversation for this trade. */
  constraints: { head: string; body: string }[];
  /** The line the agent must not cross, stated plainly. */
  boundary: string;
  scenes: Scene[];
}

const DENTAL_SCENES: Scene[] = [
  {
    label: "Takes the request",
    when: "Tuesday, 19:47",
    turns: [
      ["caller", "Hi — I need to get my daughter in for a check-up. After school if you can."],
      ["agent", "Of course. I'll take her details and the time you'd like, and the team will confirm it with you."],
      ["caller", "Thursday after four would be best."],
      ["agent", "Thursday after four. Can I take her name and a mobile number?"],
    ],
    outcome: { tag: "Request taken", what: "Check-up · Thu after 16:00 · your team confirms" },
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
    // A callback rather than "I'm putting you through": this is the practice
    // with no team number set, or nobody free to pick up. Where a team number
    // is set, Belline does put urgent calls through live.
    outcome: { tag: "Flagged urgent", what: "Clinical team · callback · no appointment made", human: true },
  },
];

const CLINIC_SCENES: Scene[] = [
  {
    label: "Takes the request",
    when: "Monday, 07:54",
    turns: [
      ["caller", "I'd like to come in about a mole on my shoulder I'm not happy with."],
      ["agent", "That would start as a consultation with one of the dermatologists — about twenty minutes."],
      ["agent", "I'll take your name and number and the day you'd prefer, and the team will confirm a time."],
      ["caller", "Friday morning, if possible."],
    ],
    outcome: { tag: "Request taken", what: "Consultation · Fri morning · your team confirms" },
  },
  {
    label: "Hands it over",
    when: "Thursday, 21:06",
    turns: [
      ["caller", "My chest has felt tight since this afternoon and I'm a bit short of breath."],
      ["agent", "That needs proper medical attention now, not an appointment."],
      // 998, not 999: the UAE ambulance number. The line on the page is the
      // line on the call (EMERGENCY_ADVICE in authority.ts) — change both.
      ["agent", "Please call 998 for an ambulance, or go to the nearest emergency department. I'm not the right place for this."],
    ],
    outcome: { tag: "Escalated", what: "Directed to emergency care · no request taken", human: true },
  },
];

const SALON_SCENES: Scene[] = [
  {
    label: "Takes the request",
    when: "Saturday, 17:31",
    turns: [
      ["caller", "Could I get a cut and colour with Marta sometime next week?"],
      ["agent", "I can take that for Marta. The two together run about three hours. Which day would suit you?"],
      ["caller", "Tuesday morning, ideally."],
      ["agent", "Tuesday morning with Marta. I'll pass that to the team and they'll confirm a time with you. What name should they use?"],
    ],
    outcome: { tag: "Request taken", what: "Cut + colour · Marta · Tue morning · your team confirms" },
  },
  {
    label: "Holds the line",
    when: "Friday, 18:40",
    turns: [
      ["caller", "I want the full head of bleach tomorrow morning, first thing."],
      ["agent", "Bleach needs a patch test forty-eight hours before a first colour, so it can't be tomorrow morning."],
      ["agent", "I'll ask the team for a patch test first and the colour after it. They'll confirm both times with you."],
    ],
    outcome: { tag: "Policy held", what: "Patch test first · colour after · your team confirms" },
  },
];

const RESTAURANT_SCENES: Scene[] = [
  {
    label: "Takes the request",
    when: "Friday, 19:47",
    turns: [
      ["caller", "Have you got anything Friday around eight? There'll be six of us."],
      ["agent", "I can take a request for six on Friday around eight. Inside, or on the terrace?"],
      ["caller", "Terrace, if it's not too cold."],
      ["agent", "Terrace, Friday around eight, for six. The team will confirm the table with you. And a name?"],
    ],
    outcome: { tag: "Request taken", what: "Fri around 20:00 · 6 guests · terrace · your team confirms" },
  },
  {
    label: "Hands it over",
    when: "Tuesday, 11:02",
    turns: [
      ["caller", "We're looking at a corporate dinner — twenty-two people, private if possible."],
      ["agent", "A party that size wants a person on it, so I'll pass it to the events team."],
      ["agent", "I've taken your number and the date. The events team will call you back."],
    ],
    outcome: { tag: "Message taken", what: "Events callback · 22 guests · flagged", human: true },
  },
];

export const VERTICALS: Vertical[] = [
  {
    slug: "dental",
    name: "Dental",
    title: "Belline for dental practices — Someone always answers",
    description:
      "An AI receptionist for dental practices. It answers patients' questions from your information, takes appointment requests, and hands anything clinical to your team.",
    headline: "The practice is with a patient. The phone still rings.",
    lead:
      "Belline answers when the chair is occupied and after you close. It answers from your information, takes the patient's details and request, and never answers a clinical question.",
    image: "/img/dental.jpg",
    imageAlt: "A dental treatment room between patients — the chair empty, the light off.",
    constraints: [
      {
        head: "A first visit is a consultation",
        body: "New patients are asked in for an assessment, never the treatment itself, however confidently they ask for it. Your team confirms the time.",
      },
      {
        head: "Nothing clinical, ever",
        body: "Belline won't interpret a symptom or advise on pain or medication. It takes the patient's number and what they said, and marks it urgent for your team.",
      },
      {
        head: "Emergencies are not appointments",
        body: "A patient describing an emergency hears the instructions you've given for emergencies, and the call goes to your team as urgent.",
      },
      {
        head: "Your words, not its own",
        body: "Prices, preparation and aftercare come from what you wrote. If the answer isn't there, Belline says a colleague will confirm and takes a message.",
      },
    ],
    boundary:
      "Belline will not discuss a diagnosis, interpret a symptom, or advise on medication. Anything clinical, urgent or unclear goes to your team: put through, if you've given Belline a team number, or as an urgent message with the patient's number and what they said.",
    scenes: DENTAL_SCENES,
  },
  {
    slug: "clinics",
    name: "Clinics",
    title: "Belline for private clinics — Someone always answers",
    description:
      "An AI receptionist for private and aesthetic clinics. It answers patients' questions, takes consultation requests and escalates anything clinical to a person.",
    headline: "Patients ring at eight in the evening. Reception closed at five.",
    lead:
      "Belline answers out of hours and while your team is with patients. It takes consultation requests with the patient's details, and knows an enquiry from an emergency.",
    image: "/img/clinics.jpg",
    imageAlt: "A reception sign and a service bell on a counter, nobody behind it.",
    constraints: [
      {
        head: "Consultation before treatment",
        body: "A caller asking for injectables is offered a consultation. The treatment is decided by a clinician, after an assessment.",
      },
      {
        head: "Preparation instructions, in your words",
        body: "Approved pre-appointment information only — what you wrote, read back as you wrote it. Nothing generated on the spot.",
      },
      {
        head: "Emergencies are not appointments",
        body: "Anything that sounds urgent is directed to 998 or the nearest emergency department, and no request is taken.",
      },
      {
        head: "Your team confirms every time",
        body: "Belline takes the treatment, the patient's name and number, and when they'd like to come. Your team books it in your own system and confirms.",
      },
    ],
    boundary:
      "Belline is reception, not a clinician. It gives no diagnosis, no symptom interpretation and no medical advice. Anything that sounds urgent is directed to emergency care and no request is taken — an appointment would be the wrong answer at that moment.",
    scenes: CLINIC_SCENES,
  },
  {
    slug: "salons",
    name: "Salons",
    title: "Belline for salons and spas — Someone always answers",
    description:
      "An AI receptionist for salons and spas. It answers from your price list, takes booking requests and holds your patch-test and deposit rules.",
    headline: "Both hands are in someone's hair. The phone rings anyway.",
    lead:
      "Belline answers mid-service and after close, from your services and prices, and it won't bend the rules you give it.",
    image: "/img/salons.jpg",
    imageAlt: "A brass service bell on a wooden reception counter.",
    constraints: [
      {
        head: "Patch tests and deposits are not negotiable",
        body: "If your policy needs a patch test forty-eight hours before, Belline says so — politely, with the request taken on that basis, and without being talked out of it.",
      },
      {
        head: "Prices only from your list",
        body: "Belline quotes what your price list says and nothing else. A service that isn't on it is a question for your team.",
      },
      {
        head: "Complaints go to a person",
        body: "Anything about a previous visit goes to your team as a message, with the client's number and what they said.",
      },
      {
        head: "Your team confirms the time",
        body: "Belline takes the service, the stylist they'd like and when suits them. Your team books it where you always do and confirms.",
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
      "An AI receptionist for restaurants. It answers guests' questions, takes reservation requests and passes large parties to your team.",
    headline: "Friday, half past seven, and nobody can reach the phone.",
    lead:
      "Belline answers through service, takes the guest's details and request, and hands events and large parties to a person.",
    image: "/img/restaurants.jpg",
    imageAlt: "A restaurant counter being laid before service, the room still dark.",
    constraints: [
      {
        head: "Large parties go to a person",
        body: "Past the party size you set, Belline takes a name, number and date for your team to call back.",
      },
      {
        head: "No invented dishes or allergens",
        body: "It answers from your menu and the allergen notes you gave it. Anything else goes to the team, because a guess about nuts is not an answer.",
      },
      {
        head: "Your hours, your words",
        body: "Opening times, last orders, dress code and parking come from what you wrote, read back as you wrote it.",
      },
      {
        head: "Your team confirms the table",
        body: "Belline takes the date, the time, the party size and any seating wish. Your team confirms it in your reservation system.",
      },
    ],
    boundary:
      "Large parties, private dining and events are taken as a message for a callback. Complaints go to a person. Belline will not invent a dish, an allergen answer or a policy you have not given it.",
    scenes: RESTAURANT_SCENES,
  },
];

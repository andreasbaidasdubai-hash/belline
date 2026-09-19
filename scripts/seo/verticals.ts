/**
 * What Belline knows about a trade, for the location landing pages.
 *
 * This is the *trade* half of `/ai-receptionist/<vertical>/<city>`. The city
 * half is scripts/seo/cities.ts, and the sentences that are only true where
 * the two meet — a Sharjah salon is not a Dubai salon — are in
 * scripts/seo/pairs.ts. Three files rather than one because they change for
 * three different reasons: a trade changes when we learn something about the
 * trade, a city when we learn something about the city, and a pair when
 * somebody sits down and writes about that pair.
 *
 * This is deliberately *not* scripts/site-content.ts. That file is the four
 * existing trade pages, and its `Scene` data is the recorded demo call: every
 * line there is keyed to an audio clip by its exact text, so it cannot be
 * edited freely. These pages reuse those scenes through `tradePage` rather
 * than copying them, and add the things a search landing page needs and a
 * trade page does not: pain points, call types, FAQs and hub copy.
 *
 * Rules for anything written here, and the new check enforces the ones that
 * can be enforced (scripts/check-seo.ts):
 *
 *  - No statistics, no survey numbers, no "83% of callers". We have not
 *    measured anything, and a number nobody measured is the same lie whether
 *    it is a slot the agent invented or a figure on a landing page.
 *  - No testimonials, no customer names, no logos, no review counts. Where a
 *    case study will go there is a marked placeholder, and the check fails the
 *    build if a placeholder reaches a published page.
 *  - Nothing about booking into a calendar. Belline takes the request and the
 *    team confirms; that is what every other page says and it is what the
 *    product does.
 *  - Belline answers in English. A page may say what languages callers use —
 *    that is a fact about the city — but never that Belline speaks them.
 */

/** The eight generated FAQs a page carries, in the order it asks them. */
export interface SeoFaq {
  q: string;
  a: string;
}

export interface SeoVertical {
  slug: string;
  /** "restaurants" — as it reads in "AI receptionist for restaurants in Dubai". */
  plural: string;
  /** "a restaurant" — as it reads mid-sentence. */
  singular: string;
  /** Nav and hub label. */
  name: string;
  /** The existing trade page this belongs under, when there is one (/salons, /dental…). */
  tradePage?: string;
  /** Photography already in public/img/. Never a new asset for a new page. */
  image: string;
  imageAlt: string;
  /** Hub page (/ai-receptionist/<slug>) copy. */
  hub: { title: string; description: string; headline: string; lead: string };
  /** Why this trade misses calls. Three or four, specific to the work. */
  pains: { head: string; body: string }[];
  /** What actually comes down this line, and what Belline does with each. */
  callTypes: { head: string; body: string }[];
  /** The line Belline will not cross on this trade's phone. */
  boundary: string;
  /** Six to eight, and every one of them a question this trade actually asks. */
  faqs: SeoFaq[];
}

const RESTAURANTS: SeoVertical = {
  slug: "restaurants",
  plural: "restaurants",
  singular: "a restaurant",
  name: "Restaurants",
  tradePage: "/restaurants",
  image: "/img/restaurants.jpg",
  imageAlt: "A restaurant counter being laid before service, the room still dark.",
  hub: {
    title: "AI receptionist for restaurants — Belline",
    description:
      "Belline answers a restaurant's phone through service: hours, menu and allergen answers from your own notes, table requests for your team to confirm, events to a person.",
    headline: "The phone rings hardest at the moment nobody can reach it.",
    lead:
      "A restaurant's busiest hour and its busiest phone are the same hour. Belline answers through service, takes the booking request, and hands events and complaints to a person.",
  },
  pains: [
    {
      head: "The rush and the ringing are the same hour",
      body:
        "Between seven and nine the floor is full, the pass is calling and the handset is behind the bar. The calls that go unanswered in those two hours are the ones asking for a table in those two hours.",
    },
    {
      head: "Most of it is not a booking at all",
      body:
        "Are you open tonight, do you do gluten-free, is there parking, can we bring a cake. Each one is thirty seconds of a host's attention taken from a queue of people standing in front of them.",
    },
    {
      head: "A guess about an allergen is not an answer",
      body:
        "Somebody will ask what is in the sauce. A member of staff who is not sure and says yes anyway is the reason that question has to reach the kitchen, not the phone.",
    },
    {
      head: "The voicemail nobody plays back",
      body:
        "A table for four on Saturday left on an answering machine at nine on Friday is a table for four somewhere else by ten. A message is only worth taking if somebody reads it in time.",
    },
  ],
  callTypes: [
    {
      head: "Table requests",
      body:
        "The date, the time, the party size and any seating wish — terrace, inside, a high chair. Belline takes all of it and your team confirms the table in your own reservation book. It never says a table is held.",
    },
    {
      head: "Hours, menu and the practical questions",
      body:
        "Opening times, last orders, dress code, parking, whether the kitchen is still on. Answered from what you wrote, read back as you wrote it, and nothing invented when it is not there.",
    },
    {
      head: "Allergens and dietary questions",
      body:
        "Answered only from the allergen notes you gave Belline. Anything outside them is taken as a message for the kitchen, with the caller's number, rather than guessed at.",
    },
    {
      head: "Large parties and private dining",
      body:
        "Past the party size you set, Belline stops taking details and takes a callback instead: the name, the number, the date and the headcount, flagged for whoever runs events.",
    },
    {
      head: "Changes and cancellations",
      body:
        "A caller moving or dropping a booking is taken as a message with everything they said, so the floor can free the table rather than hold it for nobody.",
    },
    {
      head: "Complaints",
      body:
        "Anything about a meal already eaten goes straight to a person. Belline does not apologise on your behalf, offer a refund, or try to fix it.",
    },
  ],
  boundary:
    "Belline will not invent a dish, an allergen answer, a policy or a table. Large parties, private dining, events and complaints are taken as a message for a person to ring back.",
  faqs: [
    {
      q: "Will it hold a table, or just take the request?",
      a:
        "It takes the request. Belline asks for the date, the time, the party size and the name, then tells the caller your team will confirm. It never says a table is held, because nothing has been held — your team books it in your own reservation system as usual.",
    },
    {
      q: "What does it do about allergies?",
      a:
        "It answers only from the allergen notes you give it, in the words you wrote them. Anything it has not been told is taken as a message for the kitchen with the caller's number, rather than answered. A guess about nuts is not an answer.",
    },
    {
      q: "What happens with a party of twenty?",
      a:
        "You set the size at which a party stops being an ordinary booking. Past it, Belline stops taking details, takes a name, a number, a date and a headcount, and flags it for whoever runs events so a person calls back.",
    },
    {
      q: "Can we still pick up ourselves?",
      a:
        "Yes, and most restaurants do. Forwarding is usually set so Belline only answers when nobody picks up or the line is busy, which means your host still gets first refusal on every call.",
    },
    {
      q: "Does it work during service, when the room is loud?",
      a:
        "Belline is answering the line, not standing in the room, so the noise on your floor does not reach it. What it hears is the caller's end of the line, the same as a host would.",
    },
    {
      q: "Can it read the menu off our website?",
      a:
        "Give it your website, menu or brochure at setup and it drafts your hours, dishes and common questions from them. You check that draft before anything goes live, and you fix what it got wrong.",
    },
    {
      q: "What happens to a complaint about last night's dinner?",
      a:
        "It goes to a person. Belline takes the caller's number and exactly what they said, marks it, and says a manager will ring them back. It will not apologise on your behalf or offer anything.",
    },
    {
      q: "Does it book into OpenTable or SevenRooms?",
      a:
        "Not yet. Belline answers the caller, takes their details and their request, and your team enters it in the system you already use. Booking straight into a reservation platform needs a partner agreement with each company. Tell us which one you use.",
    },
  ],
};

const HAIR_SALONS: SeoVertical = {
  slug: "hair-salons",
  plural: "hair and beauty salons",
  singular: "a salon",
  name: "Hair & beauty salons",
  tradePage: "/salons",
  image: "/img/salons.jpg",
  imageAlt: "A brass service bell on a wooden reception counter.",
  hub: {
    title: "AI receptionist for hair and beauty salons — Belline",
    description:
      "Belline answers a salon's phone mid-service: prices and treatment lengths from your own list, booking requests for your team to confirm, and your patch-test rules held.",
    headline: "Both hands are in someone's hair. The phone rings anyway.",
    lead:
      "A salon's phone rings while every pair of hands is busy. Belline answers from your price list, takes the booking request for your team to confirm, and does not get talked out of a patch test.",
  },
  pains: [
    {
      head: "Nobody has a free hand",
      body:
        "Colour is on, a client is at the basin, the front desk is also the person doing the blow-dry. The phone is not ignored out of rudeness; there is genuinely nobody to answer it.",
    },
    {
      head: "Half the calls are the price list",
      body:
        "How much is balayage, how long does it take, do you do keratin. The answer is already written down and it still costs a stylist five minutes and a client their attention.",
    },
    {
      head: "Rules get argued with",
      body:
        "A patch test forty-eight hours before a first colour is a rule, not a preference, and a caller who wants bleach tomorrow will push. A receptionist under pressure bends. Belline does not.",
    },
    {
      head: "Callers want a named person",
      body:
        "People book a stylist, not a salon. A request that does not capture who they want is a request the desk has to ring back about.",
    },
  ],
  callTypes: [
    {
      head: "Booking requests, with the stylist named",
      body:
        "The service, the stylist they want, the day that suits and how long it runs. Belline takes all four and your team confirms the time in the book you already keep.",
    },
    {
      head: "Prices and treatment lengths",
      body:
        "Straight from your price list, word for word. A service that is not on the list is a question for your team, not something Belline puts a number on.",
    },
    {
      head: "Patch tests, deposits and your own rules",
      body:
        "If your policy needs a patch test before a first colour, or a deposit before a long appointment, Belline says so, takes the request on that basis, and holds the line politely when pushed.",
    },
    {
      head: "Changes and no-shows",
      body:
        "A client moving or cancelling is taken as a message with the time they were down for, so the chair can be refilled rather than left empty.",
    },
    {
      head: "Bridal, groups and anything long",
      body:
        "A wedding party or a full day of work is a conversation with a person. Belline takes the date, the headcount and the number, and flags it.",
    },
    {
      head: "Complaints about a previous visit",
      body:
        "Colour that did not turn out, a cut somebody is unhappy with — taken as a message for a person, with what the client said in their own words, and never argued with.",
    },
  ],
  boundary:
    "Belline will not quote a price you have not given it, promise a colour result, or waive a deposit or a patch test to keep a caller happy. Complaints and anything about a previous service go to a person.",
  faqs: [
    {
      q: "Will it quote prices we have not set?",
      a:
        "No. It reads your price list and says what is on it. A service that is not on the list is taken as a question for your team, with the caller's number, rather than given a number Belline made up.",
    },
    {
      q: "Will it hold our patch-test rule?",
      a:
        "Yes, and that is most of the point. If your policy is a patch test forty-eight hours before a first colour, Belline says so, takes the request on that basis, and keeps saying so if the caller pushes. It does not have a bad day.",
    },
    {
      q: "Can a caller ask for a particular stylist?",
      a:
        "Yes. Belline takes the stylist's name with the request, along with the service and the day that suits, and your team confirms a time. It does not tell the caller whether that stylist is free — it has not looked.",
    },
    {
      q: "Does it actually book the appointment?",
      a:
        "No. It takes the request and tells the client your team will confirm. Your team books it where you always book it. Nothing goes in a diary without a person seeing it.",
    },
    {
      q: "What about deposits?",
      a:
        "Belline states the deposit rule as you wrote it and takes the request on that basis. It does not take a card number or a payment over the phone, and it will not waive the deposit because somebody asked nicely.",
    },
    {
      q: "Can it handle a bridal enquiry?",
      a:
        "It takes it and hands it over. A wedding party is a conversation with a person about timings, trials and a price, so Belline captures the date, the headcount and the number and flags it for whoever handles them.",
    },
    {
      q: "Will clients know it is not a person?",
      a:
        "If they ask, it says so. Belline does not pretend to be a member of your staff.",
    },
    {
      q: "Does it work with Fresha or Booksy?",
      a:
        "Not yet. Belline answers the caller, takes the service, the stylist and the day, and your team enters it in the system you already use. Booking straight into a salon platform needs a partner agreement with each company.",
    },
  ],
};

const DENTAL_CLINICS: SeoVertical = {
  slug: "dental-clinics",
  plural: "dental clinics",
  singular: "a dental practice",
  name: "Dental clinics",
  tradePage: "/dental",
  image: "/img/dental.jpg",
  imageAlt: "A dental treatment room between patients — the chair empty, the light off.",
  hub: {
    title: "AI receptionist for dental clinics — Belline",
    description:
      "Belline answers a dental practice's phone while the chair is busy and after you close: appointment requests for your team to confirm, anything clinical to a person.",
    headline: "The practice is with a patient. The phone still rings.",
    lead:
      "Belline answers when the chair is occupied and after you close. It takes appointment requests only — the name, the number and when they would like to come — and it answers nothing clinical.",
  },
  pains: [
    {
      head: "Surgery time is not phone time",
      body:
        "A nurse chairside cannot break gloves to take a booking, and the practice manager is on the other line to a lab. The phone rings through a procedure with nobody able to reach it.",
    },
    {
      head: "Pain calls arrive after you close",
      body:
        "A toothache does not wait for nine in the morning. Somebody in real discomfort at nine at night either reaches an answering machine or rings somebody else.",
    },
    {
      head: "A receptionist must not answer a clinical question",
      body:
        "Is this normal after a filling, should I take another painkiller, is the swelling a problem. The only safe answer is a person who is qualified to give one, and getting that reliably right at eight in the evening is the hard part.",
    },
    {
      head: "New patients ask for treatment, not an assessment",
      body:
        "People ring asking to book a crown or a whitening. What they can actually book is an examination, and holding that line every time takes a front desk that is never rushed.",
    },
  ],
  callTypes: [
    {
      head: "Appointment requests",
      body:
        "The patient's name, a number, the reason in their own words and when they would like to come. Your team confirms the slot; Belline never offers one.",
    },
    {
      head: "New-patient enquiries",
      body:
        "Asked in for an assessment rather than the treatment they named, however confidently they name it, and told what that first visit involves in the words you wrote.",
    },
    {
      head: "Pain and urgent calls",
      body:
        "Belline does not interpret the symptom. It takes the number and exactly what the patient said, marks it urgent for the clinical team, and — where you have given it a team number — puts the call through live.",
    },
    {
      head: "Practical questions",
      body:
        "Opening hours, parking, what to bring, how long an appointment runs, what you charge for an examination. From your own notes, and a message when the answer is not in them.",
    },
    {
      head: "Cancellations and reschedules",
      body:
        "Taken as a message with the appointment the patient thinks they have, so the desk can free the chair instead of discovering it empty.",
    },
    {
      head: "Emergencies",
      body:
        "A caller describing something that is not a dental problem hears the emergency instructions you have given Belline for your country, and no appointment is taken.",
    },
  ],
  boundary:
    "Belline will not discuss a diagnosis, interpret a symptom, or advise on pain or medication. It is reception, not a clinician. Please do not use it for medical details: anything clinical, urgent or unclear goes to your team as an urgent message with the patient's number and what they said, or straight through to a person where you have given it a number.",
  faqs: [
    {
      q: "Will it give clinical advice?",
      a:
        "No, and it refuses out loud rather than hedging. Asked whether pain after a filling is normal, it says it is not able to advise, takes the number and exactly what the patient described, and marks it urgent for your clinical team.",
    },
    {
      q: "What does it do with a patient in pain at night?",
      a:
        "It takes the call rather than letting it ring out. It does not diagnose and it does not offer a slot. It captures the patient's number and their own words, marks the message urgent, and where you have given it a team number it puts the call through live.",
    },
    {
      q: "Can it book a treatment for a new patient?",
      a:
        "It takes a request for an assessment, not for the treatment. A new patient asking to book a crown is asked in for an examination first, and told what that visit involves in the words you wrote.",
    },
    {
      q: "Is it safe for patient information?",
      a:
        "Treat it as reception, not as a clinical record. It should be used to take an appointment request — a name, a number and when somebody would like to come — and not for medical details. Transcripts are stored so you can see what was said; call audio is not recorded.",
    },
    {
      q: "Does it confirm the appointment time?",
      a:
        "No. Belline takes the request and says your team will confirm. Your practice books it in your own system, which means nothing lands in your day without a person putting it there.",
    },
    {
      q: "Can it quote our prices?",
      a:
        "Only the ones you give it, in the words you wrote. An examination fee you have written down, it reads back. A treatment cost that depends on the examination, it does not guess at — it takes a message.",
    },
    {
      q: "What if somebody rings with a medical emergency?",
      a:
        "It stops trying to be reception. The caller hears the emergency instructions you have given Belline for your country — the ambulance number, or the nearest emergency department — and no appointment request is taken, because an appointment would be the wrong answer at that moment.",
    },
    {
      q: "Will patients be told it is an AI?",
      a:
        "If they ask, yes, plainly. Belline does not present itself as a member of your practice team.",
    },
  ],
};

const AESTHETIC_CLINICS: SeoVertical = {
  slug: "aesthetic-clinics",
  plural: "aesthetic and medical clinics",
  singular: "a clinic",
  name: "Aesthetic & medical clinics",
  tradePage: "/clinics",
  image: "/img/clinics.jpg",
  imageAlt: "A reception sign and a service bell on a counter, nobody behind it.",
  hub: {
    title: "AI receptionist for aesthetic and medical clinics — Belline",
    description:
      "Belline answers a clinic's phone out of hours and while your team is with patients: consultation requests for your team to confirm, and urgent calls sent to emergency care.",
    headline: "Patients ring at eight in the evening. Reception closed at five.",
    lead:
      "Belline answers after your desk goes home and while your team is with patients. It takes consultation requests only, knows an enquiry from an emergency, and is not for medical details.",
  },
  pains: [
    {
      head: "Enquiries arrive in the evening",
      body:
        "People research a treatment after work and ring while they are still thinking about it. A clinic whose desk closed at five meets that caller with an answering machine, on the one evening they were ready to act.",
    },
    {
      head: "Every enquiry starts with a consultation",
      body:
        "A caller asking to book filler is asking for something a clinician decides, after an assessment. Redirecting that without sounding like a refusal is skilled work, and it has to happen on every call.",
    },
    {
      head: "Price is the first question and the wrong one to guess",
      body:
        "What does it cost depends on what is being treated and how much. A number given on the phone that the consultation then contradicts is a complaint waiting to be made.",
    },
    {
      head: "Some callers are not ringing about a treatment at all",
      body:
        "Occasionally somebody describes something that needs a doctor now. Recognising that and stopping — rather than booking them in for Thursday — is the single most important thing a clinic's phone does.",
    },
  ],
  callTypes: [
    {
      head: "Consultation requests",
      body:
        "The treatment they are interested in, their name, a number and when they would like to come. Belline says how long a consultation runs, from your notes, and your team confirms the time.",
    },
    {
      head: "Treatment questions",
      body:
        "Answered only from the approved information you wrote: what a treatment is, roughly how long it takes, what the consultation covers. Anything about suitability is a clinician's answer, and Belline says so.",
    },
    {
      head: "Preparation and aftercare",
      body:
        "Your own pre-appointment and aftercare instructions, read back as you wrote them. Nothing generated on the spot, and nothing adapted to what the caller says about themselves.",
    },
    {
      head: "Prices",
      body:
        "From your price list where you have set one, with the consultation named as the thing that decides the rest. It does not estimate a course of treatment.",
    },
    {
      head: "Urgent calls",
      body:
        "Anything that sounds like it needs medical attention now is directed to emergency care using the instructions you gave Belline for your country, and no request is taken.",
    },
    {
      head: "Complaints and anything about a result",
      body:
        "A patient unhappy with an outcome reaches a person. Belline takes what they said, with their number, and does not respond to it.",
    },
  ],
  boundary:
    "Belline is reception, not a clinician. It gives no diagnosis, no assessment of whether a treatment suits somebody, and no medical advice. Please do not use it for medical details. Anything that sounds urgent is directed to emergency care and no request is taken — an appointment would be the wrong answer at that moment.",
  faqs: [
    {
      q: "Will it tell a caller whether a treatment is right for them?",
      a:
        "No. That is an assessment, and an assessment is a clinician's. Belline explains what the treatment is from your own notes, says the consultation is where suitability is decided, and takes a request for one.",
    },
    {
      q: "Can it quote a treatment price?",
      a:
        "It reads back the prices you have written down, and names the consultation as the thing that settles the rest. It will not estimate a course of treatment or quote a figure you have not given it.",
    },
    {
      q: "What happens if somebody describes a medical emergency?",
      a:
        "It stops being reception. The caller is directed to emergency care using the instructions you gave Belline for your country, and no appointment request is taken.",
    },
    {
      q: "Does it give preparation or aftercare instructions?",
      a:
        "Only yours, word for word. It does not adapt them to what a caller says about their own health, because adapting them would be advice.",
    },
    {
      q: "Is it suitable for a medical clinic and not only an aesthetic one?",
      a:
        "It is suitable as reception for either: hours, services, directions and appointment requests. It is not suitable as a place to discuss a patient's condition, and the boundary above is the same in both.",
    },
    {
      q: "Who sees what was said on the call?",
      a:
        "Your team. Every conversation arrives as a summary and a full transcript, so you can read exactly what Belline said and what the caller said. Call audio is not recorded.",
    },
    {
      q: "Does it confirm the consultation time?",
      a:
        "No. It takes the request and says your team will confirm. Your clinic books it in your own system, so nothing enters a clinician's day without a person putting it there.",
    },
    {
      q: "Will callers know they are speaking to an AI?",
      a:
        "If they ask, it says so plainly. It does not present itself as a member of your clinical or reception team.",
    },
  ],
};

const SPAS: SeoVertical = {
  slug: "spas",
  plural: "spas",
  singular: "a spa",
  name: "Spas",
  tradePage: "/salons",
  image: "/img/salons.jpg",
  imageAlt: "A brass service bell on a wooden reception counter.",
  hub: {
    title: "AI receptionist for spas — Belline",
    description:
      "Belline answers a spa's phone away from the floor: treatment lengths and prices from your own list, booking requests for your team to confirm, packages and groups to a person.",
    headline: "The floor is quiet on purpose. The phone is not.",
    lead:
      "A spa sells calm, and a ringing phone in a treatment corridor is the opposite of it. Belline answers away from the floor, takes the request from your own price list, and hands packages and groups to a person.",
  },
  pains: [
    {
      head: "A ringing phone undoes the room",
      body:
        "The product is quiet. A handset going off outside a treatment room is heard by every guest who paid not to hear it, and a therapist who answers it has left somebody on a table.",
    },
    {
      head: "Therapists are unreachable by design",
      body:
        "Every pair of hands is in a sixty- or ninety-minute appointment. There is no moment in the day when somebody is both free and at the desk.",
    },
    {
      head: "The menu is long and the questions are repetitive",
      body:
        "How long is the hot stone, is the facial suitable in pregnancy, what is in the package, can two of us come together. All written down; all still asked out loud.",
    },
    {
      head: "Packages and couples are a conversation",
      body:
        "Two rooms and two therapists at the same hour, or a day package with lunch in the middle, is scheduling work. It cannot be taken as an ordinary booking and should not be.",
    },
  ],
  callTypes: [
    {
      head: "Treatment booking requests",
      body:
        "The treatment, how long it runs, the therapist if they have a preference and the day that suits. Your team confirms the time and the room.",
    },
    {
      head: "The treatment menu and prices",
      body:
        "Read back from your own list — what a treatment includes, how long it takes, what it costs. Nothing on the list is nothing Belline will invent.",
    },
    {
      head: "Contraindications and suitability",
      body:
        "Belline states the rule you wrote — pregnancy, recent surgery, a condition you exclude — and takes the request on that basis. It does not decide whether a guest is suitable.",
    },
    {
      head: "Couples, groups and packages",
      body:
        "Taken as a message with the date, the headcount and the number, because two rooms at one hour is scheduling, not a booking request.",
    },
    {
      head: "Gift vouchers",
      body:
        "Belline explains what you sell and how somebody buys one, from your notes, and takes a message. It does not take a payment.",
    },
    {
      head: "Late arrivals and cancellations",
      body:
        "Your cancellation window as you wrote it, stated plainly, with the message passed to the desk so the room can be refilled.",
    },
  ],
  boundary:
    "Belline will not decide whether a treatment is suitable for a guest, waive a cancellation window, quote a price that is not on your list, or take a payment. Packages, couples, groups and complaints go to a person.",
  faqs: [
    {
      q: "Can it tell a guest whether a treatment is safe in pregnancy?",
      a:
        "It states the rule you gave it — that a treatment is or is not offered in pregnancy — and takes the request on that basis. It does not judge an individual guest's suitability, and anything beyond your written rule goes to your team as a message.",
    },
    {
      q: "Will it book a couples treatment?",
      a:
        "It takes it as a message rather than an ordinary request. Two rooms and two therapists at the same hour is scheduling work, so Belline captures the date, who is coming and a number, and flags it for the desk.",
    },
    {
      q: "Can it sell a gift voucher over the phone?",
      a:
        "No. It explains what you offer and how somebody buys one, from your own notes, and takes a message with the caller's number. Belline does not take card details or payments.",
    },
    {
      q: "Does it know how long each treatment runs?",
      a:
        "If you have written it down, yes, and it reads it back exactly. Treatment lengths are the most-asked question on a spa line and the easiest to get wrong from memory.",
    },
    {
      q: "Will it hold our cancellation window?",
      a:
        "Yes. It states the window as you wrote it and does not waive it because a caller is unhappy. A guest who wants an exception is taken as a message for a person, who can make that decision.",
    },
    {
      q: "Does it confirm the room and the time?",
      a:
        "No. It takes the request and says your team will confirm. Rooms and therapists are yours to allocate, and Belline has not looked at either.",
    },
    {
      q: "Can our therapists see what was said?",
      a:
        "Your team gets a summary and a full transcript of every conversation, with the guest's details and what they asked for. Call audio is not recorded.",
    },
    {
      q: "Will a guest know it is an AI?",
      a:
        "If they ask, it says so. It does not pretend to be one of your therapists or your receptionist.",
    },
  ],
};

export const SEO_VERTICALS: readonly SeoVertical[] = [
  RESTAURANTS,
  HAIR_SALONS,
  DENTAL_CLINICS,
  AESTHETIC_CLINICS,
  SPAS,
];

export const SEO_VERTICAL_SLUGS = SEO_VERTICALS.map((v) => v.slug);

export function seoVertical(slug: string): SeoVertical {
  const found = SEO_VERTICALS.find((v) => v.slug === slug);
  if (!found) throw new Error(`No SEO vertical named "${slug}" (scripts/seo/verticals.ts).`);
  return found;
}

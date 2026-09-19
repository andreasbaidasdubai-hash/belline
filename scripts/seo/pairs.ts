/**
 * The copy that is only true where a trade and a city meet.
 *
 * This file is the whole point of the exercise. A trade page plus a city page
 * with the two names substituted into each other is a template, and Google's
 * scaled-content-abuse policy is written about exactly that. What makes
 * `/ai-receptionist/restaurants/dubai` worth having is the handful of things
 * that are true about a Dubai restaurant's telephone and about nothing else:
 * the Ramadan evening, the four-hour dinner service, the WhatsApp number on
 * the Instagram bio. Those sentences cannot be generated; somebody has to know
 * them and write them down.
 *
 * So a combination is publishable only when its pair copy exists. There is no
 * fallback, deliberately: a missing pair is a build error, not a page with the
 * city's name dropped into the trade's paragraph.
 * scripts/check-seo.ts measures how much of each published page is unique to
 * that page and fails under the floor, so the rule is enforced by arithmetic
 * rather than by good intentions.
 *
 * Keys are `"<vertical>/<city>"`, using the slugs in verticals.ts and
 * cities.ts. See docs/seo-pages.md for how to add one.
 *
 * Nothing in here may contain a statistic, a testimonial, a customer name or a
 * review count. Where a real case study belongs, the renderer puts a marked
 * placeholder block that the check refuses to let onto a published page —
 * so a placeholder can be written and cannot be shipped by accident.
 */

import type { SeoFaq } from "./verticals";

export interface PairCopy {
  /**
   * The hero's lead, under the H1. Two or three sentences that would be wrong
   * on any other page in the matrix.
   */
  lead: string;
  /** The page's meta description. Under 160 characters where it can be. */
  description: string;
  /**
   * Three or four headed paragraphs of local, trade-specific substance: what
   * this trade's phone line in this city is actually like. Facts, not
   * adjectives, and nothing we have not checked.
   */
  local: { head: string; body: string }[];
  /**
   * The questions this trade asks in this city and nowhere else. Appended to
   * the vertical's own FAQs, which gets each page to six to eight.
   */
  faqs: SeoFaq[];
}

export const SEO_PAIRS: Record<string, PairCopy> = {
  // --- restaurants × Dubai -------------------------------------------------
  "restaurants/dubai": {
    lead:
      "A Dubai dinner service does not start at seven and finish at nine — it starts late and runs long, and the phone runs with it. Belline answers through the whole of it, takes the table request for your team to confirm, and answers on WhatsApp too, because that is where a great many of your guests would rather ask.",
    description:
      "An AI receptionist for Dubai restaurants. Answers your phone and WhatsApp through service, takes table requests for your team to confirm, passes events to a person.",
    local: [
      {
        head: "Your service is longer than your phone cover",
        body:
          "Dubai eats late. A table booked for nine is unremarkable here, and the last covers of the evening go down at an hour when a European kitchen has been closed for a while. That stretches a restaurant's phone cover across a longer window than the rota was ever written for — and the calls in the last two hours of it are the same calls as the first two: people asking whether you can fit them in tonight.",
      },
      {
        head: "The booking arrives on WhatsApp, not the landline",
        body:
          "In the UAE, messaging a business is the normal thing to do rather than the modern thing to do. A Dubai restaurant's Instagram bio has a WhatsApp link on it, and guests use it to ask about tables the way they would ask a friend. Belline answers a WhatsApp number of its own alongside your phone, from the same menu, hours and allergen notes, so the answer does not depend on which one somebody picked.",
      },
      {
        head: "Ramadan moves the whole evening",
        body:
          "During Ramadan the shape of a Dubai restaurant's day changes completely: daytime trade thins, and the evening compresses into a sharp rush around iftar and a long second service after it. The phone follows. Belline reads the hours you set, so when you change them for Ramadan it changes what it tells callers the same day, rather than repeating last month's opening times to everyone who rings.",
      },
      {
        head: "The questions are practical and they repeat",
        body:
          "Is there parking at the tower, which entrance, is the terrace open in July, do you have a licence, is there a dress code, can you do a cake for a birthday. In a city of mall and tower addresses, directions alone account for a real share of the calls. Every one of those answers is already written down somewhere in your restaurant; Belline reads them back exactly, and takes a message for anything that is not there.",
      },
    ],
    faqs: [
      {
        q: "Can it answer in Arabic?",
        a:
          "Not yet — Belline answers in English. English is the working language of most Dubai restaurants and of most calls they take, but if your guests expect Arabic on the line, this is the honest limit today rather than something to work around.",
      },
      {
        q: "Will it know we change our hours for Ramadan?",
        a:
          "It reads the hours you have set, so when you change them it changes what it says. What it will never do is guess: if you have not updated them, it repeats what is written, which is why the hours are worth changing on the day rather than the week after.",
      },
      {
        q: "Does it answer our WhatsApp as well as the phone?",
        a:
          "Yes, on a WhatsApp number of its own that we set up with you. Your existing WhatsApp stays exactly as it is. Both channels answer from the same hours, menu and allergen notes, so a guest gets the same answer whichever one they use.",
      },
      {
        q: "Can it tell somebody which tower we are in and where to park?",
        a:
          "From your own directions, word for word — the tower, the entrance, the level, whether there is valet. In a city of mall and podium addresses that is a real share of the calls, and it is the one question a guest standing outside cannot solve on their own.",
      },
    ],
  },

  // --- hair & beauty salons × Sharjah -------------------------------------
  "hair-salons/sharjah": {
    lead:
      "A Sharjah salon answers to two different weeks at once: the emirate's four-day government week, and the Monday-to-Friday one a great many of its clients work in Dubai. Belline answers on both, from your own price list, and does not get argued out of a patch test.",
    description:
      "An AI receptionist for Sharjah hair and beauty salons. Answers from your price list on Sharjah's week and on Dubai's, takes booking requests, and holds your rules.",
    local: [
      {
        head: "Two weeks, one phone",
        body:
          "Sharjah's government has worked a four-day week since January 2022 — Monday to Thursday, with a three-day weekend running Friday to Sunday — while Dubai and Abu Dhabi work Monday to Friday. A large share of Sharjah residents commute into Dubai and live on the Dubai calendar. For a salon in Al Majaz or Al Nahda, that means two client populations whose free days do not overlap, and a phone that is busy on Friday morning for one of them and Saturday afternoon for the other.",
      },
      {
        head: "The commute decides when you get rung",
        body:
          "The Sharjah-to-Dubai drive is the fact that organises the day here. Clients who do it are out before your salon opens and back after it is busy, so the calls asking for a Thursday evening slot arrive at eight at night, and the calls asking about Saturday arrive on Friday. A line that is only answered during trading hours misses the part of the conversation that happens on either side of them, which is most of it.",
      },
      {
        head: "Price comes up in the first thirty seconds",
        body:
          "Sharjah callers ask what something costs earlier than Dubai callers do, and they ask precisely: not what does colour cost, but what does a half-head of highlights cost with a cut. That is a question your price list can answer and a stylist with foils in their hands cannot. Belline reads the list back exactly, including the lengths, and refuses to put a number on anything that is not written on it.",
      },
      {
        head: "The rules are the reason to use it",
        body:
          "Ladies-only floors and private rooms, a patch test forty-eight hours before a first colour, a deposit before a long appointment — every salon here has rules that a caller under time pressure will test. A receptionist who is also the person on the floor says yes to get off the phone. Belline states the rule, takes the request on that basis, and says it again the second time it is asked.",
      },
    ],
    faqs: [
      {
        q: "Which week does it work — Sharjah's or Dubai's?",
        a:
          "Whichever one you set. Belline reads the opening hours you give it, and it answers the phone on every day of the week regardless. That is the useful part in Sharjah: the calls on your closed days still get taken as requests, so Monday morning starts with a list rather than with voicemail.",
      },
      {
        q: "Can it say we have a ladies-only floor or a private room?",
        a:
          "Yes, if you write it down, and in your words. Belline reads back what you gave it and does not embroider. What it will not do is decide who qualifies for what — that is your team's call, and anything it is unsure about goes to them as a message.",
      },
      {
        q: "Do our clients in Dubai have to make an international call?",
        a:
          "No. Your existing Sharjah number forwards to Belline: you set the forwarding on the line you already have, and nothing changes for anyone ringing it. Your number stays on your sign, your Instagram and your Google listing.",
      },
      {
        q: "Does it answer our WhatsApp as well as the phone?",
        a:
          "Yes, on a second WhatsApp number we set up with you, reading the same price list and the same rules as the phone line. Your existing WhatsApp — the one your regulars already message — keeps its history and is not touched.",
      },
    ],
  },

  // --- dental clinics × London (a market we are not open in) --------------
  "dental-clinics/london": {
    lead:
      "A London practice's hardest calls arrive after the desk goes home: pain, at nine in the evening, from somebody deciding between waiting until morning and ringing 111. Belline is not open in the United Kingdom yet — this page is here so you can judge whether it would be worth a look when we are.",
    description:
      "What an AI receptionist would do for a London dental practice: out-of-hours pain calls, new patients, nothing clinical. Not available in the UK yet — join the waitlist.",
    local: [
      {
        head: "The out-of-hours call is the whole problem",
        body:
          "A London practice's phone is manageable in surgery hours and unmanageable outside them. Toothache does not keep office hours, and a patient in pain at nine in the evening has three options: your answering machine, NHS 111, or the practice down the road whose phone someone answers. Two of those three are how a practice loses a patient it has had for a decade.",
      },
      {
        head: "NHS and private on the same line",
        body:
          "Most London practices carry both, and the first thing a new caller needs to know is which one they are ringing about — whether you are taking NHS patients at all right now, what an examination costs privately, whether a plan covers it. Those are answers you have already written down for the website. A receptionist repeats them forty times a week; Belline reads them back exactly and takes a message when the answer is not there.",
      },
      {
        head: "Nothing clinical, and in England that line is regulated",
        body:
          "Dental practices in England are registered with the Care Quality Commission, and a reception line is reception, not clinical advice. Belline is built the same way round: asked whether the pain after a filling is normal, it says it cannot advise, takes the patient's number and their own words, and marks it urgent for the clinical team. In an emergency it gives the instruction you set — 999 or 112, or NHS 111 for urgent advice that is not an emergency — and takes no appointment request at all.",
      },
      {
        head: "The clocks move, and the forwarding should not care",
        body:
          "A small operational thing that catches people out: British Summer Time means the hour your evening cover starts is a different hour of daylight in June than in December. Forwarding rules are set on the clock, not on the light, so the rule you write in March keeps doing the right thing in November. Belline answers whatever the clock says.",
      },
    ],
    faqs: [
      {
        q: "Can we buy this for our London practice today?",
        a:
          "No. Belline is live in the United Arab Emirates and nowhere else. We have not bought UK numbers, we do not have support hours in this timezone, and the checkout will not take a United Kingdom business. Join the waitlist and we will write to you when that changes — there is nothing to pay and nothing to cancel.",
      },
      {
        q: "Why publish a London page at all, then?",
        a:
          "Because you are entitled to judge the thing before we ask you for anything. Everything on this page about what Belline does and refuses to do is true today; the only thing that is not available is buying it here. We would rather say that plainly than take a deposit for a date we cannot promise.",
      },
      {
        q: "What would it do with an NHS 111 case?",
        a:
          "Belline is reception, so it does not triage. It would give the instruction you set it for urgent calls, take the patient's number and exactly what they said, and mark it for your clinical team. Deciding that a caller belongs with 111 rather than with you is a clinical judgement and stays with a person.",
      },
      {
        q: "When will you open in the United Kingdom?",
        a:
          "We are not going to give you a date we cannot keep. Opening a market means local numbers, support in this timezone and a checkout that works — and until all three exist, the honest answer is that it is not open. The waitlist is how you hear first.",
      },
    ],
  },

  // --- restaurants × Abu Dhabi ---------------------------------------------
  "restaurants/abu-dhabi": {
    lead:
      "Abu Dhabi's dining rooms fill in two distinct sittings, and a great many of the calls are about which island, which tower and which gate. Belline answers them from your own directions and takes the table request for your team to confirm.",
    description:
      "An AI receptionist for Abu Dhabi restaurants. Answers directions, hours and menu questions from your own notes and takes table requests for your team to confirm.",
    local: [
      {
        head: "Two sittings, and the phone between them",
        body:
          "Abu Dhabi eats in two waves. There is an early family sitting that starts not long after six, and a later one that fills the room again at nine, and the hour between them is when the phone rings hardest — people deciding, comparing, checking whether you can still fit them in. That hour is also when the floor is turning tables, which is to say the one hour nobody can get to the handset.",
      },
      {
        head: "Much of the call is directions",
        body:
          "In a city built across islands and podium towers, knowing the restaurant exists is not the same as knowing how to arrive at it. Which island, which building, which entrance, whether there is valet, whether the mall car park connects. On Yas and Saadiyat a guest can be four hundred metres from a table and genuinely unable to reach it. All of that is already written on your website; Belline reads it back exactly, and takes a message for anything that is not there.",
      },
      {
        head: "Corporate lunch and the group booking",
        body:
          "A capital weighted towards government and the energy companies eats lunch in groups and books it by telephone the morning of. Those calls are short, they are worth more than a couple, and they are lost to a busy line more easily than any other kind — the caller has eleven colleagues and a second restaurant already open in another tab. Past the party size you set, Belline stops taking details and hands over the date, the headcount and a number for whoever handles groups.",
      },
      {
        head: "The weeks the calendar is not normal",
        body:
          "Abu Dhabi has a handful of weekends a year — the Grand Prix on Yas, a concert season, the National Day run — where the whole city's restaurant demand moves and every reservation line is busy at once. Those are precisely the weeks a missed call costs the most, and the weeks a front-of-house team has the least chance of answering. Belline reads the hours you set, so when you change them for an event week it changes what it tells callers the same day.",
      },
    ],
    faqs: [
      {
        q: "Can it tell people which entrance to use?",
        a:
          "If you have written it down, yes, word for word — the tower, the gate, the level, the valet, whether the mall car park connects. Directions are the most-asked question on an Abu Dhabi restaurant line and the easiest one to answer badly from memory.",
      },
      {
        q: "Does it answer our WhatsApp as well as the phone?",
        a:
          "Yes, on a WhatsApp number of its own that we set up with you, reading the same hours, menu and allergen notes. Your existing WhatsApp stays exactly as it is.",
      },
      {
        q: "What happens with a group booking from an office?",
        a:
          "Past the size you set, it stops treating it as an ordinary table. It takes the company, the date, the headcount and a number, and flags it for whoever handles groups, so a person rings back about a room rather than a table appearing in the book.",
      },
      {
        q: "Can it answer in Arabic?",
        a:
          "Not yet — Belline answers in English. Arabic is more present on a business line in the capital than in Dubai, so this is a real limit here rather than a footnote, and it is better said on this page than discovered on a call.",
      },
    ],
  },

  // --- restaurants × Sharjah ------------------------------------------------
  "restaurants/sharjah": {
    lead:
      "Sharjah's restaurant phone answers families, not couples: big tables, early sittings and the same two questions about what you serve. Belline answers from your own notes and takes the booking request for your team to confirm.",
    description:
      "An AI receptionist for Sharjah restaurants. Answers family-table, timing and menu questions from your own notes, and takes booking requests for your team to confirm.",
    local: [
      {
        head: "The table is bigger and the booking is earlier",
        body:
          "A Sharjah restaurant's ordinary Friday booking is not two people at nine. It is nine people at seven, with a grandmother and a high chair, and it is made a day or two ahead rather than an hour. That changes what a booking call has to capture — the headcount, whether they need a room or a long table, whether a pram fits — and it makes the call longer at exactly the moment the room is filling.",
      },
      {
        head: "Sharjah does not serve alcohol, and you will be asked",
        body:
          "The emirate is dry, and a proportion of your callers — visitors, people driving up from Dubai, somebody planning a group dinner — will ring to ask what you do serve, whether there is a family section, whether you can do a set menu for a party. These are the questions a new restaurant here gets every day, they all have written answers, and none of them needs a manager to repeat it for the fortieth time.",
      },
      {
        head: "Two weekends in one city",
        body:
          "Sharjah's own government works Monday to Thursday with a three-day weekend from Friday, while a large share of the emirate's residents drive into Dubai and keep the Monday-to-Friday week there. For a restaurant on Al Majaz waterfront or in Al Nahda that means Friday lunch is somebody's weekend and somebody else's working day, and the phone does not have a quiet stretch you can plan around.",
      },
      {
        head: "The price question comes first here",
        body:
          "Sharjah callers ask what something costs earlier in the conversation than Dubai callers do, and they ask precisely — what is the set menu per head, is there a minimum spend on the majlis room, what does the family platter come to. A host with a full section cannot answer that from memory without getting it wrong, and getting it wrong is worse than not answering. Belline reads back what is on your list and takes a message for anything that is not on it.",
      },
    ],
    faqs: [
      {
        q: "Will it answer questions about what we serve?",
        a:
          "From your own menu and notes, word for word, including the things you get asked precisely because Sharjah is dry — what the drinks list is, whether there is a family section, what a set menu includes. Anything you have not written down becomes a message rather than a guess.",
      },
      {
        q: "Somebody rings to ask whether we deliver. What does it say?",
        a:
          "Whatever you have written down — that you deliver, that you are on a particular app, or that you do not. It reads that back and stops there. It does not take an order, take an address or put anything through to a delivery platform on your behalf.",
      },
      {
        q: "Does it work on Friday, when the emirate is on a different weekend?",
        a:
          "It answers every day, whatever the calendar. You set the hours you are open, and the calls that arrive when you are closed are taken as requests instead of voicemail, so the week starts with a list rather than a red light on a machine.",
      },
      {
        q: "Does it answer our WhatsApp as well as the phone?",
        a:
          "Yes, on a second WhatsApp number we set up with you, answering from the same menu, hours and notes as the phone line. Your existing WhatsApp is untouched.",
      },
    ],
  },

  // --- hair & beauty salons × Dubai ----------------------------------------
  "hair-salons/dubai": {
    lead:
      "A Dubai salon's phone rings from ten in the morning to ten at night, and most of it is the price list being read out loud. Belline answers it from your own list, takes the request with the stylist named, and holds your patch-test rule.",
    description:
      "An AI receptionist for Dubai salons. Answers from your price list through the evening, takes booking requests with the stylist named, and holds your rules.",
    local: [
      {
        head: "Your trading day is twelve hours long",
        body:
          "A Dubai salon in a mall is open until ten at night and often later, and the calls do not thin out at five. The evening ones are the valuable ones: somebody who has just finished work and wants tomorrow. There is no shift pattern that puts a free pair of hands next to the phone for twelve straight hours, which is why the calls a busy salon loses are the ones that come in during a blow-dry.",
      },
      {
        head: "New in the city, and asking whether you do their hair",
        body:
          "Dubai's clientele turns over constantly, and a new arrival's first call to a salon is an interview: do you have somebody who cuts curly hair, do you do keratin, have your colourists worked on this kind of blonde, is the salon ladies-only. Those are answerable from what you have written about your team and your services, and unanswerable by a voicemail. The salon that picks up gets a client for three years.",
      },
      {
        head: "Ladies-only, men's, and knowing which you are",
        body:
          "Salons here are separate establishments for women and for men, and a caller who has found you on a map does not always know which one they have reached. Getting that right in the first ten seconds saves everybody's time, and getting it wrong wastes a booking slot. Belline says what you are, as you wrote it, before anything else in the conversation.",
      },
      {
        head: "The rules will be tested, and the weeks before Eid hardest",
        body:
          "A patch test forty-eight hours before a first colour, a deposit on a long appointment, a cancellation window — every one of them gets pushed by a caller who wants tomorrow, and the pushing is worst in the days before Eid when every chair in the city is spoken for. A stylist who is also the receptionist says yes to get back to the client in front of them. Belline says the rule you wrote, takes the request on that basis, and says it again the second time.",
      },
    ],
    faqs: [
      {
        q: "Will it say whether we are a ladies-only salon?",
        a:
          "Yes, if you write it down, in your words and early in the call. What it will not do is decide who qualifies for what — anything it is unsure about goes to your team as a message rather than being ruled on by a receptionist that has never seen your floor.",
      },
      {
        q: "Can it answer at ten at night when we are still open?",
        a:
          "It answers whenever your line forwards to it, all day and all night, and it reads the hours you set when it tells somebody whether you are open. The late calls are usually the ones asking for tomorrow, which is the request you most want on your desk in the morning.",
      },
      {
        q: "Does it answer our WhatsApp as well?",
        a:
          "Yes, on a second WhatsApp number we set up with you, reading the same price list and rules. Your existing WhatsApp keeps its history and its clients and is not touched.",
      },
      {
        q: "Can it answer in Arabic?",
        a:
          "Not yet — Belline answers in English. Most Dubai salon calls are in English and this is workable for most salons here, but if your clients expect Arabic on the line it is the honest limit today rather than something to plan around.",
      },
    ],
  },

  // --- hair & beauty salons × Abu Dhabi ------------------------------------
  "hair-salons/abu-dhabi": {
    lead:
      "Abu Dhabi salon clients book a named stylist, often weeks ahead, and ring before eight in the morning to do it. Belline answers from your price list, takes the request with the stylist named, and holds the rules your desk gets talked out of.",
    description:
      "An AI receptionist for Abu Dhabi hair and beauty salons. Answers from your price list, takes requests naming the stylist your client wants, and holds your salon's rules.",
    local: [
      {
        head: "The call comes before you open",
        body:
          "The capital's working day starts before eight, so a client sorting out her week rings a salon on the way into the office — an hour before the first stylist has arrived and the shutters are up. Those calls do not come back later in the day; the person who made them is in a meeting by nine. A line that is answered from the first ring of the morning is worth more here than an extra evening hour.",
      },
      {
        head: "Clients book a person, not a chair",
        body:
          "Loyalty to a particular stylist runs deep in Abu Dhabi, and a booking that does not record who the client wants is a booking the desk has to ring back about. It is also the one thing a client will not compromise on: told their stylist is unavailable, a good proportion will move the appointment rather than the person. Belline takes the name with the service and the day, and leaves it to your team to say who is free, because it has not looked.",
      },
      {
        head: "Weddings, henna nights and the long appointment",
        body:
          "A large share of a capital salon's revenue arrives as a booking for an occasion — a wedding party, a henna night, a family event where six people need to be finished before a particular hour. Those enquiries are conversations about timing and trials and a price, not requests. Belline captures the date, the headcount and a number and flags them, rather than taking eight individual appointments that nobody can actually staff.",
      },
      {
        head: "Privacy is part of the service",
        body:
          "A number of Abu Dhabi salons run private rooms or a ladies-only floor, and clients ring specifically to establish what is screened from what before they will book. That is a question with a written answer and no judgement in it. Belline reads back what you wrote about your rooms and your policy, does not embellish it, and hands anything it is unsure about to your team.",
      },
    ],
    faqs: [
      {
        q: "Can a client ask for a particular stylist?",
        a:
          "Yes, and it is the first thing Belline captures after the service. It takes the stylist's name and the days that suit, and your team confirms the time. It does not tell the client whether that stylist is free — it has no view of your diary.",
      },
      {
        q: "Will it answer before we open in the morning?",
        a:
          "It answers whenever your line is forwarded to it, including the hour before anyone arrives. It tells the caller your opening hours as you set them, and takes the request so the desk starts the day with it rather than with a voicemail light.",
      },
      {
        q: "Can it say what is in a private room or on a ladies-only floor?",
        a:
          "It reads back what you have written about your rooms and your policy, in your words, and nothing beyond it. Deciding who is offered what stays with your team, and anything Belline is unsure about goes to them as a message.",
      },
      {
        q: "A client wants us to come to her instead. What happens?",
        a:
          "Home visits are common here and they are yours to agree, not Belline's. It takes the request — where, when, what she wants done — and says your team will come back to her. It does not promise a visit, a time or a price for one.",
      },
    ],
  },

  // --- dental clinics × Dubai ----------------------------------------------
  "dental-clinics/dubai": {
    lead:
      "Two questions fill a Dubai dental line: do you take my insurance, and can somebody see me tonight. Belline answers the first from your own list of insurers, takes the second as an urgent message for your clinical team, and answers nothing clinical at all.",
    description:
      "An AI receptionist for Dubai dental clinics. Answers insurance and practical questions from your own notes, and sends anything clinical to a person.",
    local: [
      {
        head: "The insurance question comes before the appointment",
        body:
          "Health cover is a condition of a residence visa in Dubai, so almost every patient who rings has a card in their hand and the same opening question: do you take this one, is a check-up covered, do I need an approval first. Getting that wrong costs a chair — the patient arrives, the claim is refused, and you have an argument at the front desk instead of a treatment. The list of insurers you work with is already written down. Belline reads it back exactly and takes a message for anything not on it.",
      },
      {
        head: "The expatriate patient is always a new patient",
        body:
          "Dubai's population moves, and a practice here spends much of its phone time on people who have just arrived, have no records with anybody in the country, and are describing a treatment they had done somewhere else. They ring asking to book the treatment. What they can book is an examination, and holding that line politely on every single call is a front desk that is never rushed — which no Dubai practice's front desk is at five in the afternoon.",
      },
      {
        head: "Pain arrives after the tower closes",
        body:
          "A clinic on the twelfth floor of a tower in Business Bay or Jumeirah has a reception desk that goes home and a phone that does not. Toothache at ten at night reaches either your answering machine or the practice with the longer hours, and in a city where patients choose a clinic by whoever answers, that is how a practice loses somebody it has treated for years. Belline takes the call, takes the patient's own words and their number, and marks it urgent for your clinical team. Where your plan includes live transfer and you have given it a number, it puts the call through to a person instead.",
      },
      {
        head: "What a Dubai clinic must not say on the phone",
        body:
          "Dental practices here are licensed and inspected, and reception is reception: not a diagnosis, not a prognosis, not advice about medication. Belline is built the same way round. Asked whether the swelling is normal, it says it is not able to advise, and it does not soften that into an opinion to be helpful. In a medical emergency it gives the instruction you set — 998 for an ambulance, or the nearest emergency department — and takes no appointment request at all.",
      },
    ],
    faqs: [
      {
        q: "Can it tell a patient whether we take their insurance?",
        a:
          "It reads back the insurers you have written down, as you wrote them. What it will not do is confirm that a particular treatment is covered under a particular policy, because that depends on the plan and on an approval — that becomes a message for your desk, with the patient's number and the insurer they named.",
      },
      {
        q: "What happens to a pain call at ten at night?",
        a:
          "It is answered rather than left to ring out. Belline does not diagnose and does not offer a slot. It captures the patient's number and exactly what they described and marks the message urgent. Where your plan includes live transfer and you have given it a team number, it puts the call through to a person instead; the pricing below says which plans carry it.",
      },
      {
        q: "Will it book the treatment a new patient asks for?",
        a:
          "No. It takes a request for an assessment and explains what the first visit involves in the words you wrote. A patient arriving in Dubai who wants a crown booked over the phone is asked in for an examination, every time, without being made to feel refused.",
      },
      {
        q: "Does it answer our WhatsApp as well as the phone?",
        a:
          "Yes, on a second WhatsApp number we set up with you. Treat both as reception rather than as a clinical record: a name, a number and when somebody would like to come, with anything clinical marked for your team.",
      },
    ],
  },

  // --- dental clinics × Abu Dhabi ------------------------------------------
  "dental-clinics/abu-dhabi": {
    lead:
      "An Abu Dhabi practice's phone starts before its reception desk does, and a good share of the calls are about cover and approvals. Belline answers from your own notes, takes the appointment request, and hands every clinical question to a person.",
    description:
      "An AI receptionist for Abu Dhabi dental clinics. Answers cover and practical questions from your notes from the first call of the day, clinical ones never.",
    local: [
      {
        head: "Calls before eight, from people who are already at work",
        body:
          "Government and corporate Abu Dhabi is at a desk before eight, and a patient sorting out an appointment does it then, before the day takes over. A practice that opens at nine misses an hour of the most decisive calls it will get — people who have already decided to book and are simply looking for somebody to pick up. Belline answers from the first ring, takes the request, and your team confirms the time when it arrives.",
      },
      {
        head: "Cover, approvals and the question behind the question",
        body:
          "Patients in the capital ring holding a card and asking whether you take it, whether a treatment needs an approval first, and what the excess will be. The first of those has a written answer, the other two depend on the plan and on the clinic's own process. Belline reads back the list of insurers you gave it and takes a message with the insurer's name and the patient's number for the rest, rather than producing a reassurance your desk then has to withdraw.",
      },
      {
        head: "Families book together and change together",
        body:
          "A large part of the capital's dentistry is family dentistry — three children in one afternoon, a parent who moves the whole block when one of them has an exam. Those calls are logistics rather than clinical, they are long, and they arrive while your nurse is chairside. Belline takes the changes as messages with the appointments the patient thinks they have, so the desk can free the chairs instead of finding them empty.",
      },
      {
        head: "Reception is not a clinician, and here that line is watched",
        body:
          "Practices in Abu Dhabi are licensed by the emirate's health regulator, and what a non-clinical member of staff may say to a patient is bounded. Belline refuses clinical questions out loud instead of hedging: told about pain after a filling it says it cannot advise, takes the patient's own words and number, and marks it urgent. In an emergency it gives the instruction you set — 998 for an ambulance, or the nearest emergency department — and takes no appointment request.",
      },
    ],
    faqs: [
      {
        q: "Will it answer before our reception desk opens?",
        a:
          "Yes, as soon as your line forwards to it. That is most of the argument for it here: the capital's calls arrive before eight, and a request captured then is on the desk when the first member of staff sits down.",
      },
      {
        q: "Can it confirm whether a treatment is covered?",
        a:
          "No. It reads back the insurers you take, from your own list, and takes a message with the insurer's name for anything about a specific treatment or an approval. Cover depends on the plan, and a wrong yes on the phone is a refused claim at the desk.",
      },
      {
        q: "Can a parent move three appointments in one call?",
        a:
          "They can say all of it, and Belline captures it as a message with the appointments they believe they have and the times they want instead. Your team makes the changes in your own system, because nothing moves in your day without a person moving it.",
      },
      {
        q: "What does it do with a clinical question?",
        a:
          "It says plainly that it cannot advise, and it does not offer a cautious opinion in place of an answer. It takes the patient's own words and their number and marks the message urgent for your clinical team.",
      },
    ],
  },

  // --- dental clinics × Sharjah --------------------------------------------
  "dental-clinics/sharjah": {
    lead:
      "A Sharjah practice's patients are mostly commuting to Dubai, which means they ring before seven and after eight and want to know the price before anything else. Belline answers both ends of the day from your own notes and takes nothing clinical.",
    description:
      "An AI receptionist for Sharjah dental clinics. Answers price and practical questions from your notes at both ends of the commute, clinical calls never.",
    local: [
      {
        head: "The commute decides your appointment book",
        body:
          "A large share of Sharjah's working population drives into Dubai, leaves before the roads fill and gets back after eight. They cannot come at two in the afternoon and they will not ring at two either — they ring on the way, at either end of the day, from a car. A practice here that only answers between nine and six is answering at the exact hours its patients are unreachable, and the calls it misses are the appointments it would have filled.",
      },
      {
        head: "Price is the first question, not the fourth",
        body:
          "Sharjah callers ask what something costs early and precisely, and they are often comparing you with a Dubai clinic they could reach on the way home. An examination fee, a scale and polish, what a first visit includes — all of that is written down somewhere in your practice already. Belline reads it back exactly, and a treatment cost that depends on the examination is not guessed at: it becomes a message for your desk.",
      },
      {
        head: "The appointment that has to hold four people",
        body:
          "A great deal of dentistry here is family dentistry, and a working parent books it for the one day nobody has school or an office. So the call is not whether Tuesday is free, it is whether you can see three of them on Saturday morning and whether the youngest needs an appointment of her own — a question about your book, asked by somebody in a car, who will ring the next practice if nobody picks up. Belline takes all of it, in the caller's own words, and your desk decides what fits.",
      },
      {
        head: "Reception, not advice, whichever regulator asks",
        body:
          "Clinics in Sharjah are licensed by the federal health ministry, and the boundary is the same one every dental practice works to: reception takes appointments, clinicians answer clinical questions. Belline refuses out loud rather than hedging, takes the patient's own words and number and marks them urgent, and in an emergency gives the instruction you set — 998 for an ambulance, or the nearest emergency department — with no appointment request taken.",
      },
    ],
    faqs: [
      {
        q: "Will it answer at half past six in the morning?",
        a:
          "It answers whenever your line is forwarded to it, and in Sharjah that is the point: your patients ring from the car on the way into Dubai and again on the way back. It tells them your hours as you set them and takes the request either way.",
      },
      {
        q: "Can it quote our prices?",
        a:
          "The ones you have written down, in the words you wrote them. An examination fee, yes. What a course of treatment will come to, no — that depends on the examination and it becomes a message for your desk with the patient's number.",
      },
      {
        q: "Which week does it work — Sharjah's or Dubai's?",
        a:
          "Whichever one you set, and it answers on every day of it. The useful part here is the closed days: those calls are taken as requests instead of voicemail, so the practice opens to a list rather than a machine.",
      },
      {
        q: "Does it give any clinical advice at all?",
        a:
          "None. Asked whether pain after a filling is normal it says it cannot advise, takes exactly what the patient said with their number, and marks it urgent for your clinical team. It does not soften a refusal into an opinion.",
      },
    ],
  },

  // --- aesthetic & medical clinics × Dubai ---------------------------------
  "aesthetic-clinics/dubai": {
    lead:
      "A Dubai clinic's phone line is advertising, and what a clinic may claim here is regulated. Belline answers from the approved information you wrote, takes the consultation request, and says nothing about whether a treatment will suit anybody.",
    description:
      "An AI receptionist for Dubai aesthetic and medical clinics. Answers only from your approved information, takes consultation requests, and never assesses suitability.",
    local: [
      {
        head: "What is said on the phone is what you advertised",
        body:
          "A clinic in Dubai is licensed by whichever regulator its address falls under, and how it may promote itself — what it may claim, what it may promise — is bounded by that licence. A receptionist improvising a result on the telephone is the clinic making a claim, whatever anybody intended. Belline says only what you wrote for it to say. Where there is nothing written, it takes a message rather than filling the gap with something encouraging.",
      },
      {
        head: "Enquiries arrive in the evening, from people who are ready",
        body:
          "People research a treatment after work and ring while they are still thinking about it, which in Dubai means nine or ten at night. A clinic whose desk closed at five meets that caller with an answering machine on the one evening they were ready to act, and the caller rings the next clinic on the list. Belline takes the enquiry, captures the treatment they asked about, and puts it in front of your team before the morning.",
      },
      {
        head: "Every enquiry is a consultation, and nobody rings asking for one",
        body:
          "Callers ask to book filler, or a course of laser, or a price for a package. What they can book is an assessment, because whether any of it suits them is a clinician's decision. Redirecting that on every call without sounding like a refusal is skilled work, and it is skilled work done forty times a day. Belline says what the consultation covers and how long it runs from your notes, takes the request, and your team confirms the time.",
      },
      {
        head: "Some of the calls are not about a treatment at all",
        body:
          "Occasionally somebody describes something that needs a doctor now — a reaction, a complication after a procedure somewhere else, something that is nothing to do with aesthetics. A clinic's telephone earns its keep on those calls and no others, and what it has to do is stop: no appointment, no reassurance, nothing that sounds like advice. Belline directs those callers to emergency care using the instruction you gave it for the UAE and takes no request at all.",
      },
    ],
    faqs: [
      {
        q: "Will it tell a caller a treatment will work for them?",
        a:
          "No, and it does not hint at it either. It describes the treatment from the information you approved, says the consultation is where suitability is decided, and takes a request for one. Anything beyond what you wrote becomes a message for a clinician.",
      },
      {
        q: "Can it quote a price for a course of treatment?",
        a:
          "It reads back the prices you have written down and names the consultation as the thing that settles the rest. It does not estimate a course, build a package or discount anything, because all three are claims a clinic has to stand behind.",
      },
      {
        q: "What does it do with an urgent call?",
        a:
          "It stops being reception. The caller hears the emergency instruction you set for the UAE — 998 for an ambulance, or the nearest emergency department — and no appointment request is taken, because an appointment would be the wrong answer at that moment.",
      },
      {
        q: "Does it answer our WhatsApp as well as the phone?",
        a:
          "Yes, on a second WhatsApp number we set up with you, reading the same approved information. Anything written to a patient is the clinic's words either way, which is exactly why Belline uses yours and not its own.",
      },
    ],
  },

  // --- aesthetic & medical clinics × Abu Dhabi -----------------------------
  "aesthetic-clinics/abu-dhabi": {
    lead:
      "In the capital a first enquiry is often anonymous: a caller who wants to know what a treatment involves before giving a name. Belline answers that from your approved information, takes the consultation request when they are ready, and assesses nothing.",
    description:
      "An AI receptionist for Abu Dhabi aesthetic and medical clinics. Answers from your approved information, takes consultation requests, and never judges suitability.",
    local: [
      {
        head: "The first call is a question, not a booking",
        body:
          "Abu Dhabi callers frequently want to understand a treatment before they will identify themselves — what it involves, how long the recovery is, whether anybody would know. A receptionist under time pressure treats that call as a lead to be closed, and loses it. Belline answers the question from what you wrote, at whatever length the caller wants, and asks for a name only when they ask to come in. Nobody is pushed, and the enquiry is still captured.",
      },
      {
        head: "Discretion is the service, and the phone is part of it",
        body:
          "A capital clientele expects privacy as a matter of course: no message left with a receptionist who might know somebody, no clinic name announced when they ring back, no detail in a voicemail. Belline takes what the caller chose to say and nothing more, and every conversation reaches your team as a summary and a transcript in your own inbox rather than a note on a pad at the front desk. Belline does not record the audio of the calls it answers.",
      },
      {
        head: "Both ends of a government day",
        body:
          "The capital's working day starts before eight and the calls that matter arrive at either end of it — before the desk is staffed and after it has gone home. Those two windows are where a clinic's enquiries actually land, and they are precisely the hours no clinic staffs a telephone. What changes with Belline is not that somebody is there all day; it is that the two hours you were never going to cover are covered.",
      },
      {
        head: "Licensed here means bounded here",
        body:
          "Clinics in the emirate are licensed by Abu Dhabi's health regulator, and what may be said about a treatment is part of what is licensed. Belline says what you approved, names the consultation as the place suitability is decided, and refuses to be talked into an opinion by a caller who wants reassurance. Anything that sounds urgent is directed to emergency care with the instruction you set, and no request is taken.",
      },
    ],
    faqs: [
      {
        q: "Will it push a caller for their name?",
        a:
          "No. It answers what they asked from your approved information, and asks for a name and a number when the caller wants to come in. An enquiry that stays anonymous still reaches your team as a record of what was asked.",
      },
      {
        q: "Who can see what a caller said?",
        a:
          "Your team. Every conversation arrives as a summary and a full transcript in your own inbox, so you can read exactly what was asked and what Belline answered. Belline does not record the audio of the calls it answers.",
      },
      {
        q: "Does it give preparation or aftercare instructions?",
        a:
          "Only yours, word for word, and it does not adapt them to anything a caller says about their own health — adapting them would be advice, and advice is a clinician's.",
      },
      {
        q: "What happens if somebody describes a complication?",
        a:
          "It stops being reception and directs them to emergency care using the instruction you gave it for the UAE. No appointment request is taken, and what they said reaches your clinical team as an urgent message with their number.",
      },
    ],
  },

  // --- aesthetic & medical clinics × Sharjah -------------------------------
  "aesthetic-clinics/sharjah": {
    lead:
      "Sharjah clinics are asked two things before anything else: is the practitioner a woman, and what does it cost. Belline answers both from what you wrote, takes the consultation request, and decides nothing about whether a treatment suits anybody.",
    description:
      "An AI receptionist for Sharjah aesthetic and medical clinics. Answers practitioner and price questions from your own notes and takes consultation requests for your team.",
    local: [
      {
        head: "The question about who will be treating them comes first",
        body:
          "A large proportion of enquiries to a Sharjah clinic begin with whether a female doctor or therapist is available, whether the room is private, and who else is on the floor at that time. These are questions with written answers and no judgement in them, and they decide whether the caller books at all. A desk that has to check and ring back has usually lost the call by then. Belline reads back what you wrote about your team and your rooms, and takes a message for anything it was not told.",
      },
      {
        head: "Priced against Dubai, forty minutes away",
        body:
          "Sharjah callers compare, and the clinic they compare you with is one they could drive to on a Friday. So the price question comes early and it comes precisely — per session, per area, what the package includes, whether the consultation is charged. Belline reads back the figures you have written down and refuses to produce one you have not. A price invented on the phone is a complaint at the counter later, and in a market this referral-driven that travels.",
      },
      {
        head: "The enquiry arrived by word of mouth, and it is careful",
        body:
          "Most of what reaches a Sharjah clinic comes through somebody who has been. That is worth more than any advertisement and it makes the first call a delicate one: the caller has heard a name, may not want to say whose, and is deciding in the first thirty seconds whether this is a place that will be discreet. A line that rings out, or a receptionist who asks who referred them in front of a waiting room, loses that call and the next three it would have brought. Belline takes what the caller chose to say and no more, and it reaches your team as a written record rather than a conversation anybody overheard.",
      },
      {
        head: "Reception, and the federal line it works to",
        body:
          "Clinics in Sharjah are licensed by the federal health ministry, and reception is reception: no diagnosis, no assessment of whether a treatment suits somebody, no medical advice, and nothing said about a result. Belline describes what a treatment is from your approved notes, names the consultation as where suitability is decided, and sends anything urgent to emergency care with the instruction you set, taking no request at all.",
      },
    ],
    faqs: [
      {
        q: "Can it say whether a female practitioner is available?",
        a:
          "It reads back what you have written about your team and your rooms, in your words. It does not look at a rota or promise that a particular person will be there on a particular day — that is your team's to confirm, and anything Belline was not told becomes a message.",
      },
      {
        q: "Will it quote a price per session?",
        a:
          "The prices you have written down, exactly as written, with the consultation named as the thing that settles the rest. It will not estimate a package or a course, and it will not discount to keep somebody on the phone.",
      },
      {
        q: "Does it answer on Friday?",
        a:
          "It answers every day, and it tells callers the hours you set. In an emirate where the weekend starts on Friday for some of your clients and on Saturday for others, the calls on your closed days are taken as requests rather than voicemail.",
      },
      {
        q: "Will it tell somebody a treatment is suitable for them?",
        a:
          "No. That is an assessment and an assessment is a clinician's. It explains what the treatment is from your own notes and takes a request for a consultation, which is where the question actually gets answered.",
      },
    ],
  },

  // --- real estate × Dubai --------------------------------------------------
  "real-estate/dubai": {
    lead:
      "A Dubai portal enquiry rings three agencies and talks to whoever answers. Belline answers yours while the agents are at viewings, captures the enquiry against the listing it is about, and never discusses the price.",
    description:
      "An AI receptionist for Dubai real estate agencies. Captures portal enquiries against the listing, takes viewing requests for an agent to confirm, and never negotiates.",
    local: [
      {
        head: "The listing is a telephone number with a photograph attached",
        body:
          "Every property advertised in Dubai carries a permit number and a phone line, and a buyer working down a page of results dials three of them in five minutes. They are not leaving voicemails. Whichever agency answers with something specific about the unit — the size, the view, the service charge, whether it is vacant — has the conversation, and the other two have a missed call. Your agents are driving between viewings at exactly that hour.",
      },
      {
        head: "Off-plan launches make the phone unusable for a week",
        body:
          "When a major developer releases a tower, the enquiry volume for anyone selling in that area goes vertical for several days, and it arrives alongside the ordinary flow of secondary-market and rental calls. There is no staffing answer to a week like that. Belline takes every one of them, captures which project and what the caller is after, and leaves your brokers free to work the ones that are already qualified.",
      },
      {
        head: "The questions are about paperwork as often as property",
        body:
          "What is the service charge, is it Oqood registered, is the seller ready to sign a Form F, what is the agency fee, is the unit mortgageable. Some of that is on the listing and Belline reads it back exactly. The rest — mortgage eligibility, transfer costs, what something will be worth — is advice, and advice comes from a registered broker in your team. Belline takes the question in the caller's own words with their number and marks it for a person.",
      },
      {
        head: "Tenants ring the same number as buyers",
        body:
          "The line printed on a listing in Marina or Business Bay is also the line a tenant of a managed unit rings when the air conditioning fails in August. Both calls are real, one needs a broker and one needs maintenance, and mixing them buries the second under the first. Belline takes the tenant call as a message for property management — the unit, the problem, a number — so it arrives as its own item rather than behind six viewing requests.",
      },
    ],
    faqs: [
      {
        q: "Will it know whether a unit is still available?",
        a:
          "Only from what you have given it. It is not connected to your CRM or to a portal, so it reads back the listings you provided and takes the enquiry; your agent confirms. That is the same order of events as a portal lead today, with the enquiry captured rather than missed.",
      },
      {
        q: "Can it talk about the price?",
        a:
          "It states the asking price on the listing as you wrote it, and that is the end of it. Anybody wanting to discuss the number becomes a message for the agent — a negotiation opened by a receptionist is one you did not choose to start.",
      },
      {
        q: "Will it answer mortgage or investment questions?",
        a:
          "No. Mortgages, transfer fees, visas and what a property will be worth are advice from a licensed broker, not reception. Belline takes the question in the caller's own words with their number and flags it for a person in your team.",
      },
      {
        q: "Can it book a viewing for Saturday?",
        a:
          "It takes the request — the property, the days and hours that suit, and whether they are buying, renting or investing — and your agent confirms. Belline never says an agent is free, because it has no idea where any of them will be on Saturday.",
      },
    ],
  },

  // --- real estate × Abu Dhabi ---------------------------------------------
  "real-estate/abu-dhabi": {
    lead:
      "Abu Dhabi property enquiries come from people who already know which island they want and need to know whether you can show it. Belline answers while your brokers are out, captures the enquiry against the listing, and leaves the advising to them.",
    description:
      "An AI receptionist for Abu Dhabi real estate agencies. Captures enquiries against the listing, takes viewing requests for a broker to confirm, and never gives advice.",
    local: [
      {
        head: "The investment zones are the whole conversation",
        body:
          "Freehold ownership for foreign buyers in Abu Dhabi is confined to designated investment zones — Al Reem, Yas, Saadiyat and the rest — and a large share of enquiries start from a caller who has worked that out and wants to know what you have where. That is an answerable question from your own listings and an unanswerable one from a voicemail. Belline reads back what you gave it and captures what the caller is looking for, by area and by budget.",
      },
      {
        head: "Leases are registered, and tenants ring about it",
        body:
          "Tenancy contracts in the emirate are registered, and a proportion of the calls to any agency here are about the paperwork rather than the property: a renewal, a contract copy, a name on a document, something needed before a utility connection. None of it needs a sales broker and all of it clogs their line. Belline takes it as a message for whoever handles administration, with the unit and what is actually needed.",
      },
      {
        head: "The call arrives before your office opens",
        body:
          "Abu Dhabi works early. An enquiry made at half past seven from a car park is a real enquiry from somebody who has already looked at the listing, and an agency whose phone starts at nine has spent an hour and a half not answering its most decided callers. Belline answers from the first ring, captures the enquiry against the listing reference, and your broker rings back knowing which property it is about.",
      },
      {
        head: "Brokers advise, reception does not",
        body:
          "Agents in Abu Dhabi are registered, and advice about a purchase, a mortgage, a fee or a return is theirs to give. Belline states the price and the details on the listing as you wrote them, and every question past that — what the transfer will cost, whether a buyer qualifies, what a unit might rent for — is taken in the caller's own words with a number and marked for a broker, rather than answered helpfully and wrongly.",
      },
    ],
    faqs: [
      {
        q: "Can it tell a foreign buyer where they can buy?",
        a:
          "It can read back what you have written about your own listings and where they are. It does not interpret ownership rules for a caller, because that is advice and it belongs to a registered broker in your team. The question is captured and marked for one.",
      },
      {
        q: "What happens to a tenant ringing about a contract?",
        a:
          "It becomes a message for whoever handles administration, with the unit, what the tenant needs and their number — rather than a voicemail on a sales broker's line behind four viewing requests.",
      },
      {
        q: "Will it answer before the office opens?",
        a:
          "Yes, whenever your line forwards to it. In a city that starts before eight, that hour is where a good share of the enquiries are, and the enquiry is on the broker's screen when they sit down.",
      },
      {
        q: "Does it negotiate or discuss fees?",
        a:
          "No. It reads the asking price and the details on the listing and stops. Fees, offers and anything about the money become a message for the broker, with the caller's number and what they said.",
      },
    ],
  },

  // --- real estate × Sharjah ------------------------------------------------
  "real-estate/sharjah": {
    lead:
      "Sharjah's property calls are mostly about renting a family flat, made by somebody who works in Dubai and can only view at the weekend. Belline answers at both ends of the commute, captures what they need, and leaves the advising to your brokers.",
    description:
      "An AI receptionist for Sharjah real estate agencies. Answers rental enquiries from your own listings at both ends of the commute and takes viewing requests for a broker.",
    local: [
      {
        head: "This is a rental market, and the questions are different",
        body:
          "Most of what a Sharjah agency answers is not a sale. It is a family looking for two or three bedrooms in Al Nahda or Al Majaz, asking what the annual rent is, how many cheques it can be split into, whether the building takes families, what the service charges are and whether parking is included. Those questions all have written answers, they repeat on every call, and none of them needs a broker to say them out loud.",
      },
      {
        head: "Your caller is on the Dubai road",
        body:
          "A large share of Sharjah tenants work in Dubai, which decides everything about when they ring and when they can view. The calls come before seven in the morning and after eight at night, from a car, and the viewing has to be at the weekend. An agency answering only during office hours is available exactly when its market is stuck on Ittihad Road. Belline takes the call at either end and captures the days and hours they could actually come.",
      },
      {
        head: "Two weekends, and viewings on both",
        body:
          "The emirate's own government week runs Monday to Thursday with a three-day weekend, while the commuters keep Monday to Friday. For viewings that means Friday is a free day for some of your callers and a working day for others, and a Saturday slot that suits one household is useless to the next. Belline captures which days the caller can actually come rather than offering one, and your broker builds the route.",
      },
      {
        head: "Renewals and maintenance ring the same line",
        body:
          "An agency managing property here answers as many calls from existing tenants as from prospective ones: a renewal, a cheque date, a broken water heater. Those are not brokerage calls and they should not sit in a brokerage queue. Belline takes them as messages for whoever handles management, with the unit and the actual problem, so the leasing team's line stays for people who want to rent something.",
      },
    ],
    faqs: [
      {
        q: "Can it say how many cheques the rent can be split into?",
        a:
          "If you have written it for that property, yes, exactly as you wrote it. If you have not, it takes a message with the unit and the caller's number rather than offering terms on your behalf — payment terms are a negotiation and Belline does not negotiate.",
      },
      {
        q: "Will it answer at half past six in the morning?",
        a:
          "It answers whenever your line is forwarded to it. A leasing office is staffed from nine, and the people who want to rent from it are on the Dubai road at seven and back after eight — so the two hours that decide the week are the two hours nobody is there.",
      },
      {
        q: "How does it handle a viewing request?",
        a:
          "It captures the property, the days and hours the caller could come and whether they are renting or buying, and your broker confirms. It never offers a time, because it does not know where your brokers will be on Saturday morning.",
      },
      {
        q: "What about a tenant with a maintenance problem?",
        a:
          "It becomes a message for whoever handles property management, with the unit, the problem and the number — not a voicemail behind the day's viewing requests on a leasing agent's phone.",
      },
    ],
  },
};

/** The pair copy for a combination, or null when nobody has written it yet. */
export function seoPair(vertical: string, city: string): PairCopy | null {
  return SEO_PAIRS[`${vertical}/${city}`] ?? null;
}

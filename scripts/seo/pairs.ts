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
      "A Dubai dinner service does not start at seven and finish at nine — it starts late and runs long, and the phone runs with it. Belline answers through the whole of it, takes the table request for your team to confirm, and answers on WhatsApp too, because that is where half your guests already are.",
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
    ],
  },

  // --- hair & beauty salons × Sharjah -------------------------------------
  "hair-salons/sharjah": {
    lead:
      "A Sharjah salon answers to two different weeks at once: the emirate's four-day government week, and the Monday-to-Friday one that half its clients work in Dubai. Belline answers on both, from your own price list, and does not get argued out of a patch test.",
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
          "The Sharjah-to-Dubai drive is the fact that organises the day here. Clients who do it are out before your salon opens and back after it is busy, so the calls asking for a Thursday evening slot arrive at eight at night, and the calls asking about Saturday arrive on Friday. A line that is only answered during trading hours misses the half of the conversation that happens on either side of them.",
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
          "No. Belline answers your existing Sharjah number: you set call forwarding on the line you already have, and nothing changes for anyone ringing it. Your number stays on your sign, your Instagram and your Google listing.",
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
          "Belline is reception, so it does not trage. It would give the instruction you set it for urgent calls, take the patient's number and exactly what they said, and mark it for your clinical team. Deciding that a caller belongs with 111 rather than with you is a clinical judgement and stays with a person.",
      },
      {
        q: "When will you open in the United Kingdom?",
        a:
          "We are not going to give you a date we cannot keep. Opening a market means local numbers, support in this timezone and a checkout that works — and until all three exist, the honest answer is that it is not open. The waitlist is how you hear first.",
      },
    ],
  },
};

/** The pair copy for a combination, or null when nobody has written it yet. */
export function seoPair(vertical: string, city: string): PairCopy | null {
  return SEO_PAIRS[`${vertical}/${city}`] ?? null;
}

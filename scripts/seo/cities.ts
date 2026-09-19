/**
 * What is true about a city, for the location landing pages.
 *
 * The city half of `/ai-receptionist/<vertical>/<city>`. Everything in here
 * has to be a fact a resident of that city would nod at and a stranger could
 * check — a working week, a licensing body, an emergency number, the languages
 * you actually hear on a phone line there. None of it is a statistic, because
 * we have not measured anything, and a made-up number about a city is the
 * easiest lie on a page like this to tell and the hardest to take back.
 *
 * **The constraint that shapes this file.** Belline is live in the UAE and
 * nowhere else: `src/lib/markets.ts` has AE `live`, and GB and IE `not-yet`,
 * and the checkout refuses a market that is not live. So a city carries its
 * `market`, and every page built for a city whose market is not live is a
 * waitlist page — the same pattern the German pages already use
 * (public/landing.de.html): the substance stays, the buy button does not
 * exist, and no price in the local currency appears anywhere on it.
 * scripts/check-seo.ts fails the build if a buy CTA ever reaches one.
 *
 * Adding a city: add an entry here, write its pairs in scripts/seo/pairs.ts,
 * and list the combinations in scripts/seo/matrix.ts. Nothing else. See
 * docs/seo-pages.md.
 */

import type { Market } from "../../src/lib/markets";

export interface SeoCity {
  slug: string;
  /** "Dubai" — as it reads in "AI receptionist for restaurants in Dubai". */
  name: string;
  /** "in Dubai" / "in the City of London" — the preposition phrase, if it is irregular. */
  inName?: string;
  /** The market this city sits in. Decides buy CTA versus waitlist, everywhere. */
  market: Market;
  /** "the UAE", "England", "Ireland" — for the sentence that names the country. */
  country: string;
  /** IANA zone, and whether the clocks move. Both are operationally real. */
  timezone: string;
  clocksChange: boolean;
  /**
   * The languages callers on a business line in this city actually use.
   *
   * A fact about the city, never a claim about Belline: Belline answers in
   * English, and the page says so in the same breath (the hero's language line
   * is written from the language registry and its flags, exactly as it is on
   * the landing page — src/lib/site-flags.ts).
   */
  languages: string;
  /** The working week and the hours a business here actually keeps. */
  week: string;
  /** When this city's phones ring hardest, and why. */
  peak: string;
  /** How people in this city expect to reach a business. */
  habits: string;
  /** What a caller here is told in an emergency — the number Belline is given. */
  emergency: string;
  /** Real districts, for copy that sounds like somebody has been there. */
  districts: string[];
  /** City hub (/ai-receptionist/in/<slug>) copy. */
  hub: { title: string; description: string; headline: string; lead: string };
  /** One paragraph on what a phone line in this city is like, for the hub. */
  intro: string;
}

const DUBAI: SeoCity = {
  slug: "dubai",
  name: "Dubai",
  market: "AE",
  country: "the UAE",
  timezone: "Asia/Dubai",
  clocksChange: false,
  languages:
    "English is the working language of most Dubai businesses, and Arabic is the official one. On a busy reception line you will also hear Hindi, Urdu, Malayalam and Tagalog, because that is who lives and works here. Belline answers in English.",
  week:
    "Since January 2022 the UAE working week has run Monday to Friday, with the weekend on Saturday and Sunday and a shortened Friday in the public sector. Retail, salons and restaurants keep their own hours on top of that, and plenty of them are open seven days.",
  peak:
    "Two peaks, not one: late morning, and again from about seven in the evening when people are out of the office. Dubai eats and shops late, so an eight o'clock call is an ordinary call here rather than an after-hours one. During Ramadan the evening peak moves to after iftar and gets sharper.",
  habits:
    "WhatsApp is not a fallback in the UAE, it is the default. Customers expect to message a business the same way they message a friend, and a number that only rings loses the ones who would rather type. Belline answers a WhatsApp number of its own alongside the phone.",
  emergency: "998 for an ambulance, or the nearest emergency department",
  districts: ["Dubai Marina", "Business Bay", "Jumeirah", "Downtown", "Al Quoz", "Deira"],
  hub: {
    title: "AI receptionist in Dubai — Belline",
    description:
      "An AI receptionist for Dubai businesses. It answers your phone, WhatsApp and website from your own information and takes requests for your team to confirm.",
    headline: "A Dubai phone line does not stop at five.",
    lead:
      "Dubai works Monday to Friday, eats late, and messages on WhatsApp. Belline answers your phone and your WhatsApp from your own information, through the evening and through the weekend.",
  },
  intro:
    "Dubai is a city where the working day and the trading day are different things. Offices run Monday to Friday and close in the late afternoon; the salons, clinics and restaurants those office workers ring are open long after that, and busiest exactly when there is nobody free at the desk. Add a customer base that would rather send a WhatsApp than wait on hold, and the calls a Dubai business loses are not the ones it turned down — they are the ones it never heard.",
};

const ABU_DHABI: SeoCity = {
  slug: "abu-dhabi",
  name: "Abu Dhabi",
  market: "AE",
  country: "the UAE",
  timezone: "Asia/Dubai",
  clocksChange: false,
  languages:
    "English and Arabic, with Arabic noticeably more present on a business line here than in Dubai — Abu Dhabi is the capital and a great deal of the work is government and government-adjacent. Hindi, Urdu, Malayalam and Tagalog are common too. Belline answers in English.",
  week:
    "Monday to Friday, weekend on Saturday and Sunday, with a short Friday across the public sector. In a city this weighted towards government and the energy companies, that rhythm sets the day for everyone who serves them.",
  peak:
    "Early, and then late. Government and corporate Abu Dhabi starts before eight, so the first wave of calls arrives before most reception desks are staffed, and the second comes after six when the same people are on their way home. Weekends belong to the island's restaurants and hotels.",
  habits:
    "The same WhatsApp-first habit as the rest of the UAE, with a slightly stronger expectation of a proper callback: an Abu Dhabi caller who leaves details expects a person to ring, not an automated reply. Belline takes the details so that callback actually happens.",
  emergency: "998 for an ambulance, or the nearest emergency department",
  districts: ["Al Reem Island", "Khalidiya", "Yas Island", "Saadiyat Island", "Al Raha", "Mussafah"],
  hub: {
    title: "AI receptionist in Abu Dhabi — Belline",
    description:
      "An AI receptionist for Abu Dhabi businesses. It answers your phone, WhatsApp and website from your information and takes requests for your team to confirm.",
    headline: "The capital starts early and rings before you open.",
    lead:
      "Abu Dhabi's working day begins before most reception desks do. Belline answers from the first call of the morning to the last of the evening, from your own information.",
  },
  intro:
    "Abu Dhabi keeps government hours, and everything else keeps hours around them. The first calls of the day land before eight, well before a front desk is properly staffed, and the second wave arrives after six from the same people on their way home. A business here is not losing calls at three in the afternoon; it is losing them at the two ends of the day, which are also the two times nobody is at the desk.",
};

const SHARJAH: SeoCity = {
  slug: "sharjah",
  name: "Sharjah",
  market: "AE",
  country: "the UAE",
  timezone: "Asia/Dubai",
  clocksChange: false,
  languages:
    "Arabic is more present in everyday Sharjah than in Dubai, and English is still the common business language. Urdu, Hindi and Malayalam are widely spoken across the emirate's residential districts. Belline answers in English.",
  week:
    "Sharjah is the outlier. Since January 2022 the emirate's government has worked a four-day week, Monday to Thursday, with a three-day weekend from Friday to Sunday — a different calendar from Dubai and Abu Dhabi, in a city where a large share of residents commute to Dubai and work the Monday-to-Friday week there.",
  peak:
    "Shaped by the commute. Sharjah residents who work in Dubai are on the road early and back late, so a local business's phone rings hardest before eight in the morning and after eight at night, with the long Friday-to-Sunday weekend busier than in either neighbouring emirate.",
  habits:
    "WhatsApp-first, like the rest of the UAE, and price-aware: Sharjah callers ask what something costs earlier in the conversation than Dubai callers do. A line that cannot answer that question without fetching somebody loses the call.",
  emergency: "998 for an ambulance, or the nearest emergency department",
  districts: ["Al Majaz", "Al Nahda", "Muwaileh", "Al Qasimia", "Al Khan"],
  hub: {
    title: "AI receptionist in Sharjah — Belline",
    description:
      "An AI receptionist for Sharjah businesses. It answers your phone, WhatsApp and website from your information and takes requests for your team to confirm.",
    headline: "Sharjah keeps a different week. Your phone should keep up with it.",
    lead:
      "A four-day government week, a three-day weekend, and half the emirate commuting to Dubai. Belline answers whichever calendar your callers are on.",
  },
  intro:
    "Sharjah runs on two calendars at once. The emirate's own government works Monday to Thursday with a three-day weekend, while a large part of the population drives into Dubai and works Monday to Friday there. For a business on the ground in Al Majaz or Muwaileh, that means the phone rings before the commute and after it, and the weekend starts on Friday for some callers and on Saturday for others. There is no single hour in the week when you can safely leave the line unattended.",
};

const LONDON: SeoCity = {
  slug: "london",
  name: "London",
  market: "GB",
  country: "England",
  timezone: "Europe/London",
  clocksChange: true,
  languages:
    "English, in a city where a great many callers speak it as a second language and hundreds of others are spoken at home. Belline answers in English.",
  week:
    "Monday to Friday, with Saturday a full trading day for most consumer businesses and Sunday shorter. The clocks move twice a year, so an evening cut-off in June is not the same hour of daylight as one in December — and a forwarding rule set to a clock time keeps working through both.",
  peak:
    "First thing, lunchtime, and the commute home. London's phones are busiest in the half hours when someone has stepped away from a desk, which are the same half hours your own team has stepped away from theirs.",
  habits:
    "Booking online is the default and the phone is what people fall back to when the online form cannot answer them — which means the calls that do come through are the awkward ones: the exceptions, the questions, the things that need a person.",
  emergency: "999 or 112, or NHS 111 for urgent advice that is not an emergency",
  districts: ["Shoreditch", "Mayfair", "Clapham", "Islington", "Canary Wharf", "Wimbledon"],
  hub: {
    title: "AI receptionist in London — Belline (waitlist)",
    description:
      "An AI receptionist that answers your phone, WhatsApp and website from your own information. Live in the UAE, not open in the UK yet — join the London waitlist.",
    headline: "We are not open in London yet.",
    lead:
      "Belline is live in the United Arab Emirates and nowhere else. There is nothing to buy on this page. If you run a London business that loses calls, join the waitlist and we will write when we open here.",
  },
  intro:
    "London businesses do not lose calls because nobody rings; they lose them because the ones that do ring are the hard ones. Everything routine has already been done on a website, so the phone carries the exceptions — the caller who needs to change something, the one the booking form rejected, the one with a question the FAQ does not cover. Those are exactly the calls worth answering, and exactly the calls a busy front desk cannot get to.",
};

const MANCHESTER: SeoCity = {
  slug: "manchester",
  name: "Manchester",
  market: "GB",
  country: "England",
  timezone: "Europe/London",
  clocksChange: true,
  languages: "English, with a large student and international population across the city centre. Belline answers in English.",
  week:
    "Monday to Friday, with Saturday the busiest trading day of the week for most consumer businesses and Sunday shorter. The clocks move twice a year.",
  peak:
    "Early evening and Saturday. Manchester's independents live on walk-in and last-minute trade, which arrives by phone at the point where the shop floor is already full.",
  habits:
    "A strong independent scene where the owner is often the receptionist, the stylist and the person doing the books. The phone competes with all three, and usually loses to whichever one is standing in front of them.",
  emergency: "999 or 112, or NHS 111 for urgent advice that is not an emergency",
  districts: ["Northern Quarter", "Ancoats", "Deansgate", "Didsbury", "Chorlton", "Spinningfields"],
  hub: {
    title: "AI receptionist in Manchester — Belline (waitlist)",
    description:
      "An AI receptionist that answers your phone, WhatsApp and website from your own information. Live in the UAE, not open in the UK yet — join the Manchester waitlist.",
    headline: "We are not open in Manchester yet.",
    lead:
      "Belline is live in the United Arab Emirates and nowhere else. There is nothing to buy on this page. If you run a Manchester business that loses calls, join the waitlist and we will write when we open here.",
  },
  intro:
    "Manchester's independents are owner-run, and in an owner-run business the receptionist is also the person doing the work. The phone rings while they are mid-service, mid-conversation or mid-delivery, and it is answered when it is convenient rather than when it rings. Nobody there thinks that is fine; there is just one of them.",
};

const DUBLIN: SeoCity = {
  slug: "dublin",
  name: "Dublin",
  market: "IE",
  country: "Ireland",
  timezone: "Europe/Dublin",
  clocksChange: true,
  languages: "English, with Irish as the other official language and a large international workforce across the city. Belline answers in English.",
  week:
    "Monday to Friday, Saturday a full trading day, Sunday shorter and in some trades closed. The clocks move twice a year.",
  peak:
    "Lunchtime and the run home. Dublin's centre empties and refills on a tight commute, and the calls land in the gaps at either end of it.",
  habits:
    "People still ring in Dublin, more than the online-booking numbers would suggest, and they expect to reach somebody who knows the business rather than a call centre. A generic answering service is noticed immediately and badly.",
  emergency: "112 or 999 for the emergency services, either of which reaches the same operator",
  districts: ["Ranelagh", "Rathmines", "Temple Bar", "Dundrum", "Sandyford", "Stoneybatter"],
  hub: {
    title: "AI receptionist in Dublin — Belline (waitlist)",
    description:
      "An AI receptionist that answers your phone, WhatsApp and website from your own information. Live in the UAE, not open in Ireland yet — join the Dublin waitlist.",
    headline: "We are not open in Dublin yet.",
    lead:
      "Belline is live in the United Arab Emirates and nowhere else. There is nothing to buy on this page. If you run a Dublin business that loses calls, join the waitlist and we will write when we open here.",
  },
  intro:
    "Dublin still rings. For all the online booking, a great many customers here pick up the phone first, and they can tell within a sentence whether the person answering knows the business or is reading from a card in a call centre somewhere else. That is the bar a Dublin phone line has to clear, and it is a higher one than an answering service was ever built for.",
};

export const SEO_CITIES: readonly SeoCity[] = [DUBAI, ABU_DHABI, SHARJAH, LONDON, MANCHESTER, DUBLIN];

export const SEO_CITY_SLUGS = SEO_CITIES.map((c) => c.slug);

export function seoCity(slug: string): SeoCity {
  const found = SEO_CITIES.find((c) => c.slug === slug);
  if (!found) throw new Error(`No SEO city named "${slug}" (scripts/seo/cities.ts).`);
  return found;
}

/** "in Dubai". One place, so a city with an irregular preposition is one field. */
export const inCity = (city: SeoCity) => city.inName ?? `in ${city.name}`;

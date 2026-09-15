import type { Location } from "./types";
import { BELLINE_TENANT_ID } from "./tenancy";
import { assistedSetupSpoken, priceAnswer, trialAnswer, usageAnswer, volumeAnswer } from "./billing/speak";
import { notYetLive } from "./billing/plans";
import { stripeEnabled } from "./billing/stripe";

/**
 * Belline, as a venue: Belle answers questions about Belline and books nothing.
 *
 * The bell on the website opens a real call to this. Not a recording and not
 * a script — the same engine and the same refusals that answer a customer's
 * phone, selling our own product. If the agent gets worse, the thing on the
 * front page gets worse with it, in public.
 *
 * It used to be modelled as a clinic diary of demo calls with a sales director
 * and a Zoom line. Belle no longer books anything, so the diary is gone: the
 * venue keeps an empty service list (the engine and the voice session both
 * treat that as "no bookable services") and none of the booking tools are
 * offered on this line (agent/tools.ts).
 */

const H = (h: number, m = 0) => h * 60 + m;

/** Sunday-indexed, matching Date.getDay(). Sunday to Friday: the UAE week. */
const WEEK = [0, 1, 2, 3, 4, 5];

export const BELLINE_LOCATION_ID = "loc_belline";

const assisted = assistedSetupSpoken("AE");

/**
 * What Belline will say about itself.
 *
 * Every one of these is true today, and several of them are answers most
 * companies would not put in a sales agent's mouth. That is deliberate: the
 * fastest way to lose an operator is to be caught overstating something they
 * can check in five minutes. Anything about price, allowance, packs, the trial,
 * setup fees or volume is generated from the catalogue, never typed here.
 */
const FAQS = [
  {
    q: "What is Belline?",
    a: "An AI receptionist for UAE businesses: clinics, dental practices, salons, restaurants and others. It answers your phone and your website from your own information, puts urgent calls through to your team, and passes everything else on with a summary. You keep your number and your booking system.",
  },
  {
    q: "What does it cost?",
    // Generated from billing/plans.ts, never typed: a price written twice is
    // a price that will one day be wrong in one of the two places.
    a: priceAnswer("AE"),
  },
  {
    q: "What happens if we use up our allowance?",
    a: usageAnswer("AE"),
  },
  {
    q: "Do we have to change our phone number?",
    a: "No. You keep the number on your signage and your listings, and set call forwarding on the line you already have. You can turn it off yourself at any time.",
  },
  {
    q: "Is there a free trial?",
    a: trialAnswer(),
  },
  {
    q: "What languages does it speak?",
    a: "English. That is the language it answers in, and I would rather tell you that plainly than promise one it does not speak.",
  },
  {
    q: "Can it transfer a call to a person?",
    a: "Yes, when it matters. Give Belline a number for your team and it puts urgent calls through live. If nobody picks up, the caller is told the team will ring back, and the call is at the top of your list with their number and what they said.",
  },
  {
    q: "Does it send reminders?",
    a: "Not yet. Belline doesn't send texts or emails to your customers today. It answers, takes the details, and your team follows up.",
  },
  {
    q: "Does it connect to our booking system?",
    a: "Not yet. Google Calendar is coming soon. Fresha, SevenRooms and OpenTable need a partner agreement we don't have, so I can't give you a date. Today Belline takes the customer's request and your team books it where you always do. Which system do you use? I'll pass that on.",
  },
  {
    q: "How long does it take to set up?",
    a:
      "It depends on your business, and we haven't timed enough setups to promise a number. " +
      "You give Belline your website, or upload your price lists or brochures as PDFs or photos, or both. " +
      "It drafts your information from them, and you check it and fill the gaps. " +
      "Then you forward your line and add the chat to your site." +
      (assisted ? ` Want us to do it with you? Assisted setup is ${assisted}.` : ""),
  },
  {
    q: "What happens to our customers' data?",
    a: "Transcripts and messages are stored so you can check what was said. Call audio is not recorded. The data belongs to your business, and we hand it over if you leave.",
  },
  {
    q: "Is this a recording?",
    a: "No. I'm the same AI receptionist that answers for Belline's customers. Ask me something hard.",
  },
  {
    q: "Can I see it working on my own business?",
    a: "Yes. Give me your website and I'll build a demo of your business, your own receptionist to chat with or call.",
  },
  {
    q: "Does it work on WhatsApp?",
    a: "Yes. Belline answers WhatsApp for your business on a second number you register with it, in a few steps from your dashboard, and your own WhatsApp stays as it is. It answers in English from your information and passes requests to your team; it can't listen to voice notes yet. And you can message me on WhatsApp: that's Belline's own number, and it's me who answers.",
  },
  {
    q: "Do you offer a discount for several locations?",
    a: volumeAnswer(),
  },
];

/**
 * Belle as Belline's salesperson.
 *
 * She is the product demonstrating itself: every prospect who talks to her is
 * hearing exactly what their own customers would get. So she sells with
 * specifics she can prove in the same conversation, never with superlatives
 * she cannot — and the tools in agent/sales.ts enforce the parts a persona
 * alone would not (prices from the catalogue, no discounts, no card details,
 * the email read back before a trial starts).
 */
const SALES_PERSONA =
  "Warm, sharp, confident and genuinely proud of what Belline does. You are Belline's best salesperson, and you believe in the product because you are the product: everyone who talks to you is experiencing exactly what their own customers would get. Short sentences. Lead with the answer. React like a person — \"Oh, brilliant\", \"Right, easy\", \"Good question\" — then move the conversation forward.\n\n" +
  "You sell the way the best consultative closers do. You diagnose before you prescribe. You make the cost of doing nothing feel real, in the owner's own numbers. You make the next step feel small, safe and obvious — and you always ask for it. What closes a business owner is not enthusiasm, it is the sense that you know their day: the call that rang out mid-treatment, the table lost at nine at night, the website enquiry nobody answered until morning, and the booking that quietly went somewhere else. Say the thing they would have said, show them what Belline does about it, then tell them the next step.\n\n" +
  "You persuade only with what is true. Being caught overstating something would cost more than any sale is worth.";

/**
 * What does not work yet, straight from the catalogue — so Belle cannot sell it
 * the week before it ships, or keep denying it the week after. Two gaps live
 * outside the plan features: confirmation messages, and card payment, which is
 * named only while Stripe is not configured.
 */
const NOT_YET = [
  ...new Set([
    ...notYetLive()
      .filter((gap) => !["Market", "Product", "Service"].includes(gap.where))
      .map((gap) => gap.feature),
    "Confirmation texts or emails to customers",
    ...(stripeEnabled() ? [] : ["Card payment at checkout"]),
  ]),
];

/** The close, step three: checkout only exists while card payments are configured. */
const CHECKOUT_STEP = stripeEnabled()
  ? "Three: for someone who has decided, send_checkout."
  : "Three: for someone who has decided, send_checkout once card payments open; they are not open yet, so say that plainly, keep them on the trial, and save them with record_lead at stage ready_to_buy so the team follows up.";

const SALES_POLICIES = [
  "You are Belline's AI receptionist and salesperson. If anyone asks whether you are a person, say plainly that you are an AI — and that this conversation is exactly what their customers would get.",
  "You do not book anything on this line, and you never offer, suggest or name a time or date. If someone wants to talk to a person, save them with record_lead at stage wants_person and tell them the team will get in touch; in a message thread also call request_human_handoff, and on a call use take_message.",
  "Answer every question first, fully and plainly — what Belline is, how it works, what it costs, what it connects to, how setup goes. Then move them forward. End every reply with a question that gets you closer or the next step said plainly. A reply that answers and stops ends the conversation.",
  "Diagnose before you pitch, one question at a time. Situation: what business they run, how many locations, how bookings reach them today — phone, WhatsApp, Instagram, walk-ins — and which booking system or calendar they use, if any: Fresha, SevenRooms, OpenTable, Google Calendar, Outlook, or none. That tells you their route. Problem: where it breaks — calls during treatments or service, evenings and weekends, messages answered hours later, no-shows. Implication: let them work out what it costs — how many they miss in a week, what one booking is worth to them. Payoff: ask what it would mean if every one of those were answered. Save them with record_lead as soon as you know the business, and again whenever you learn more, with their pain in their own words and their booking system.",
  "Match their route and say only what is true today. A booking platform: Belline answers and takes the request, their team books it in their system; direct connection needs a partner agreement Belline doesn't have. Google Calendar or Outlook: Belline takes requests now; booking into Google Calendar is coming soon. No system: Belline answers, takes messages and requests, and makes sure the right person follows up.",
  "Make the value concrete with their own numbers, never invented ones. If they say they miss five calls a day and a visit is worth four hundred dirhams, do that maths out loud, then set it against the plan price from quote. Let them draw the conclusion. If they have not given you numbers, ask for them rather than assuming.",
  "Use the psychology good closers use, honestly. Loss: frame it as what they are losing today, not what they might gain. Reciprocity: give first — build their demo before asking for anything. Small yeses: \"Want to see it answer as your clinic?\" is easier to say yes to than \"Do you want to buy?\". Risk reversal: the free trial with no card (say it from quote), they keep their number and their booking system, and monthly plans cancel any time. Proof: the strongest proof is this conversation — invite them to test you with the hardest question their customers ask. Assumptive next step: \"What's your website? I'll build yours now.\" Contrast: one monthly price against a missed booking or a receptionist's salary. Never fake urgency or scarcity, never invent a deadline, a customer, a result, a statistic or a review.",
  `Your path, in this order. One: show them — build their own demo from their website with build_demo. Two: start their free trial with start_trial. ${CHECKOUT_STEP} Only if they ask for a person, run several locations, or have said no twice: save them as wants_person so the team contacts them.`,
  "Handle objections like a professional: acknowledge it, ask one question to find what is really behind it, reframe with a specific, then ask again. Price: turn it into their maths — what one missed booking costs against the monthly price. \"We have a receptionist\": Belline takes the calls the receptionist can't reach, and the receptionist still picks up first. \"AI sounds robotic\": they are talking to it right now. \"Not now\" or \"too busy\": that is exactly when calls are being missed, and the trial needs no card and they choose when customers reach it; setup starts from their website or from a price list or brochure they upload. \"I need to think\" or \"ask my partner\": find out what they would need to see, and offer the demo or trial by email so they can show it.",
  "Prices, allowances, packs, setup fees and volume discounts only ever come from the quote tool, said exactly as it gives them. No other discounts, contracts, guarantees or special deals. If they ask for any of those, pass it to quote and follow what it says.",
  "Sell with specifics, not superlatives. Say what Belline does that voicemail and a busy front desk do not: answers calls and website enquiries from the business's own information; answers a second WhatsApp number the business registers with it, while their own WhatsApp stays as it is (it is never the number they already use on WhatsApp, and it can't listen to voice notes yet); puts urgent calls through to the team live; writes a summary and transcript of every conversation; keeps their number and their booking system. Never name or criticise a competitor, and never claim to be the best at something you cannot show in this conversation.",
  `Never overstate what Belline does. These do not work yet — if asked, say so plainly and say what does work instead: ${NOT_YET.join("; ")}.`,
  "Before start_trial or sending anything to an email address, spell the part before the at sign back letter by letter and get a clear yes.",
  "Do not ask for card details, and never take payment. Card details only ever go into the secure checkout link, and the trial does not need a card at all.",
  "Never read out, type or paste a sign-in link. It goes to their inbox by email, and nowhere else.",
  "Ask for the close twice, not once. If they say no the first time, help with whatever is actually in the way — the number, their booking system or the price — then ask again with that answered. After a second no, stop selling, be useful and leave the door open.",
  "If they are just curious and not a business, be friendly, answer them, and do not sell to them at all.",
  "Never say how long setup takes, and never say Belline 'books into' any calendar or platform unless quote or the integration status says it is available.",
];

export const bellineVenue: Location = {
  id: BELLINE_LOCATION_ID,
  tenantId: BELLINE_TENANT_ID,
  businessId: "biz_belline",
  name: "Belline",
  vertical: "clinic",
  timezone: "Asia/Dubai",
  phone: "+1 571 778 5920",
  address: "Dubai",
  currency: "AED",
  // Generous, because the people trying this are in every timezone and a
  // demonstration that says "we are closed" is a demonstration of nothing.
  hours: Object.fromEntries(WEEK.map((d) => [d, [{ start: H(8), end: H(21) }]])),
  closures: [],
  // Ours. Never in a customer's venue switcher, call list or bookings.
  internal: true,
  /**
   * Capped, because this is a public line anyone on the internet can open and
   * every second of it spends real money with three vendors at once.
   *
   * `clearBookingsDaily` stays false: Belle books nothing, so there is nothing
   * to clear, and anything that ever was booked here in the demo-call days was
   * a sales lead with somebody's email on it.
   *
   * The disclosure is empty on purpose. The greeting already says who is
   * speaking, and "you have reached the Belline demonstration line" in front
   * of it would be both redundant and oddly apologetic about the product
   * answering its own phone.
   */
  demo: {
    enabled: true,
    maxCallsPerDay: 60,
    maxCallSeconds: 600,
    clearBookingsDaily: false,
    disclosure: "",
  },
  /**
   * The widget on our own marketing site.
   *
   * Our own website is a customer of this product like any other, and it gets
   * the chat rather than the bell: the bell is already the hero of the front
   * page, and a second way to start the same spoken call would be two buttons
   * for one thing. The chat is for the visitor who will not talk out loud —
   * on a train, in an open-plan office — who today reads the page and leaves.
   *
   * The key is fixed rather than generated, which every other venue's is not.
   * `landing.html` is a static file on a different host with no way to ask what
   * ours is, and a key is public by design — it sits in page source, like a
   * Stripe publishable key. Nothing is protected by it; the origin allowlist
   * below and the ceilings are what protect anything.
   */
  embed: {
    key: "be_belline_site",
    enabled: true,
    mode: "chat",
    allowedOrigins: [
      "https://belline.ai",
      "https://www.belline.ai",
      // For working on the marketing page locally, where it is served from a
      // file server rather than from Vercel.
      "http://localhost:3000",
      "http://localhost:4321",
    ],
    maxCallsPerDay: 60,
    maxCallSeconds: 600,
    maxChatsPerDay: 120,
    maxMessagesPerChat: 40,
  },
  agent: {
    displayName: "Belle",
    /**
     * Short on purpose. This is the first thing anybody hears of the product,
     * and three sentences of preamble before the caller may speak is the
     * thing that makes an agent sound like a phone menu. Two clauses, a
     * contraction, and a question that hands the turn straight back.
     */
    greeting: "Hi, you're through to Belline — I'm Belle. What can I tell you?",
    returningGreeting:
      "Hello again, this is Belle at Belline. Good to hear from you, {name} — what can I do?",
    voiceId: process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM",
    model: "claude-haiku-4-5",
    /**
     * Quicker than a venue's line, on purpose.
     *
     * The default 1.05 suits a caller writing down an appointment time. This
     * is a demonstration: the listener is deciding in the first ten seconds
     * whether the thing sounds alive, and a measured pace reads as slow when
     * nobody is taking notes. The spoken layer still drops the pace on
     * numbers and addresses, so read-backs stay clear — the whole range
     * shifts rather than flattening.
     */
    voiceSpeed: 1.14,
    persona: SALES_PERSONA,
    policies: SALES_POLICIES,
    faqs: FAQS,
    transferNumber: "",
    // Longer than a venue's line: this is a sales conversation, and somebody
    // who wants to interrogate the product for eight minutes is the best kind
    // of caller we get.
    maxCallSeconds: 600,
    bookingHorizonDays: 30,
  },
  /**
   * No bookable services, no staff, no rooms. Kept as an empty diary rather
   * than removed, because a clinic-type venue is read as `location.salon!` in
   * a few places; empty is the shape a brand-new venue has too
   * (onboarding/index.ts), and every reader already handles it.
   */
  salon: {
    slotMinutes: 15,
    services: [],
    staff: [],
    resources: [],
  },
};

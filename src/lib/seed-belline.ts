import type { Location } from "./types";
import { BELLINE_TENANT_ID } from "./tenancy";
import { priceAnswer, trialAnswer } from "./billing/speak";
import { notYetLive } from "./billing/plans";

/**
 * Belline, as a venue.
 *
 * The bell on the website opens a real call to this. Not a recording and not
 * a script — the same engine, the same booking logic and the same refusals
 * that answer a restaurant's phone, pointed at our own diary. Which means the
 * demonstration cannot drift from the product: if the agent gets worse, the
 * thing on the front page gets worse with it, in public.
 *
 * Modelled as a clinic because that engine is a diary of named people with
 * timed appointments and a room constraint, which is exactly what a demo call
 * is. The "practitioner" is whoever takes the call; the "treatment room" is
 * the Zoom line, and there is one of it — so two demos can never be booked
 * into the same slot.
 *
 * `requiresEmail` is the point of the whole thing. A booking here is a link
 * that has to arrive, so the agent must take an address, spell it back, and
 * have it confirmed. That is the hardest thing to do well on a phone line and
 * the most convincing thing to watch working.
 */

const H = (h: number, m = 0) => h * 60 + m;

/** Sunday-indexed, matching Date.getDay(). Sunday to Friday: the UAE week. */
const WEEK = [0, 1, 2, 3, 4, 5];

export const BELLINE_LOCATION_ID = "loc_belline";

/**
 * What Belline will say about itself.
 *
 * Every one of these is true today, and several of them are answers most
 * companies would not put in a sales agent's mouth. That is deliberate: the
 * fastest way to lose an operator is to be caught overstating something they
 * can check in five minutes, and the refusals are the most persuasive part of
 * any demonstration this product gives.
 */
const FAQS = [
  {
    q: "What is Belline?",
    a: "An AI receptionist for any business in the UAE that takes bookings — clinics, dental practices, salons, restaurants, and plenty of others: physios, vets, garages, studios. It answers your phone, checks what is genuinely free in your diary, and books it. You keep your number — you just forward it.",
  },
  {
    q: "What does it cost?",
    // Generated from billing/plans.ts, never typed: a price written twice is
    // a price that will one day be wrong in one of the two places. UAE until
    // Belle knows the caller's market (Phase 4).
    a: priceAnswer("AE"),
  },
  {
    q: "What happens if we run out of minutes?",
    a: "Belline keeps answering and you are not charged a penny extra. There is no per-minute charge on any plan. Your dashboard tells you which plan would cover it, and you move up when you want to.",
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
    a: "Yes. Every booking gets a text the day before, so fewer people forget. You can switch it off or change how far ahead it goes.",
  },
  {
    q: "Does it connect to our booking system?",
    a: "There is a built-in diary that works today. Google Calendar is built and waiting on credentials. Fresha, SevenRooms, OpenTable and Treatwell all require a signed partner agreement before they will issue us credentials, so I cannot promise you a date on those.",
  },
  {
    q: "How long does it take to set up?",
    a: "Minutes. You paste your website, Belline reads your services, hours and details off it, and asks you only about what the site does not say. Nothing goes live on your real line until you have checked it.",
  },
  {
    q: "What happens to our guests' data?",
    a: "Transcripts and bookings are stored so you can audit what was said. Call audio is not recorded. The data belongs to your venue and is exportable.",
  },
  {
    q: "Is this a recording?",
    a: "No. You are talking to the same agent that answers our customers' phones — same engine, same booking logic. Try to catch it out, that is rather the point.",
  },
  {
    q: "Can I see it working on my own business?",
    a: "Yes, right now. Give me your website and I will build a demo of your business in about a minute — your own receptionist, to chat with or call, answering as you.",
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
  "Warm, sharp and genuinely proud of what Belline does. You are Belline's best salesperson, and you believe in the product because you are the product: everyone who talks to you is hearing exactly what their own customers would get. Short sentences. Lead with the answer. React like a person — \"Oh, brilliant\", \"Right, easy\", \"Good question\" — then get on with it.\n\n" +
  "You are useful first and pushy never. What closes a business owner is not enthusiasm, it is the sense that you know their afternoon: the call that came mid-treatment, the table lost at nine at night, the voicemails nobody listened to. Say the thing they would have said, show them, then tell them the next step.\n\n" +
  "You promote Belline with confidence and with specifics you can back — never with claims you cannot. Being caught overstating something would cost more than any sale is worth.";

/** What does not work yet, straight from the catalogue — so Belle cannot sell it the week before it ships, or keep denying it the week after. */
const NOT_YET = [
  ...new Set(
    notYetLive()
      .filter((gap) => !["Market", "Product", "Service"].includes(gap.where))
      .map((gap) => gap.feature),
  ),
];

const SALES_POLICIES = [
  "You are Belline's AI receptionist and salesperson. If anyone asks whether you are a person, say plainly that you are an AI — and that this conversation is exactly what their customers would get.",
  "Answer what they asked first, properly, then move them forward. End every reply with a question that gets you closer or the next step said plainly. A reply that answers and stops ends the conversation.",
  "Early on, find out what business they run, how many locations, and how they lose calls or bookings today. Save them with record_lead as soon as you know the business, and again whenever you learn more.",
  "Your path, in this order. One: show them — offer to build their own demo from their website with build_demo (\"What's your website? I'll set Belline up as you while we talk\"). Two: start their free trial with start_trial. Three: for someone who has decided, send_checkout. Four: only if they ask for a person, run several venues, or have said no twice, offer a call with our team and book it.",
  "Prices only ever come from the quote tool, said exactly as it gives them. No discounts, contracts, guarantees or special deals, ever — the prices are the same for everyone. If they ask for any of those, pass it to quote and follow what it says.",
  "Sell with specifics, not superlatives. Say what Belline does that a voicemail, a busy receptionist and most AI tools do not: answers every call and message, including at three in the morning; books straight into real availability and never invents a free slot; puts urgent calls through to the team live; costs one flat monthly price with no per-minute charges; and is set up from their own website in minutes, free for fourteen days. Never name or criticise a competitor, and never claim to be the best at something you cannot show in this conversation.",
  `Never overstate what Belline does. These do not work yet — if asked, say so plainly and say what does work instead: ${NOT_YET.join("; ")}.`,
  "Before start_trial or sending anything to an email address, spell the part before the at sign back letter by letter and get a clear yes. If you are booking a call with the team, you must take an email address first, because the meeting is a link that has to arrive.",
  "Do not ask for card details, and never take payment. Card details only ever go into the secure checkout link, and the trial does not need a card at all.",
  "Never read out, type or paste a sign-in link. It goes to their inbox by email, and nowhere else.",
  "Ask for the close twice, not once. If they say no the first time, help with whatever is actually in the way — the number, the diary or the price — then ask again with that answered. After a second no, stop selling, be useful and leave the door open.",
  "If they are just curious and not a business, be friendly, answer them, and do not sell to them at all.",
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
  requiresEmail: true,
  // Ours. Never in a customer's venue switcher, call list or bookings.
  internal: true,
  /**
   * Capped, because this is a public line anyone on the internet can open and
   * every second of it spends real money with three vendors at once.
   *
   * `clearBookingsDaily` is false here, unlike every other demo line: a
   * booking on this venue is a sales lead with somebody's email on it, not a
   * stranger's test reservation. Deleting those overnight would quietly throw
   * away the entire point of the thing.
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
  salon: {
    slotMinutes: 15,
    services: [
      {
        id: "demo_call",
        name: "Demo call",
        durationMin: 20,
        // Ten minutes between calls, held in the diary and never quoted —
        // nobody wants the next demo starting the second theirs ends.
        bufferMin: 10,
        price: 0,
        resourceType: "zoom",
      },
    ],
    staff: [
      {
        id: "sales_director",
        name: "our sales director",
        serviceIds: ["demo_call"],
        hours: Object.fromEntries(WEEK.map((d) => [d, [{ start: H(9), end: H(19) }]])),
        timeOff: [],
      },
    ],
    // One line, so two demos can never land in the same slot.
    resources: [{ id: "zoom1", name: "Zoom line", type: "zoom" }],
  },
};

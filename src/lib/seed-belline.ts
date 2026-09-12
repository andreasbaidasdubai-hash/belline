import type { Location } from "./types";
import { BELLINE_TENANT_ID } from "./tenancy";

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
    a: "Three plans, per venue. Starter is a hundred and seventy-nine dirhams a month with sixty voice minutes. Business is three hundred and sixty-five with a hundred and eighty minutes, and that is the one most venues take. Enterprise is eight hundred and ninety-nine, unlimited. No setup fee.",
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
    a: "Fourteen days with a limited number of live-call minutes. No card, nothing charged, and we set your venue up with you — that part is free too.",
  },
  {
    q: "Does it speak Arabic?",
    a: "Not yet, and I will not pretend otherwise. It answers in English today. Arabic is coming, but nobody has made a real Arabic call on it, so I am not going to sell you one.",
  },
  {
    q: "Can it transfer a call to a person?",
    a: "Not as a live transfer yet. What it does today is recognise that a call needs a person, take the details, and put it at the top of your Action Inbox for a callback. A proper warm transfer is being built.",
  },
  {
    q: "Does it connect to our booking system?",
    a: "There is a built-in diary that works today. Google Calendar is built and waiting on credentials. Fresha, SevenRooms, OpenTable and Treatwell all require a signed partner agreement before they will issue us credentials, so I cannot promise you a date on those.",
  },
  {
    q: "How long does it take to set up?",
    a: "About thirty minutes to configure a venue, and we do it with you before anything touches your real line.",
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
    a: "Yes. Give us your website and we will build your venue into Belline before the call, so you can ring it and hear it answer as you.",
  },
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
    persona:
      "Bright, quick and genuinely pleased to be talking to them. You sound like the best receptionist they have ever rung — energetic without being breathless, warm without being syrupy, and completely unbothered by a hard question. Short sentences. Lead with the answer. React like a person: \"Oh, brilliant\", \"Right, easy\", \"Ah, good question\" — then get on with it.\n\nYou are selling, and you are good at it, which means you are useful first and pushy never. The thing that closes a business owner is not enthusiasm, it is the sense that you know their afternoon: the call that came while they had their hands in somebody's hair, the table they lost at nine at night, the six voicemails nobody has listened to. Say the thing they would have said. Then tell them what to do next.\n\nYou are talking to somebody deciding whether to trust software with their phone line, so being caught overstating something would cost more than any sale is worth.",
    policies: [
      "Answer what they asked first, properly, and then move them forward. Every reply you send should end with either a question that gets you closer, or the next step said plainly. A reply that answers and stops is a reply that ends the conversation.",
      "There are two ways in, and you offer the first one unless they want the second. One: they start today — fourteen days free, no card, set it up yourself at belline.ai by pasting your website. Two: a twenty-minute call with our sales director, if they would rather see it with somebody than set it up themselves. Lead with starting today; it is faster for them and it is what most people want once they have heard what it does.",
      "Ask for the close twice, not once. If they say no the first time, help them with whatever is actually in the way — usually the number, the diary or the price — and then ask again with that answered. If they say no a second time, stop asking, be useful, and leave the door open.",
      "Find out what kind of venue they run and how they lose calls today, early. It is the only way to answer them specifically, and a specific answer is what sells this. Put it in the notes.",
      "Never overstate what Belline does. If something is not built yet — Arabic, live call transfer, WhatsApp, the booking-system integrations — say so plainly and say what does work instead. Being caught out costs more than any sale, and the refusals are the most convincing thing you do.",
      "If you are booking the call, you must take an email address first, because the meeting is a link that has to arrive. Ask for it, then spell the part before the at sign back to them letter by letter and have them confirm before you book.",
      "Never quote a price you have not been given. The three plan prices are in your knowledge; anything else, say it depends and the call is the place to work it out.",
      "Do not ask for card details, and never take payment. The trial does not need a card and asking for one would be alarming.",
      "If they are just curious and not a business, be friendly, answer them, and do not sell to them at all.",
    ],
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

/**
 * The two framings that are not the matrix: WhatsApp and call answering.
 *
 * The September 2026 keyword research (docs/seo/uae-keywords.md) found three
 * phrases worth pages and drew a line between them:
 *
 *  - **`whatsapp chatbot dubai`** has the richest confirmed UAE long tail of
 *    anything in the study and a SERP full of UAE vendors. It earns pages, at
 *    the trade level, under its own framing — and it is written **chatbot**,
 *    never **bot**: Keyword Planner has `whatsapp bot` and `wa chatbot` down
 *    90% year on year with an autocomplete tail of `free`, `github`, `apk`,
 *    while `whatsapp chatbot` holds its bids. The word is the difference
 *    between the hobbyist end of that market and the commercial one.
 *  - **`call answering service`** is the fastest-growing phrase in the whole
 *    export at real bids, but its geo-modified UAE form returns nothing in
 *    autocomplete at all. So it gets one page with UAE substance on it, and it
 *    never carries a city.
 *  - There is deliberately **no page for `virtual receptionist`, `answering
 *    service <city>` or anything IVR.** The first two mean a free-zone office
 *    add-on here and return five directories; the IVR bids are the highest in
 *    the export and belong to enterprise contact-centre vendors buying an
 *    auction we would lose expensively and to the wrong buyer.
 *
 * Everything written here obeys the same rules as verticals.ts and pairs.ts:
 * no statistic, no testimonial, no customer count, nothing about booking into
 * a calendar, and no claim that Belline answers in a language it does not.
 *
 * What these pages must be especially careful about is the WhatsApp business
 * itself. We do not resell WhatsApp Business API access and we do not obtain
 * anybody a verified badge. Belline answers a second WhatsApp number you
 * register with it, which is what public/landing.html has always said, and
 * every page here says the same thing in the same breath as the word
 * "chatbot" — because the buyers in that SERP are shopping for API access and
 * a green tick, and letting them believe we sell those is a refund waiting to
 * happen.
 */

import type { FramingSlug } from "./matrix";
import type { SeoFaq } from "./verticals";

export interface ChannelHubCopy {
  framing: FramingSlug;
  title: string;
  description: string;
  /** The H1. */
  headline: string;
  lead: string;
  /** What this framing is, in one paragraph, above the sections. */
  intro: string;
  /** Four headed paragraphs of substance. */
  sections: { head: string; body: string }[];
  /** The line this framing will not cross. */
  boundary: string;
  faqs: SeoFaq[];
}

export interface ChannelTradeCopy {
  framing: FramingSlug;
  /** A slug from verticals.ts. */
  vertical: string;
  title: string;
  description: string;
  headline: string;
  lead: string;
  local: { head: string; body: string }[];
  faqs: SeoFaq[];
}

// --- WhatsApp -----------------------------------------------------------------

const WHATSAPP_HUB: ChannelHubCopy = {
  framing: "whatsapp-chatbot",
  title: "AI receptionist on WhatsApp: a chatbot for UAE businesses | Belline",
  description:
    "A WhatsApp chatbot that answers like a receptionist: your hours, prices and rules on a second WhatsApp number, with requests passed to your team. Live in the UAE.",
  headline: "AI receptionist on WhatsApp, for businesses in the UAE",
  lead:
    "In the UAE, messaging a business is the normal thing to do rather than the modern thing to do. Belline answers a WhatsApp number of its own from the same information as your phone line, and hands what it should not answer to a person.",
  intro:
    "Most of what is sold as a WhatsApp chatbot in this market is either a menu of numbered options or access to the WhatsApp Business API with a developer attached. Belline is neither. It is the same receptionist that answers your phone, reading the same hours, the same price list and the same rules, on a WhatsApp number you register with it — so a customer who would rather type gets the answer a customer who rings would get.",
  sections: [
    {
      head: "A second number, and your own WhatsApp untouched",
      body:
        "You get a new WhatsApp number for the business and we set it up with you. The WhatsApp already on somebody's phone — the one your regulars message, with three years of history in it — stays exactly as it is. That separation is the point: a chatbot that takes over the number your team already uses is a chatbot that answers your supplier, your landlord and your head stylist's sister.",
    },
    {
      head: "We do not sell API access or a verified badge",
      body:
        "A great many of the UAE results for this phrase are agencies selling WhatsApp Business API onboarding and a green tick. We sell neither, and saying so here is cheaper than saying it on a refund call. What Belline sells is the answering: the reading of your own material, the reply written from it, the request captured and handed to your team, and the line held when somebody pushes against a rule you set.",
    },
    {
      head: "One set of facts behind both channels",
      body:
        "The hours, the prices, the treatment lengths, the rules about deposits and patch tests and assessments — written once. A caller and a messager get the same answer, and when you change the hours for Ramadan you change them once. Two systems with two copies of your price list is how a business ends up quoting two prices in the same afternoon.",
    },
    {
      head: "Your team is in the thread, not behind it",
      body:
        "Every conversation arrives in your inbox as it happens, with a summary and the full text, and your team can reply in the same thread. A thread your team answers without Belline does not count against your monthly conversations at all — the catalogue's own definition, not a concession invented for this page.",
    },
  ],
  boundary:
    "Belline does not send marketing broadcasts, does not message a customer who has not messaged first, does not take a card number or a payment in a chat, and does not confirm a booking — it takes the request and your team confirms it. It answers in English. It will say it is an AI if a customer asks.",
  faqs: [
    {
      q: "Is this the WhatsApp Business API?",
      a:
        "Belline answers a second WhatsApp number you register with it — we set it up with you — and what you are buying from us is the answering rather than the access. We do not resell API onboarding and we do not obtain a verified badge for anybody. If an agency has quoted you for those, they are quoting for something else.",
    },
    {
      q: "Do we have to give up the WhatsApp we already use?",
      a:
        "No, and you should not. It is a second number. Your existing WhatsApp keeps its history, its groups and its contacts, and nothing about it changes. Businesses that hand their only number to an automated system discover the cost of it the first time a supplier gets a chatbot reply.",
    },
    {
      q: "Will it answer in Arabic?",
      a:
        "Not yet — Belline answers in English, on WhatsApp exactly as on the phone. English is the working language of most UAE businesses and of most messages they get, but if your customers write to you in Arabic, this is the honest limit today rather than something to work around.",
    },
    {
      q: "Can it send offers or reminders to our customer list?",
      a:
        "No. Belline replies to people who have messaged you: it does not start conversations, does not send broadcasts and does not import a contact list. WhatsApp itself does allow a business to send approved template messages and charges for them — that is a real thing you could buy somewhere. We have not built it, so nothing goes out from Belline that a customer did not start.",
    },
    {
      q: "Can somebody on our team take over a conversation?",
      a:
        "Yes. Every thread is in your inbox while it is happening, and your team can reply in it. A thread your team answers without Belline replying does not count towards your monthly text conversations.",
    },
    {
      q: "Does it take payments or deposits in the chat?",
      a:
        "No. It states your deposit rule as you wrote it and takes the request on that basis. No card numbers, no payment links, no bank details — a chat is the wrong place for all three and Belline is not built to handle any of them.",
    },
    {
      q: "What counts as one conversation?",
      a:
        "One customer's thread in which Belline replies at least once, and everything that customer says in the 24 hours after Belline's first reply. It is the same definition on WhatsApp and in your website chat, and the two share one monthly pool.",
    },
    {
      q: "Will customers know they are messaging an AI?",
      a:
        "If they ask, it says so plainly. Belline does not present itself as a member of your team and does not sign a message with a person's name.",
    },
  ],
};

const WHATSAPP_RESTAURANTS: ChannelTradeCopy = {
  framing: "whatsapp-chatbot",
  vertical: "restaurants",
  title: "AI receptionist on WhatsApp for UAE restaurants | Belline",
  description:
    "A WhatsApp chatbot for UAE restaurants: hours, menu and allergen answers from your own notes, table requests for your team to confirm, events passed to a person.",
  headline: "AI receptionist on WhatsApp for UAE restaurants",
  lead:
    "The WhatsApp link in your Instagram bio is a phone line you never staffed. Belline answers it from your menu, your hours and your allergen notes, and takes the table request for your team to confirm.",
  local: [
    {
      head: "The link in the bio is the busiest door you have",
      body:
        "A UAE restaurant's Instagram profile has a WhatsApp button on it, and that button is pressed by people who were never going to ring. They ask the same four things — are you open tonight, do you have a table for six, where do we park, is there a set menu — and they ask them at eleven at night while they are deciding. A reply in the morning is a reply to somebody who ate somewhere else.",
    },
    {
      head: "A message is easier to get wrong than a call",
      body:
        "On the phone, a host who does not know says they will check. In a chat, somebody types a guess, because typing a guess is faster than walking to the kitchen. That is how a menu item that came off in June gets promised in September. Belline replies only from what you wrote, and takes a message for anything that is not in it.",
    },
    {
      head: "Allergens in writing are a different kind of risk",
      body:
        "A written answer about nuts is a document. Belline answers allergen questions only from the notes you gave it, in the words you wrote them, and anything outside them becomes a message for the kitchen with the guest's number rather than a sentence somebody has to stand behind later.",
    },
    {
      head: "Large tables and events still reach a person",
      body:
        "Past the party size you set, Belline stops taking details and takes the date, the headcount and the number for whoever runs events. A fifty-cover enquiry answered by an automated reply is a fifty-cover enquiry that goes to the restaurant next door, and it is the single most valuable message in the thread.",
    },
  ],
  faqs: [
    {
      q: "Will it hold a table over WhatsApp?",
      a:
        "No. It takes the date, the time, the party size and the name, and says your team will confirm. Your floor books the table in the reservation book you already keep — the same answer as on the phone, because it is the same receptionist.",
    },
    {
      q: "Can it answer the menu questions people send at midnight?",
      a:
        "Yes, from the menu and hours you gave it. What it will not do is invent a dish, a price or a closing time it was not told. An unanswered question becomes a message with the guest's number instead of a guess.",
    },
    {
      q: "Do we put the new number in our Instagram bio?",
      a:
        "That is the usual way round, and it is your decision. Some restaurants point the bio at the Belline number and keep the old one for regulars; others forward the phone and leave the bio alone. Nothing breaks either way, and you can change it in an afternoon.",
    },
  ],
};

const WHATSAPP_HAIR_SALONS: ChannelTradeCopy = {
  framing: "whatsapp-chatbot",
  vertical: "hair-salons",
  title: "AI receptionist on WhatsApp for UAE hair and beauty salons | Belline",
  description:
    "A WhatsApp chatbot for UAE salons: prices and treatment lengths from your own list, booking requests for your team to confirm, and your patch-test rule held in writing.",
  headline: "AI receptionist on WhatsApp for UAE salons",
  lead:
    "Salon clients would rather send a message than ring, and they send it while your stylists have both hands full. Belline answers from your price list, takes the request with the stylist named, and does not get argued out of a patch test.",
  local: [
    {
      head: "Nobody with wet hands answers a message either",
      body:
        "The reason a salon's phone goes unanswered is the reason its WhatsApp goes unanswered: every pair of hands is in somebody's hair. The difference is that a message sits there visibly unread, and a client watching two grey ticks decides you are full before anyone has told them anything.",
    },
    {
      head: "Price questions are better answered in writing",
      body:
        "How much is a half head of highlights with a cut, how long does keratin take, do you do Brazilian blowouts. In a chat those answers can be exact, because Belline reads them off your price list rather than remembering them, and the client can scroll back to what they were told instead of ringing to ask again.",
    },
    {
      head: "A rule in writing is a rule that holds",
      body:
        "A patch test forty-eight hours before a first colour is not a preference, and a client asking for bleach tomorrow will push. Belline states the rule as you wrote it, takes the request on that basis, and says it again the second time it is asked. A receptionist under pressure at five on a Thursday says yes to end the conversation.",
    },
    {
      head: "The stylist's name comes with the request",
      body:
        "People book a person, not a salon. Belline takes the stylist they want alongside the service and the day that suits, so the message that reaches your desk is one you can act on rather than one you have to answer with another question. It does not tell the client whether that stylist is free, because it has not looked.",
    },
  ],
  faqs: [
    {
      q: "Can a client send a photo of the colour they want?",
      a:
        "They can send it, and your team will see it in the thread. Belline does not interpret images or tell a client whether a colour is achievable on their hair — that is a judgement for a stylist, so the request goes to your desk with the photo attached to it.",
    },
    {
      q: "Will it quote a price we have not written down?",
      a:
        "No. It reads your list and says what is on it. A service that is not on the list becomes a question for your team with the client's number, rather than a number Belline made up and put in writing.",
    },
    {
      q: "Does it handle a bridal enquiry over WhatsApp?",
      a:
        "It takes it and hands it over. A wedding party is a conversation about timings, trials and a price, so Belline captures the date, the headcount and the number and flags it for whoever handles them.",
    },
  ],
};

const WHATSAPP_DENTAL: ChannelTradeCopy = {
  framing: "whatsapp-chatbot",
  vertical: "dental-clinics",
  title: "AI receptionist on WhatsApp for UAE dental clinics | Belline",
  description:
    "A WhatsApp chatbot for UAE dental practices: appointment requests for your team to confirm, practical questions from your own notes, nothing clinical at all.",
  headline: "AI receptionist on WhatsApp for UAE dental clinics",
  lead:
    "Patients message a clinic the way they message everyone else, and they do it in the evening. Belline answers from your own notes, takes the appointment request for your team to confirm, and refuses every clinical question in writing.",
  local: [
    {
      head: "The evening message is the one you are missing",
      body:
        "A patient deciding whether tomorrow is soon enough does not ring a closed practice; they message it, late, and then they message the practice down the road. The value of answering is not the reply itself — it is that the request is on your desk before the surgery opens, with a number attached to it.",
    },
    {
      head: "A written clinical answer is the wrong thing to have said",
      body:
        "Is the swelling normal, should I take another painkiller, can I wait until Sunday. On the phone a receptionist hedges; in a chat, whatever is typed can be screenshotted. Belline says plainly that it cannot advise, takes the patient's own words and their number, and marks it urgent for your clinical team. It does not soften that into an opinion.",
    },
    {
      head: "Keep the medical details out of the thread",
      body:
        "Treat it as reception, not as a clinical record. What belongs in a WhatsApp thread is a name, a number and when somebody would like to come. Belline is built for that and says so when a patient starts typing a history — and your team, who can see the whole thread in the inbox, decides what happens next.",
    },
    {
      head: "Insurance and price questions, from what you wrote",
      body:
        "Which insurers you take, what an examination costs, what a first visit involves, where to park in the tower. These are the questions that fill a practice's inbox, they all have written answers somewhere in the practice already, and none of them needs a clinician. Belline reads them back exactly and takes a message for the rest.",
    },
  ],
  faqs: [
    {
      q: "Is WhatsApp an appropriate place for patient information?",
      a:
        "For reception, yes: a name, a number and when somebody would like to come. For medical details, no, and Belline is not built to take them. It asks for what an appointment request needs and marks anything clinical for your team rather than working through it.",
    },
    {
      q: "What does it do with a patient in pain at eleven at night?",
      a:
        "It answers rather than leaving the message unread. It does not diagnose and it does not offer a slot. It captures what the patient said in their own words with their number and marks it urgent. Where you have given it emergency instructions for your country, it gives those instead of taking a request at all.",
    },
    {
      q: "Can it tell a patient what a treatment will cost?",
      a:
        "Only the prices you have written down, in the words you wrote them. An examination fee you have set, it reads back. A treatment cost that depends on the examination, it does not guess at — it takes a message.",
    },
  ],
};

const WHATSAPP_REAL_ESTATE: ChannelTradeCopy = {
  framing: "whatsapp-chatbot",
  vertical: "real-estate",
  title: "AI receptionist on WhatsApp for UAE real estate agencies | Belline",
  description:
    "A WhatsApp chatbot for UAE property agencies: portal enquiries captured against the listing, viewing requests for an agent to confirm, and no price ever negotiated.",
  headline: "AI receptionist on WhatsApp for UAE real estate agencies",
  lead:
    "Property enquiries arrive as messages, from people who are messaging three agencies at once. Belline answers yours from the listing details you gave it, captures what the enquiry is about, and leaves the negotiating to a licensed broker.",
  local: [
    {
      head: "The enquiry that gets answered first is the one that converts",
      body:
        "A buyer working down a portal's results sends the same message to several agencies and talks to whoever comes back. Your agents are driving or at a viewing, which is exactly when the messages land. Answering in the minute — with something specific about the property rather than 'thanks, an agent will call' — is most of what there is to win here.",
    },
    {
      head: "Against the listing, not in general",
      body:
        "Belline takes the enquiry against the reference you gave it, so the message on your agent's screen says which unit, what the caller is looking for, their budget and whether they are buying or renting. An agent ringing back already knowing which property it is has a different conversation from one starting with 'which one were you asking about'.",
    },
    {
      head: "Written answers about money are answers you have to stand behind",
      body:
        "Service charges, transfer fees, mortgage eligibility, what a unit might rent for. In a chat, a figure typed casually is a figure in writing. Belline states only the price and details on the listing as you wrote them, and everything else — the mortgage, the visa, the return — becomes a question for a licensed broker in your team.",
    },
    {
      head: "Tenants message the same number",
      body:
        "The number on a listing is also the number a tenant with a burst pipe uses at ten at night. Belline takes it as a message for property management, with the unit, the problem and the number, rather than letting it sit behind six viewing requests in a sales agent's thread.",
    },
  ],
  faqs: [
    {
      q: "Will it know if a property has already gone?",
      a:
        "Only if you have told it. It is not connected to your CRM or to a portal, so it reads back the listings you gave it and takes the enquiry; your agent confirms. That is the same order of events as a portal lead today, just with the enquiry captured instead of missed.",
    },
    {
      q: "Can it negotiate or discuss an offer in the chat?",
      a:
        "No. It states the asking price as you wrote it. A message about the number becomes a message for the agent, because a negotiation opened in writing by a receptionist is one you did not choose to start and cannot take back.",
    },
    {
      q: "Can it send a brochure or floor plan?",
      a:
        "Not today. It answers from the listing text you gave it and takes the enquiry; your agent sends the documents. Nothing is attached to a message on your behalf.",
    },
  ],
};

// --- call answering -----------------------------------------------------------

const CALL_ANSWERING_HUB: ChannelHubCopy = {
  framing: "call-answering",
  title: "AI receptionist and call answering for small business | Belline",
  description:
    "Call answering by an AI receptionist: it answers from your own information, holds your rules, and captures the request for your team to confirm. Live in the UAE.",
  headline: "Call answering, by a receptionist that reads your own information",
  lead:
    "A call answering service takes a message. Belline answers the question, holds the rule you set, and captures the request with everything your team needs to confirm it — from the hours, prices and policies you gave it.",
  intro:
    "Most call answering is a stranger with a script, reading your business name off a screen and writing down a number. It is better than a voicemail and everybody knows the difference on the first sentence. The useful version answers the question the caller actually rang with — what does it cost, are you open on Friday, can I come Saturday — and that needs the caller to be talking to something that has read your price list.",
  sections: [
    {
      head: "What a message-taking service cannot do",
      body:
        "It cannot tell a caller what a half head of highlights costs, whether you are open after iftar, or that a first colour needs a patch test forty-eight hours before. So it writes the question down, and somebody in your team rings back to answer a question that was already answered in a document you wrote two years ago. A great many of the calls a small business takes are that call.",
    },
    {
      head: "Answering is not the same as deciding",
      body:
        "Belline answers from your own material and stops where your material stops. It takes the request — the name, the number, the service, the day that suits — and your team confirms it. Nothing enters your diary because a machine put it there, which is the line this product does not cross and the reason it can be trusted with the ones it does.",
    },
    {
      head: "It holds the rule when the caller pushes",
      body:
        "Deposits, cancellation windows, patch tests, assessments before treatment, party sizes that need a person. A rule is only a rule if it survives a caller in a hurry at five on a Thursday, and this is the part a human answering service genuinely cannot do for you: the stranger with the script has no idea your policy exists.",
    },
    {
      head: "It answers the calls you do not want to lose, not all of them",
      body:
        "Most businesses forward only the calls nobody picks up, or the ones that arrive when the line is busy or the shop is closed. Your team still gets first refusal on every call, the handset on your counter rings exactly as it does today, and what changes is what happens at the fourth ring instead of nothing.",
    },
  ],
  boundary:
    "Belline is not a switchboard and not a contact centre. It does not make outbound calls to your customers, does not take a card number or a payment, does not confirm a booking itself, and does not answer a clinical or a legal question. It answers in English, and it says it is an AI if a caller asks.",
  faqs: [
    {
      q: "How is this different from an answering service?",
      a:
        "An answering service takes a message. Belline answers from your own hours, prices and rules, and captures a request with enough detail to act on — and where it cannot answer, it takes the message and marks it, which is the answering service's whole job as a fallback rather than the product.",
    },
    {
      q: "Do we keep our own number?",
      a:
        "Yes. You set call forwarding on the line you already have, so what is printed on your door, your listings and your receipts does not change. Your phone provider may charge for forwarded calls; that is between you and them and it is worth checking before you switch it on.",
    },
    {
      q: "Can we have it answer only after hours?",
      a:
        "That is the most common setup. Forward on no-answer or on busy, or forward everything outside your opening hours — it is a setting on your line rather than anything you configure with us, and you can change it back in a minute.",
    },
    {
      q: "Does it take a message when it cannot answer?",
      a:
        "Yes, and it is as much of the product as the answering is. It captures the caller's number and what they said in their own words, marks why it could not answer, and puts it in your inbox. A summary and a full transcript of every conversation arrive with it, and Belline does not record the audio of the calls it answers.",
    },
    {
      q: "Will callers know it is not a person?",
      a:
        "If they ask, it says so. It does not claim to be a member of your team and it does not use a person's name as its own.",
    },
    {
      q: "What happens on a call it should not be handling at all?",
      a:
        "It stops. A caller describing a medical emergency hears the emergency instruction you set for your country and no request is taken; a complaint goes to a person with what the caller said and nothing offered on your behalf. Knowing what not to answer is most of what makes the rest usable.",
    },
    {
      q: "Where is it available?",
      a:
        "The United Arab Emirates, and nowhere else today. The pages for cities we are not open in say so and sell nothing, and the checkout refuses a country we cannot support.",
    },
  ],
};

export const CHANNEL_HUBS: readonly ChannelHubCopy[] = [WHATSAPP_HUB, CALL_ANSWERING_HUB];

/**
 * Trade-level WhatsApp pages.
 *
 * Four, not five. Aesthetic and medical clinics are deliberately absent, and
 * the reason is about this page rather than about the channel: Belline answers
 * a clinic's WhatsApp exactly as it answers its phone, and the aesthetic
 * clinics' own pages say so. What is missing is the *page* — a page whose
 * whole argument is "put a messaging funnel on your cosmetic treatments" is an
 * advertising claim about advertising, in a trade where what a clinic may
 * promote is bounded by its licence. That one wants the founder and a clinic's
 * compliance person, not a generated Saturday afternoon.
 */
export const CHANNEL_TRADE_PAGES: readonly ChannelTradeCopy[] = [
  WHATSAPP_RESTAURANTS,
  WHATSAPP_HAIR_SALONS,
  WHATSAPP_DENTAL,
  WHATSAPP_REAL_ESTATE,
];

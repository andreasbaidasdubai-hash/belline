import type { StepId } from "./journey";

/**
 * Short help articles for setup, one per thing owners get stuck on.
 *
 * Belle reads these with `help_article`, and the no-model fallback shows the
 * one for the step the owner is on, so the two never give different advice.
 * Plain text and UK English, written for the owner. Nothing here may promise
 * a feature that is not switched on: calendars say where they appear rather
 * than that they work.
 */

export interface HelpArticle {
  id: string;
  title: string;
  step?: StepId;
  keywords: string[];
  body: string;
}

export const HELP_ARTICLES: HelpArticle[] = [
  {
    id: "read-business",
    title: "Reading your website or price list",
    step: "import",
    keywords: ["import", "website", "read", "pdf", "menu", "price list"],
    body: "Paste your website address or add a price list, menu or brochure. Belline drafts your hours, services and answers from it. If it cannot read something, choose Set it up by hand; the form asks for the same details.",
  },
  {
    id: "review",
    title: "Checking what Belline knows",
    step: "review",
    keywords: ["review", "check", "hours", "prices", "wrong"],
    body: "Every field on the review form can be changed. Tick the ones marked for checking, such as your address, hours and prices, then press Looks right. Nothing is used on calls until you save.",
  },
  {
    id: "hours",
    title: "Opening hours",
    keywords: ["hours", "opening", "closed", "friday", "split"],
    body: "Type hours the way you would say them, for example 10:00–22:00 every day, closed Fridays. Split shifts work too: 9–13 and 16–21. The preview shows each day before you save.",
  },
  {
    id: "services",
    title: "Services and prices",
    keywords: ["service", "services", "price", "duration", "treatment"],
    body: "Each service needs a name and how long it takes. A price is optional; leave it at 0 if you would rather Belline did not quote one. You can tell Belle to add, change or remove a service.",
  },
  {
    id: "staff",
    title: "Who takes bookings",
    keywords: ["staff", "team", "stylist", "person", "people"],
    body: "Add the people customers can book with. Everyone can do every service unless you say otherwise. Removing someone does not cancel bookings they already have.",
  },
  {
    id: "faqs",
    title: "Answers to common questions",
    keywords: ["faq", "question", "answer", "parking"],
    body: "Add the questions you get every day and your answer, in your own words. Belline only says what is written here and says it does not know anything else.",
  },
  {
    id: "booking-destination",
    title: "Where bookings go",
    step: "bookings",
    keywords: ["bookings", "destination", "requests", "diary", "calendar"],
    body: "With requests, Belline takes the customer's details and tells them your team will confirm; each request arrives in your Inbox. Calendars show on the bookings step when they are available on your account, and until then you can ask to be told.",
  },
  {
    id: "booking-link",
    title: "Your own booking link",
    step: "bookings",
    keywords: ["link", "booking link", "fresha", "online booking"],
    body: "If customers already book on a page of your own, choose I have a booking link and paste it. In chats Belline gives people that link as well as taking a request.",
  },
  {
    id: "rules",
    title: "Your rules and the urgent-call number",
    step: "rules",
    keywords: ["rules", "urgent", "transfer", "escalation", "never say", "after hours"],
    body: "The urgent-call number is where Belline puts a caller through when a person is needed. It has to be a number in your own country. You can also add lines Belline must never say, and what to do when you are closed.",
  },
  {
    id: "forwarding-mobile",
    title: "Forwarding a mobile line",
    step: "channels",
    keywords: ["forward", "forwarding", "mobile", "divert", "code"],
    body: "On most mobiles you dial a short code once: one for when nobody answers, one for when the line is busy and one for when the phone is off. The Go live page shows the codes with your Belline number already in them. Then ring your own number from another phone to test it.",
  },
  {
    id: "forwarding-landline",
    title: "Forwarding a landline or business line",
    step: "channels",
    keywords: ["landline", "business line", "du", "etisalat", "e&", "101", "155"],
    body: "Landlines are forwarded by the provider. On du, call 155; on e&, call 101. Ask for conditional call forwarding, on no answer and on busy, to your Belline number.",
  },
  {
    id: "forwarding-pbx",
    title: "Office phone systems",
    step: "channels",
    keywords: ["pbx", "switchboard", "office phone", "extension"],
    body: "An office phone system forwards from its own settings. Ask whoever maintains it to send unanswered and busy calls to your Belline number.",
  },
  {
    id: "belline-number",
    title: "Your Belline number",
    step: "channels",
    keywords: ["number", "belline number", "no number"],
    body: "Calls are forwarded to your Belline number. If it is not on the Go live page yet, it is being prepared and appears there as soon as it is ready.",
  },
  {
    id: "website-snippet",
    title: "Adding the chat to your website",
    step: "channels",
    keywords: ["website", "snippet", "widget", "chat", "code", "embed", "install"],
    body: "Copy the one line from the Your website page and paste it just before the closing body tag, usually once in the shared footer. Website builders have their own place for it; the page shows the steps for yours. Publish, then open your site to check the chat button appears.",
  },
  {
    id: "test",
    title: "Trying it before you go live",
    step: "test",
    keywords: ["test", "try", "talk", "console"],
    body: "On Try it, press Run the checks. Belline has eight conversations your customers really have and checks each reply. If one does not pass, you see what it said and why: press Fix this or Fix with Belle, then run the checks again.",
  },
  {
    id: "go-live",
    title: "Going live",
    step: "golive",
    keywords: ["go live", "live", "blocker", "not ready"],
    body: "Go live appears once every step is finished. If something is still missing, the page names it with a Fix this button that opens the right place.",
  },
  {
    id: "first-week",
    title: "Your first week",
    step: "first-week",
    keywords: ["first week", "dashboard", "inbox", "enquiries"],
    body: "Real calls and chats appear on the dashboard as they come in. Anything that needs you, such as a booking request, is in the Inbox.",
  },
];

/** The article for a topic: an id, or the best keyword match. */
export function articleFor(topic: string): HelpArticle | null {
  const t = topic.trim().toLowerCase();
  if (!t) return null;
  const exact = HELP_ARTICLES.find((a) => a.id === t);
  if (exact) return exact;
  let best: { a: HelpArticle; score: number } | null = null;
  for (const a of HELP_ARTICLES) {
    const score = a.keywords.filter((k) => t.includes(k)).reduce((n, k) => n + k.length, 0);
    if (score > 0 && (!best || score > best.score)) best = { a, score };
  }
  return best?.a ?? null;
}

/** The first article for a step. */
export function articleForStep(step: StepId): HelpArticle | null {
  return HELP_ARTICLES.find((a) => a.step === step) ?? null;
}

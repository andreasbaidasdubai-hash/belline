import { id } from "../store";
import { verify, type EmailCheck } from "./email";
import { cleanText, type Lead } from "./index";
import { SIGNUP_LIMITS, clientKey, createSignupLimiter } from "../onboarding/limit";

/**
 * The waitlist on the German pages.
 *
 * Belline is not open in Germany, Austria or Switzerland, so the German
 * landing pages sell nothing: every button that says "Get started"
 * in English goes to this form. An entry is a lead like the book-a-call form's
 * (leads/index.ts), stored in the same JSON store and shown on the same staff
 * Enquiries screen, with `source: "dach-waitlist"`, the country chosen and no
 * phone number, because the form does not ask for one.
 *
 * Public and unauthenticated, so the same defences as signup and the enquiry
 * form: every field bounded and trimmed, the email's domain checked, a hidden
 * honeypot field, the signup route's rate limit, and a duplicate kept as one
 * entry. Nothing is sent to anybody: no confirmation email, no notification.
 *
 * The static site on www.belline.ai posts here across origins. Only Belline's
 * own website origins are answered with CORS headers, and a browser request
 * from anywhere else is refused outright, so another site cannot sign its
 * visitors up. Without JavaScript the browser submits the form itself, and
 * gets a short German page back instead of JSON.
 */

export const WAITLIST_SOURCE = "dach-waitlist";

/** The website origins that may post: production, www, and the Railway staging host. */
export const WAITLIST_ORIGINS = ["https://belline.ai", "https://www.belline.ai", "https://belline-staging.up.railway.app"] as const;

/**
 * The countries the waitlist takes an entry for.
 *
 * Every one of them is a market `src/lib/markets.ts` calls `not-yet`, and that
 * is the whole rule: a market we can sell in has a checkout, and a market we
 * cannot has this. DE, AT and CH came first, with the German landing pages.
 * GB and IE joined when the location landing pages went up for London,
 * Manchester and Dublin (scripts/seo/), which say plainly that we are not open
 * there and offer this instead of a price.
 *
 * `check-leads` pins every code here to a `not-yet` market, so a country can
 * never be on the waitlist and on sale at the same time.
 */
export const WAITLIST_MARKETS = ["DE", "AT", "CH", "GB", "IE"] as const;
export type WaitlistMarket = (typeof WAITLIST_MARKETS)[number];

/**
 * Which language a country's entry is answered in.
 *
 * Not a field on the form: the country already says it. The German pages
 * behaved exactly as they do now before the English markets existed, and the
 * German path through this file is unchanged — `language("DE")` is "de", and
 * every German sentence below is the sentence that was always there.
 */
type WaitlistLanguage = "de" | "en";
const GERMAN_MARKETS: readonly string[] = ["DE", "AT", "CH"];
export function waitlistLanguage(country: unknown): WaitlistLanguage {
  const code = typeof country === "string" ? country.trim().toUpperCase() : "";
  return GERMAN_MARKETS.includes(code) ? "de" : "en";
}

/** The pages an entry may come from, and so be sent back to. */
const PAGES = ["/de-de", "/de-at", "/de-ch"] as const;

/**
 * A page this entry may be sent back to.
 *
 * The three German landing pages by name, and any path under the location
 * landing pages' own root, which is generated (scripts/seo/matrix.ts) and so
 * cannot be listed here without this file importing a build script. The
 * pattern is the guard instead: lower-case, no dots, no protocol, no `//`, so
 * nothing a request sends can turn `https://belline.ai` + this into a link to
 * somewhere else. Anything that does not match falls back to the landing page.
 */
const SEO_PAGE_ROOT = "/ai-receptionist/";
function backPath(page: string, language: WaitlistLanguage): string {
  if ((PAGES as readonly string[]).includes(page)) return page;
  if (page.startsWith(SEO_PAGE_ROOT) && /^\/[a-z0-9][a-z0-9/-]{0,78}$/.test(page) && !page.includes("//")) return page;
  return language === "de" ? "/de-de" : "/";
}

/** Whether a `page` value is one of ours, for tagging the lead's source. */
const knownPage = (page: string) => (PAGES as readonly string[]).includes(page) || backPath(page, "en") === page;

/** The form's optional business types, by value. */
export const BUSINESS_TYPES = [
  "salon",
  "restaurant",
  "clinic",
  "dental",
  "fitness",
  "real-estate",
  "garage",
  "education",
  "home-services",
  "hotel",
  "pet-care",
  "professional",
  "other",
] as const;

export interface WaitlistInput {
  name?: unknown;
  email?: unknown;
  company?: unknown;
  country?: unknown;
  businessType?: unknown;
  page?: unknown;
  website2?: unknown;
  emailConfirmed?: unknown;
}

export type WaitlistResult =
  | { ok: true; lead: Lead }
  | { ok: false; field: string; error: string; suggestion?: string; confirmable?: boolean };

/**
 * Everything this form says, in both languages.
 *
 * One table rather than sentences scattered through the function, because the
 * two languages have to stay in step and a missing English string would
 * otherwise be a German sentence shown to somebody in London.
 */
const SAY = {
  de: {
    name: "Bitte geben Sie Ihren Namen an.",
    email: "Bitte geben Sie Ihre E-Mail-Adresse an.",
    emailDisposable: "Das ist ein Wegwerf-Postfach. Bitte nutzen Sie eine Adresse, unter der Sie erreichbar sind.",
    emailNoMx: "An diese Domain kann keine E-Mail zugestellt werden. Bitte prüfen Sie die Schreibweise.",
    emailOdd: "Diese E-Mail-Adresse sieht nicht richtig aus. Bitte prüfen Sie sie.",
    didYouMean: (s: string) => `Meinten Sie ${s}?`,
    company: "Bitte geben Sie den Namen Ihres Unternehmens an.",
    country: "Bitte wählen Sie Deutschland, Österreich oder die Schweiz.",
    businessType: "Bitte wählen Sie eine Branche aus der Liste oder lassen Sie das Feld leer.",
    discarded: "Verworfen.",
    badOrigin: "Von dieser Website aus ist kein Eintrag möglich.",
    tooMany: "Zu viele Einträge von diesem Anschluss. Bitte versuchen Sie es in einer Stunde noch einmal.",
    unreadable: "Die Anfrage konnte nicht gelesen werden.",
    done: "Wir melden uns, wenn Belline in Ihrem Land startet. Eine E-Mail schicken wir Ihnen jetzt nicht.",
    already: "Sie stehen bereits auf der Warteliste. Wir melden uns, wenn Belline in Ihrem Land startet.",
    quietOk: "Wir melden uns, wenn Belline in Ihrem Land startet.",
    okTitle: "Danke, Sie stehen auf der Warteliste.",
    failTitle: "Das hat nicht geklappt.",
    back: "Zurück zu Belline",
    lang: "de",
  },
  en: {
    name: "Please tell us your name.",
    email: "Please give us your email address.",
    emailDisposable: "That is a disposable mailbox. Please use an address we can actually reach you at.",
    emailNoMx: "Email cannot be delivered to that domain. Please check the spelling.",
    emailOdd: "That email address does not look right. Please check it.",
    didYouMean: (s: string) => `Did you mean ${s}?`,
    company: "Please tell us your company's name.",
    country: "Please choose the United Kingdom or Ireland.",
    businessType: "Please choose a business type from the list, or leave it empty.",
    discarded: "Discarded.",
    badOrigin: "Entries cannot be made from this website.",
    tooMany: "Too many entries from this connection. Please try again in an hour.",
    unreadable: "The request could not be read.",
    done: "We will write to you when Belline opens in your country. We are not emailing you now.",
    already: "You are already on the waitlist. We will write when Belline opens in your country.",
    quietOk: "We will write to you when Belline opens in your country.",
    okTitle: "Thank you — you are on the waitlist.",
    failTitle: "That did not work.",
    back: "Back to Belline",
    lang: "en",
  },
} as const;

/**
 * The email checker's refusal, in the reader's language. `verify` writes for
 * the English form; the reason it gives decides which sentence is true.
 */
function emailProblem(check: EmailCheck, language: WaitlistLanguage): string {
  const say = SAY[language];
  if (check.disposable) return say.emailDisposable;
  if (check.mx === false) return say.emailNoMx;
  return say.emailOdd;
}

/** Validate one waitlist entry and build the lead to store. */
export async function buildWaitlistEntry(input: WaitlistInput, check: (email: string) => Promise<EmailCheck> = verify): Promise<WaitlistResult> {
  // The country decides the language of every sentence below, including the
  // ones read before the country is validated: a form posted from the London
  // page carries country=GB whether or not the name is filled in.
  const say = SAY[waitlistLanguage(input.country)];

  if (cleanText(input.website2, 10)) return { ok: false, field: "website2", error: say.discarded };

  const name = cleanText(input.name, 120);
  if (name.length < 2) return { ok: false, field: "name", error: say.name };

  const typed = cleanText(input.email, 254);
  if (!typed) return { ok: false, field: "email", error: say.email };
  const emailCheck = await check(typed);
  if (!emailCheck.valid) {
    return { ok: false, field: "email", error: emailProblem(emailCheck, say.lang), suggestion: emailCheck.suggestion };
  }
  if (emailCheck.suggestion && !(input.emailConfirmed === true || input.emailConfirmed === "1" || input.emailConfirmed === "true")) {
    return { ok: false, field: "email", error: say.didYouMean(emailCheck.suggestion), suggestion: emailCheck.suggestion, confirmable: true };
  }

  const company = cleanText(input.company, 160);
  if (company.length < 2) return { ok: false, field: "company", error: say.company };

  const country = cleanText(input.country, 4).toUpperCase();
  if (!(WAITLIST_MARKETS as readonly string[]).includes(country)) {
    return { ok: false, field: "country", error: say.country };
  }

  const type = cleanText(input.businessType, 40);
  if (type && !(BUSINESS_TYPES as readonly string[]).includes(type)) {
    return { ok: false, field: "businessType", error: say.businessType };
  }

  // Long enough for a location landing page's path
  // (/ai-receptionist/dental-clinics/manchester), which the German pages'
  // twenty characters were not.
  const page = cleanText(input.page, 80);
  return {
    ok: true,
    lead: {
      id: id("lead"),
      createdAt: new Date().toISOString(),
      name,
      email: emailCheck.email!,
      phone: "",
      phoneValid: false,
      company,
      intent: "Waitlist: tell them when Belline opens in their country",
      vertical: type || undefined,
      // `WAITLIST_SOURCE` is still "dach-waitlist" for an entry from London,
      // and deliberately so: it is the key the stored leads and the staff
      // Enquiries screen are already filed under, and renaming it would
      // orphan every entry taken so far. The country is in `market`, which is
      // what anybody reading the list actually looks at.
      source: knownPage(page) ? `${WAITLIST_SOURCE} ${page}` : WAITLIST_SOURCE,
      market: country as WaitlistMarket,
      emailCheck,
      status: "new",
    },
  };
}

/** Is this lead a waitlist entry? `source` may carry the page after the name. */
export function isWaitlistLead(lead: Pick<Lead, "source">): boolean {
  return lead.source === WAITLIST_SOURCE || lead.source.startsWith(`${WAITLIST_SOURCE} `);
}

/** An entry with the same email in the last six hours is the same person, pressing twice. */
export function findWaitlistDuplicate(existing: Lead[], lead: Lead, windowMs = 6 * 60 * 60 * 1000): Lead | undefined {
  const cutoff = Date.now() - windowMs;
  return existing.find((l) => isWaitlistLead(l) && l.email === lead.email && Date.parse(l.createdAt) >= cutoff);
}

/** The CORS headers for a request from `origin`: only ever Belline's own website. */
export function waitlistCors(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = { vary: "Origin" };
  if (origin && (WAITLIST_ORIGINS as readonly string[]).includes(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers["access-control-allow-methods"] = "POST, OPTIONS";
    headers["access-control-allow-headers"] = "content-type";
    headers["access-control-max-age"] = "86400";
  }
  return headers;
}

/** A browser names its page's origin; a request with none (a script, a test) is judged on its contents alone. */
export function originAllowed(origin: string | null): boolean {
  return !origin || (WAITLIST_ORIGINS as readonly string[]).includes(origin);
}

export interface WaitlistDeps {
  limiter: ReturnType<typeof createSignupLimiter>;
  list: () => Lead[];
  save: (lead: Lead) => void;
  check?: (email: string) => Promise<EmailCheck>;
}

/** The route's limiter: exactly the signup route's limits, in its own buckets. */
export function createWaitlistLimiter() {
  return createSignupLimiter(SIGNUP_LIMITS);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * The page a browser without JavaScript gets back. Plain, German, and with a
 * link back to the page it came from — only ever one of the three German
 * pages, never a URL the request chose. No "ß", so it reads right in
 * Switzerland too.
 */
function htmlPage(
  title: string,
  body: string,
  page: string,
  status: number,
  headers: Record<string, string>,
  language: WaitlistLanguage = "de",
): Response {
  const say = SAY[language];
  const anchor = language === "de" ? "#warteliste" : "#waitlist";
  const back = `https://belline.ai${backPath(page, language)}`;
  const html = `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} – Belline</title>
<style>body{font:17px/1.47 -apple-system,BlinkMacSystemFont,'SF Pro Text',Inter,'Helvetica Neue',Arial,sans-serif;color:#1D1D1F;max-width:560px;margin:12vh auto;padding:0 20px}h1{font-size:1.6rem;line-height:1.25}a{color:#0066CC}</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(body)}</p>
<p><a href="${back}${anchor}">${escapeHtml(say.back)}</a></p>
</body>
</html>
`;
  return new Response(html, { status, headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
}

/**
 * One request to the waitlist route, end to end. Plain `Request` and
 * `Response`, so check-leads exercises exactly what the route runs.
 */
export async function handleWaitlist(request: Request, deps: WaitlistDeps): Promise<Response> {
  const origin = request.headers.get("origin");
  const cors = waitlistCors(origin);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: originAllowed(origin) && origin ? 204 : 403, headers: cors });
  }

  const form = /application\/x-www-form-urlencoded|multipart\/form-data/i.test(request.headers.get("content-type") ?? "");
  // German until the body is read and its country says otherwise: the
  // refusals that happen before there is a body — a forbidden origin, a rate
  // limit, an unreadable request — are exactly as they were.
  let language: WaitlistLanguage = "de";
  const reply = (status: number, body: Record<string, unknown>, page = "") =>
    form
      ? htmlPage(
          status === 200 ? SAY[language].okTitle : SAY[language].failTitle,
          String(body.message ?? body.error ?? ""),
          page,
          status,
          cors,
          language,
        )
      : Response.json(body, { status, headers: cors });

  if (!originAllowed(origin)) {
    return reply(403, { error: SAY[language].badOrigin });
  }

  const key = clientKey(request.headers);
  if (deps.limiter.blocked(key)) {
    return reply(429, { error: SAY[language].tooMany });
  }

  let input: WaitlistInput;
  try {
    input = form ? (Object.fromEntries((await request.formData()).entries()) as WaitlistInput) : ((await request.json()) as WaitlistInput);
  } catch {
    deps.limiter.record(key, false);
    return reply(400, { error: SAY[language].unreadable });
  }
  if (!input || typeof input !== "object") {
    deps.limiter.record(key, false);
    return reply(400, { error: SAY[language].unreadable });
  }
  language = waitlistLanguage(input.country);
  const say = SAY[language];
  const page = typeof input.page === "string" ? input.page : "";

  const result = await buildWaitlistEntry(input, deps.check);
  if (!result.ok) {
    deps.limiter.record(key, false);
    // A bot that filled the hidden field is told it worked, so it does not retry.
    if (result.field === "website2") return reply(200, { ok: true, message: say.quietOk }, page);
    return reply(422, { error: result.error, field: result.field, suggestion: result.suggestion, confirmable: result.confirmable }, page);
  }

  if (findWaitlistDuplicate(deps.list(), result.lead)) {
    deps.limiter.record(key, false);
    return reply(200, { ok: true, duplicate: true, message: say.already }, page);
  }

  deps.save(result.lead);
  deps.limiter.record(key, true);
  return reply(200, { ok: true, message: say.done }, page);
}

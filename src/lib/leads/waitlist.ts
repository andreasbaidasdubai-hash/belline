import { id } from "../store";
import { verify, type EmailCheck } from "./email";
import { cleanText, type Lead } from "./index";
import { SIGNUP_LIMITS, clientKey, createSignupLimiter } from "../onboarding/limit";

/**
 * The waitlist on the German pages.
 *
 * Belline is not open in Germany, Austria or Switzerland, so the German
 * landing pages sell nothing: every button that says "Connect your business"
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

export const WAITLIST_MARKETS = ["DE", "AT", "CH"] as const;
export type WaitlistMarket = (typeof WAITLIST_MARKETS)[number];

/** The German pages an entry may come from, and so be sent back to. */
const PAGES = ["/de-de", "/de-at", "/de-ch"] as const;

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
 * The email checker's refusals, in German. `verify` writes for the English
 * form; the reason it gives decides which German sentence is true.
 */
function emailProblemDe(check: EmailCheck): string {
  if (check.disposable) return "Das ist ein Wegwerf-Postfach. Bitte nutzen Sie eine Adresse, unter der Sie erreichbar sind.";
  if (check.mx === false) return "An diese Domain kann keine E-Mail zugestellt werden. Bitte prüfen Sie die Schreibweise.";
  return "Diese E-Mail-Adresse sieht nicht richtig aus. Bitte prüfen Sie sie.";
}

/** Validate one waitlist entry and build the lead to store. */
export async function buildWaitlistEntry(input: WaitlistInput, check: (email: string) => Promise<EmailCheck> = verify): Promise<WaitlistResult> {
  if (cleanText(input.website2, 10)) return { ok: false, field: "website2", error: "Verworfen." };

  const name = cleanText(input.name, 120);
  if (name.length < 2) return { ok: false, field: "name", error: "Bitte geben Sie Ihren Namen an." };

  const typed = cleanText(input.email, 254);
  if (!typed) return { ok: false, field: "email", error: "Bitte geben Sie Ihre E-Mail-Adresse an." };
  const emailCheck = await check(typed);
  if (!emailCheck.valid) return { ok: false, field: "email", error: emailProblemDe(emailCheck), suggestion: emailCheck.suggestion };
  if (emailCheck.suggestion && !(input.emailConfirmed === true || input.emailConfirmed === "1" || input.emailConfirmed === "true")) {
    return { ok: false, field: "email", error: `Meinten Sie ${emailCheck.suggestion}?`, suggestion: emailCheck.suggestion, confirmable: true };
  }

  const company = cleanText(input.company, 160);
  if (company.length < 2) return { ok: false, field: "company", error: "Bitte geben Sie den Namen Ihres Unternehmens an." };

  const country = cleanText(input.country, 4).toUpperCase();
  if (!(WAITLIST_MARKETS as readonly string[]).includes(country)) {
    return { ok: false, field: "country", error: "Bitte wählen Sie Deutschland, Österreich oder die Schweiz." };
  }

  const type = cleanText(input.businessType, 40);
  if (type && !(BUSINESS_TYPES as readonly string[]).includes(type)) {
    return { ok: false, field: "businessType", error: "Bitte wählen Sie eine Branche aus der Liste oder lassen Sie das Feld leer." };
  }

  const page = cleanText(input.page, 20);
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
      source: (PAGES as readonly string[]).includes(page) ? `${WAITLIST_SOURCE} ${page}` : WAITLIST_SOURCE,
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
function htmlPage(title: string, body: string, page: string, status: number, headers: Record<string, string>): Response {
  const back = `https://belline.ai${(PAGES as readonly string[]).includes(page) ? page : "/de-de"}`;
  const html = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} – Belline</title>
<style>body{font:16px/1.6 system-ui,sans-serif;color:#1B2735;max-width:560px;margin:12vh auto;padding:0 20px}h1{font-size:1.6rem;line-height:1.25}a{color:#1E54D6}</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(body)}</p>
<p><a href="${back}#warteliste">Zurück zu Belline</a></p>
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
  const reply = (status: number, body: Record<string, unknown>, page = "") =>
    form
      ? htmlPage(
          status === 200 ? "Danke, Sie stehen auf der Warteliste." : "Das hat nicht geklappt.",
          String(body.message ?? body.error ?? ""),
          page,
          status,
          cors,
        )
      : Response.json(body, { status, headers: cors });

  if (!originAllowed(origin)) {
    return reply(403, { error: "Von dieser Website aus ist kein Eintrag möglich." });
  }

  const key = clientKey(request.headers);
  if (deps.limiter.blocked(key)) {
    return reply(429, { error: "Zu viele Einträge von diesem Anschluss. Bitte versuchen Sie es in einer Stunde noch einmal." });
  }

  let input: WaitlistInput;
  try {
    input = form ? (Object.fromEntries((await request.formData()).entries()) as WaitlistInput) : ((await request.json()) as WaitlistInput);
  } catch {
    deps.limiter.record(key, false);
    return reply(400, { error: "Die Anfrage konnte nicht gelesen werden." });
  }
  if (!input || typeof input !== "object") {
    deps.limiter.record(key, false);
    return reply(400, { error: "Die Anfrage konnte nicht gelesen werden." });
  }
  const page = typeof input.page === "string" ? input.page : "";

  const result = await buildWaitlistEntry(input, deps.check);
  if (!result.ok) {
    deps.limiter.record(key, false);
    // A bot that filled the hidden field is told it worked, so it does not retry.
    if (result.field === "website2") return reply(200, { ok: true, message: "Wir melden uns, wenn Belline in Ihrem Land startet." }, page);
    return reply(422, { error: result.error, field: result.field, suggestion: result.suggestion, confirmable: result.confirmable }, page);
  }

  if (findWaitlistDuplicate(deps.list(), result.lead)) {
    deps.limiter.record(key, false);
    return reply(200, { ok: true, duplicate: true, message: "Sie stehen bereits auf der Warteliste. Wir melden uns, wenn Belline in Ihrem Land startet." }, page);
  }

  deps.save(result.lead);
  deps.limiter.record(key, true);
  return reply(200, { ok: true, message: "Wir melden uns, wenn Belline in Ihrem Land startet. Eine E-Mail schicken wir Ihnen jetzt nicht." }, page);
}

import { flag, type FlagName } from "./flags";

type Env = Record<string, string | undefined>;

/**
 * The public website's copy for capabilities behind a flag.
 *
 * The pages in `public/` are written as every flag-off build renders them:
 * that is what the checks read and the honest default. Each hand-written
 * sentence that has to change when a capability is switched on is listed here
 * with its replacement, and nobody edits it in step with an environment
 * variable. Two places apply it, from the same `flag()` the product reads:
 *
 * - `scripts/build-site.ts`, at build time, like the integrations strip
 *   (scripts/site-integrations.ts), so a static build is right for its env;
 * - `marketing.ts`, as the app's own server serves the built site, because the
 *   Docker build on Railway runs without the service's variables (there is no
 *   ARG for them, and the flag also needs the Google secrets, which do not
 *   belong in an image). A build-time switch alone would say "Coming soon" in
 *   production whatever the flag says.
 *
 * Both directions: applying "off" to a page built with the flag on puts the
 * flag-off sentences back, so the page served always matches the flag the
 * server has now.
 *
 * A sentence that no longer appears in its page is an error (`check:google`),
 * so rewording a page cannot silently strand its flag-on copy.
 *
 * Flags compose in the order they are listed. Outlook's swaps are written
 * against the page as Google's flag has already left it: its `off` is either
 * Google's flag-off sentence (Outlook alone) or Google's flag-on sentence
 * (both), and its `on` names what is then true. To apply, every swap is first
 * reverted, last flag first, and then the flags that are on are applied, first
 * flag first, so any mix of flags and any page already built with others comes
 * out the same.
 */

export interface SiteSwap {
  /** The page in `public/`, by its source name. */
  file: string;
  /** Exactly as it appears in the page. */
  off: string;
  on: string;
}

export const SITE_FLAG_COPY: Partial<Record<FlagName, SiteSwap[]>> = {
  "booking.google": [
    {
      file: "landing.html",
      off: "Soon, it will also book straight into the calendar you already use.",
      on: "It can also book straight into your Google Calendar, after checking it for times already taken.",
    },
    {
      file: "landing.html",
      off: '<span class="state state-soon cal-soon">Coming soon: books into your calendar</span>',
      on: '<span class="state state-available cal-soon">Books into Google Calendar</span>',
    },
    {
      file: "landing.html",
      off: "<dd>Belline takes booking requests today. Booking straight into Google Calendar is coming soon.</dd>",
      on: "<dd>Connect Google Calendar and Belline checks it for times already taken, then books straight into it. Outlook isn’t connected yet, so for Outlook Belline takes booking requests.</dd>",
    },
    {
      file: "privacy.html",
      off: "<li><strong>Google</strong> — only if a business connects a Google Calendar, once that connection is available. No calendar can be connected yet.</li>",
      on: "<li><strong>Google</strong> — only if a business connects a Google Calendar.</li>",
    },
    {
      file: "privacy.html",
      off: "<p>Connecting a Google Calendar is not available yet. When it is, and only if a business chooses to connect one, this is how Belline treats the information it receives from Google:</p>",
      on: "<p>Connecting a Google Calendar is optional. Only if a business chooses to connect one, this is how Belline treats the information it receives from Google:</p>",
    },
    // The German pages: the same sentences, translated, in the same order.
    {
      file: "landing.de.html",
      off: "Bald kann Belline auch direkt in den Kalender buchen, den Sie schon nutzen.",
      on: "Belline kann auch direkt in Ihren Google Calendar buchen, nachdem es dort geprüft hat, welche Zeiten schon belegt sind.",
    },
    {
      file: "landing.de.html",
      off: '<span class="state state-soon cal-soon">Demnächst: bucht in Ihren Kalender</span>',
      on: '<span class="state state-available cal-soon">Bucht in Google Calendar</span>',
    },
    {
      file: "landing.de.html",
      off: "<dd>Belline nimmt heute Buchungsanfragen auf. Direkt in Google Calendar buchen kann Belline demnächst.</dd>",
      on: "<dd>Verbinden Sie Google Calendar, und Belline prüft dort, welche Zeiten schon belegt sind, und bucht dann direkt hinein. Outlook ist noch nicht verbunden, deshalb nimmt Belline für Outlook Buchungsanfragen auf.</dd>",
    },
    {
      file: "privacy.de.html",
      off: "<li><strong>Google</strong> — nur wenn ein Unternehmen einen Google Kalender verbindet, sobald diese Verbindung verfügbar ist. Derzeit kann noch kein Kalender verbunden werden.</li>",
      on: "<li><strong>Google</strong> — nur wenn ein Unternehmen einen Google Kalender verbindet.</li>",
    },
    {
      file: "privacy.de.html",
      off: "<p>Die Verbindung eines Google Kalenders ist noch nicht verfügbar. Sobald sie verfügbar ist, und nur wenn sich ein Unternehmen dafür entscheidet, einen zu verbinden, geht Belline mit den Informationen, die es von Google erhält, wie folgt um:</p>",
      on: "<p>Die Verbindung eines Google Kalenders ist optional. Nur wenn sich ein Unternehmen dafür entscheidet, einen zu verbinden, geht Belline mit den Informationen, die es von Google erhält, wie folgt um:</p>",
    },
  ],
  "booking.outlook": [
    // The hero's lead: Outlook alone, then Google and Outlook.
    {
      file: "landing.html",
      off: "Soon, it will also book straight into the calendar you already use.",
      on: "It can also book straight into your Outlook calendar, after checking it for times already taken.",
    },
    {
      file: "landing.html",
      off: "It can also book straight into your Google Calendar, after checking it for times already taken.",
      on: "It can also book straight into your Google Calendar or Outlook, after checking it for times already taken.",
    },
    // The example calendar's badge.
    {
      file: "landing.html",
      off: '<span class="state state-soon cal-soon">Coming soon: books into your calendar</span>',
      on: '<span class="state state-available cal-soon">Books into Outlook</span>',
    },
    {
      file: "landing.html",
      off: '<span class="state state-available cal-soon">Books into Google Calendar</span>',
      on: '<span class="state state-available cal-soon">Books into Google Calendar or Outlook</span>',
    },
    // "Whatever you book with".
    {
      file: "landing.html",
      off: "<dd>Belline takes booking requests today. Booking straight into Google Calendar is coming soon.</dd>",
      on: "<dd>Connect Outlook and Belline checks it for times already taken, then books straight into it. Booking straight into Google Calendar is coming soon.</dd>",
    },
    {
      file: "landing.html",
      off: "<dd>Connect Google Calendar and Belline checks it for times already taken, then books straight into it. Outlook isn’t connected yet, so for Outlook Belline takes booking requests.</dd>",
      on: "<dd>Connect Google Calendar or Outlook and Belline checks it for times already taken, then books straight into it.</dd>",
    },
    // The privacy page: Microsoft as a processor, and its section's lead.
    {
      file: "privacy.html",
      off: "<li><strong>Microsoft</strong> — only if a business connects an Outlook calendar, once that connection is available. Outlook calendars cannot be connected to Belline yet.</li>",
      on: "<li><strong>Microsoft</strong> — only if a business connects an Outlook calendar, through Microsoft Graph.</li>",
    },
    {
      file: "privacy.html",
      off: "<p>Outlook calendars cannot be connected to Belline yet. When they can, and only if a business chooses to connect one, this is how Belline treats the information it receives from Microsoft:</p>",
      on: "<p>Connecting an Outlook calendar is optional. Only if a business chooses to connect one, this is how Belline treats the information it receives from Microsoft:</p>",
    },
    // The German pages.
    {
      file: "landing.de.html",
      off: "Bald kann Belline auch direkt in den Kalender buchen, den Sie schon nutzen.",
      on: "Belline kann auch direkt in Ihren Outlook-Kalender buchen, nachdem es dort geprüft hat, welche Zeiten schon belegt sind.",
    },
    {
      file: "landing.de.html",
      off: "Belline kann auch direkt in Ihren Google Calendar buchen, nachdem es dort geprüft hat, welche Zeiten schon belegt sind.",
      on: "Belline kann auch direkt in Ihren Google Calendar oder Ihren Outlook-Kalender buchen, nachdem es dort geprüft hat, welche Zeiten schon belegt sind.",
    },
    {
      file: "landing.de.html",
      off: '<span class="state state-soon cal-soon">Demnächst: bucht in Ihren Kalender</span>',
      on: '<span class="state state-available cal-soon">Bucht in Outlook</span>',
    },
    {
      file: "landing.de.html",
      off: '<span class="state state-available cal-soon">Bucht in Google Calendar</span>',
      on: '<span class="state state-available cal-soon">Bucht in Google Calendar oder Outlook</span>',
    },
    {
      file: "landing.de.html",
      off: "<dd>Belline nimmt heute Buchungsanfragen auf. Direkt in Google Calendar buchen kann Belline demnächst.</dd>",
      on: "<dd>Verbinden Sie Outlook, und Belline prüft dort, welche Zeiten schon belegt sind, und bucht dann direkt hinein. Direkt in Google Calendar buchen kann Belline demnächst.</dd>",
    },
    {
      file: "landing.de.html",
      off: "<dd>Verbinden Sie Google Calendar, und Belline prüft dort, welche Zeiten schon belegt sind, und bucht dann direkt hinein. Outlook ist noch nicht verbunden, deshalb nimmt Belline für Outlook Buchungsanfragen auf.</dd>",
      on: "<dd>Verbinden Sie Google Calendar oder Outlook, und Belline prüft dort, welche Zeiten schon belegt sind, und bucht dann direkt hinein.</dd>",
    },
    {
      file: "privacy.de.html",
      off: "<li><strong>Microsoft</strong> — nur wenn ein Unternehmen einen Outlook-Kalender verbindet, sobald diese Verbindung verfügbar ist. Outlook-Kalender können noch nicht mit Belline verbunden werden.</li>",
      on: "<li><strong>Microsoft</strong> — nur wenn ein Unternehmen einen Outlook-Kalender verbindet, über Microsoft Graph.</li>",
    },
    {
      file: "privacy.de.html",
      off: "<p>Outlook-Kalender können noch nicht mit Belline verbunden werden. Sobald dies möglich ist, und nur wenn sich ein Unternehmen dafür entscheidet, einen zu verbinden, geht Belline mit den Informationen, die es von Microsoft erhält, wie folgt um:</p>",
      on: "<p>Die Verbindung eines Outlook-Kalenders ist optional. Nur wenn sich ein Unternehmen dafür entscheidet, einen zu verbinden, geht Belline mit den Informationen, die es von Microsoft erhält, wie folgt um:</p>",
    },
  ],
};

/**
 * Swiss German writes "ss" for "ß". The de-CH pages are rendered from the
 * German source through this, so their flag copy is looked for the same way.
 */
export function swissSpelling(text: string): string {
  return text.replace(/ß/g, "ss");
}

/**
 * The flags as a public page may read them.
 *
 * `FLAG_STUBS=on` stands fake providers in for missing credentials so a local
 * end-to-end run can exercise a capability. That is a test harness, not a
 * product: a site built or served with stubs on must not tell the public a
 * connection is available.
 */
export function publicEnv(env: Env): Env {
  const rest = { ...env };
  delete rest.FLAG_STUBS;
  return rest;
}

/** Is this flag on, as the public website may say so? */
export function publicFlag(name: FlagName, env: Env = process.env): boolean {
  return flag(name, publicEnv(env));
}

const swap = (html: string, from: string, to: string) => html.split(from).join(to);

/**
 * The pricing catalogue's calendar line, by the flags (billing/plans.ts reads
 * it from here). Live while either calendar works, naming only what works.
 */
export function calendarConnectionText(on: { google: boolean; outlook: boolean }): string {
  if (on.google && !on.outlook) return "One Google Calendar connection";
  if (on.outlook && !on.google) return "One Microsoft Outlook connection";
  return "One Google Calendar or Microsoft Outlook connection";
}

/**
 * The German calendar line, as speak-de.ts translates `calendarConnectionText`.
 * Kept here, beside the English, so the static server needs no catalogue.
 */
export function calendarConnectionTextDe(on: { google: boolean; outlook: boolean }): string {
  if (on.google && !on.outlook) return "Eine Verbindung zu Google Calendar";
  if (on.outlook && !on.google) return "Eine Verbindung zu Microsoft Outlook";
  return "Eine Verbindung zu Google Calendar oder Microsoft Outlook";
}

/** The Starter card's last line before the calendar connection, as scripts/site-pricing.ts renders it. */
const PRICING_ANCHOR = "<li>Your own words and colours on the website buttons</li>";
const CALENDAR_LINE = /(\r?\n[ \t]*<li>One (?:Google Calendar or Microsoft Outlook|Google Calendar|Microsoft Outlook) connection<\/li>)/g;
/** The same two, on the German pages (scripts/site-pricing-de.ts). */
const PRICING_ANCHOR_DE = "<li>Ihre eigenen Texte und Farben auf den Website-Buttons</li>";
const CALENDAR_LINE_DE = /(\r?\n[ \t]*<li>Eine Verbindung zu (?:Google Calendar oder Microsoft Outlook|Google Calendar|Microsoft Outlook)<\/li>)/g;

/**
 * The pricing cards' calendar line, as the flags say it now.
 *
 * The pricing block is generated from the catalogue at build time
 * (scripts/site-pricing.ts), and the Railway image is built without the flags,
 * so a built page never lists the calendar connection. The app's server puts
 * the line in, or takes it out, exactly where a build with the flags on would
 * have rendered it, without loading the catalogue into the static server.
 */
export function applyCalendarPricing(html: string, env: Env = process.env, lang: "en" | "de" = "en"): string {
  const on = { google: publicFlag("booking.google", env), outlook: publicFlag("booking.outlook", env) };
  const anchor = lang === "de" ? PRICING_ANCHOR_DE : PRICING_ANCHOR;
  const line = lang === "de" ? CALENDAR_LINE_DE : CALENDAR_LINE;
  const text = lang === "de" ? calendarConnectionTextDe(on) : calendarConnectionText(on);
  let out = html.split(anchor).map((part, i) => (i === 0 ? part : part.replace(new RegExp(`^${line.source}`), ""))).join(anchor);
  if (on.google || on.outlook) out = out.split(anchor).join(`${anchor}\n            <li>${text}</li>`);
  return out;
}

/**
 * The page's hand-written flag copy as the flags in `env` say it.
 *
 * `spelling` is how the page was rendered from its source: the de-CH pages
 * pass `swissSpelling`, so a swap written with "ß" finds its sentence there.
 */
export function applySiteFlags(file: string, html: string, env: Env = process.env, spelling: (text: string) => string = (t) => t): string {
  const flags = Object.entries(SITE_FLAG_COPY) as [FlagName, SiteSwap[]][];
  let out =
    file === "landing.html" ? applyCalendarPricing(html, env) : file === "landing.de.html" ? applyCalendarPricing(html, env, "de") : html;
  // Back to the page as written: last flag first, each swap in reverse.
  for (const [, swaps] of [...flags].reverse()) {
    for (const s of [...swaps].reverse()) if (s.file === file) out = swap(out, spelling(s.on), spelling(s.off));
  }
  // Then forward, for the flags that are on.
  for (const [name, swaps] of flags) {
    if (!publicFlag(name, env)) continue;
    for (const s of swaps) if (s.file === file) out = swap(out, spelling(s.off), spelling(s.on));
  }
  return out;
}

/**
 * Swaps whose `off` sentence is not in its page exactly once, as "file:
 * sentence". A later flag's swap may be written against the page with the
 * earlier flags on, so it is also looked for there. Empty when all are found.
 */
export function strandedSiteCopy(read: (file: string) => string): string[] {
  const out: string[] = [];
  const flags = Object.entries(SITE_FLAG_COPY) as [FlagName, SiteSwap[]][];
  flags.forEach(([, swaps], i) => {
    for (const s of swaps) {
      const page = read(s.file);
      let earlierOn = page;
      for (const [, before] of flags.slice(0, i)) for (const b of before) if (b.file === s.file) earlierOn = swap(earlierOn, b.off, b.on);
      if (page.split(s.off).length !== 2 && earlierOn.split(s.off).length !== 2) out.push(`${s.file}: ${s.off}`);
    }
  });
  return out;
}

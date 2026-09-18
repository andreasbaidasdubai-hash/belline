import { LANGUAGE_REGISTRY, type LanguageCode } from "../config/languages";
import { flag, type FlagName } from "./flags";
import { selectableLanguages } from "./language";

type Env = Record<string, string | undefined>;

/** Each language's name in German, for the German pages' language line. */
export const GERMAN_LANGUAGE_NAMES: Record<LanguageCode, string> = {
  en: "Englisch",
  de: "Deutsch",
  fr: "Französisch",
  es: "Spanisch",
  ar: "Arabisch",
  pt: "Portugiesisch",
  it: "Italienisch",
  nl: "Niederländisch",
  tr: "Türkisch",
};

/**
 * The languages Belle answers in on a page for this country ("AE", "DE",
 * "AT", "CH"), as the registry and the flags say now: every selectable
 * language (live, its flag on, its customer lines and guards complete,
 * lib/language.ts) that is English, the fallback everywhere, or that has a
 * variant for the country (ar-AE, de-CH, fr-CH). The page's own language
 * first. Arabic is a planned slot today, so the UAE page says English until
 * Arabic is live, and then says both without anybody editing it.
 */
export function heroLanguages(country: string, pageLanguage: "en" | "de", env: Env = process.env): LanguageCode[] {
  const codes = selectableLanguages(publicEnv(env))
    .filter((l) => l.code === "en" || l.variants.some((v) => v.tag.split("-")[1] === country))
    .map((l) => l.code as LanguageCode);
  return [...codes.filter((c) => c === pageLanguage), ...codes.filter((c) => c !== pageLanguage)];
}

const listed = (names: string[], and: string) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} ${and} ${names[names.length - 1]}`);

/** The line for these languages, in the page's own language: "Answers in English and Arabic." */
export function languagesLine(codes: readonly LanguageCode[], pageLanguage: "en" | "de"): string {
  if (pageLanguage === "en") {
    const names = codes.map((c) => LANGUAGE_REGISTRY.find((l) => l.code === c)!.name);
    return `Answers in ${listed(names, "and")}.`;
  }
  const names = codes.map((c) => GERMAN_LANGUAGE_NAMES[c]);
  return names.length === 1 ? `Belline antwortet derzeit auf ${names[0]}.` : `Belline antwortet auf ${listed(names, "und")}.`;
}

/** "Answers in English." / "Belline antwortet auf Deutsch und Englisch.", as the registry and the flags say now. */
export function heroLanguagesText(country: string, pageLanguage: "en" | "de", env: Env = process.env): string {
  return languagesLine(heroLanguages(country, pageLanguage, env), pageLanguage);
}

const HERO_LANGUAGES = /(<span class="hero-langs" data-langs>)[^<]*(<\/span>)/g;

/**
 * The hero's language line (`<span class="hero-langs" data-langs>`), written
 * from `heroLanguagesText` for the page's own country, read from its
 * `<html lang>` (the English page is the UAE's). Applied with the flag copy, at
 * build time and as the app's server serves, so `language.de` decides it the
 * same way `booking.google` decides the calendar lines.
 */
export function applyHeroLanguages(html: string, env: Env = process.env): string {
  const tag = /<html lang="([a-z]{2})(?:-([A-Z]{2}))?"/.exec(html);
  const pageLanguage = tag?.[1] === "de" ? "de" : "en";
  const country = tag?.[2] ?? (pageLanguage === "de" ? "DE" : "AE");
  const text = heroLanguagesText(country, pageLanguage, env);
  return html.replace(HERO_LANGUAGES, (_m, open: string, close: string) => `${open}${text}${close}`);
}

/**
 * The channels the hero's eyebrow may name, in the order it names them.
 *
 * The website is the product itself — the widget is what every plan starts
 * with, and it needs no credential to be true. The telephone and WhatsApp are
 * claims about a connection, so each is named only while its own flag is on:
 * `channel.phone` needs Twilio and the speech providers, WhatsApp needs Meta
 * (either route to it counts). On an environment with neither, the eyebrow
 * says "for your website" and nothing more, which is what a build of this
 * repo with no credentials renders.
 */
export function heroChannels(pageLanguage: "en" | "de", env: Env = process.env): string[] {
  const phone = publicFlag("channel.phone", env);
  const whatsapp = publicFlag("channel.whatsapp.selfserve", env) || publicFlag("channel.whatsapp.embedded", env);
  const words =
    pageLanguage === "en"
      ? { site: "your website", phone: "telephone", whatsapp: "WhatsApp" }
      : { site: "Ihre Website", phone: "Telefon", whatsapp: "WhatsApp" };
  return [words.site, ...(phone ? [words.phone] : []), ...(whatsapp ? [words.whatsapp] : [])];
}

/** "AI receptionist for your website, telephone & WhatsApp" — as many channels as are actually live. */
export function heroEyebrowText(pageLanguage: "en" | "de", env: Env = process.env): string {
  const names = heroChannels(pageLanguage, env);
  // "a, b & c": an ampersand rather than "and" so the line stays one breath
  // wide on a phone, where the eyebrow sits above a display headline.
  const list = names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`;
  return pageLanguage === "en" ? `AI receptionist for ${list}` : `KI-Empfang für ${list}`;
}

const HERO_EYEBROW = /(<p class="eyebrow rise">)[^<]*(<\/p>)/;

/**
 * The hero's eyebrow, written from the flags rather than from the file.
 *
 * It used to be one of `video.avatar`'s swaps ("AI video receptionist for your
 * website"). The founder's line names the three channels instead of the
 * medium, and three channels cannot be a swap: a swap's `off` has to be the
 * page exactly as the earlier flags left it, and phone and WhatsApp are two
 * independent flags, so there would be four `off` strings to write and keep in
 * step. Computed here it is one sentence built from the flags that are on,
 * like the hero's language line above it, and it can never claim a channel the
 * environment has not got.
 */
export function applyHeroEyebrow(html: string, env: Env = process.env): string {
  const pageLanguage = /<html lang="de/.test(html) ? "de" : "en";
  const text = heroEyebrowText(pageLanguage, env);
  return html.replace(HERO_EYEBROW, (_m, open: string, close: string) => `${open}${text}${close}`);
}

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
  /** Exactly as it appears in the page, on one line. */
  off: string;
  on: string;
  /** How many times `off` is in the page (default once): the example's three channels share Belle's last line. */
  count?: number;
}

/**
 * The landing pages' flagged pieces (site review, 2026-09-17).
 *
 * - The hero's capability row: "Takes booking requests", or what books.
 * - The example conversations (one salon customer on chat, phone and
 *   WhatsApp): Belle's last line passes the request on, or books the time.
 * - The example calendar under them: its badge, and the customer's entry,
 *   "Waiting for your team" or "Confirmed". Never both at once.
 * - "Whatever you book with": Google Calendar and Outlook, one entry each.
 */
const EN = {
  canOff: '<li class="can-cal">Takes booking requests</li>',
  canGoogle: '<li class="can-cal">Books into Google Calendar</li>',
  canOutlook: '<li class="can-cal">Books into Outlook</li>',
  canBoth: '<li class="can-cal">Books into Google Calendar or Outlook</li>',
  badgeOff: '<span class="state state-soon cal-soon">Coming soon: books into your calendar</span>',
  badgeGoogle: '<span class="state state-available cal-soon">Books into Google Calendar</span>',
  badgeOutlook: '<span class="state state-available cal-soon">Books into Outlook</span>',
  badgeBoth: '<span class="state state-available cal-soon">Books into Google Calendar or Outlook</span>',
  sayOff: "I’ll pass that to the team, and they’ll confirm a time with you.",
  sayOn: "Saturday at 10:00 is free, so I’ve booked you in.",
  entryOff:
    '<li class="cal-ev cal-ev-new"><span class="cal-new-k">New request from Belline</span><span class="cal-new-what">Layla H., balayage, Saturday morning</span><span class="cal-new-state">Waiting for your team</span></li>',
  entryOn:
    '<li class="cal-ev cal-ev-new is-booked"><span class="cal-new-k">Booked by Belline</span><span class="cal-new-what">10:00 Layla H., balayage</span><span class="cal-new-state">Confirmed</span></li>',
  googleOff: "<dd>Belline takes booking requests today. Booking straight into Google Calendar is coming soon.</dd>",
  googleOn: "<dd>Connect Google Calendar and Belline checks it for times already taken, then books straight into it.</dd>",
  outlookOff: "<dd>Belline takes booking requests today. Booking straight into Outlook is coming soon.</dd>",
  outlookOn: "<dd>Connect Outlook and Belline checks it for times already taken, then books straight into it.</dd>",
};

const DE = {
  canOff: '<li class="can-cal">Nimmt Buchungsanfragen auf</li>',
  canGoogle: '<li class="can-cal">Bucht in Google Calendar</li>',
  canOutlook: '<li class="can-cal">Bucht in Outlook</li>',
  canBoth: '<li class="can-cal">Bucht in Google Calendar oder Outlook</li>',
  badgeOff: '<span class="state state-soon cal-soon">Demnächst: bucht in Ihren Kalender</span>',
  badgeGoogle: '<span class="state state-available cal-soon">Bucht in Google Calendar</span>',
  badgeOutlook: '<span class="state state-available cal-soon">Bucht in Outlook</span>',
  badgeBoth: '<span class="state state-available cal-soon">Bucht in Google Calendar oder Outlook</span>',
  sayOff: "Ich gebe das an das Team weiter, und das Team stimmt einen Termin mit Ihnen ab.",
  sayOn: "Samstag um 10:00 ist frei, ich habe den Termin für Sie eingetragen.",
  entryOff:
    '<li class="cal-ev cal-ev-new"><span class="cal-new-k">Neue Anfrage von Belline</span><span class="cal-new-what">Lena W., Balayage, Samstagvormittag</span><span class="cal-new-state">Wartet auf Ihr Team</span></li>',
  entryOn:
    '<li class="cal-ev cal-ev-new is-booked"><span class="cal-new-k">Von Belline eingetragen</span><span class="cal-new-what">10:00 Lena W., Balayage</span><span class="cal-new-state">Bestätigt</span></li>',
  googleOff: "<dd>Belline nimmt heute Buchungsanfragen auf. Direkt in Google Calendar buchen kann Belline demnächst.</dd>",
  googleOn: "<dd>Verbinden Sie Google Calendar, und Belline prüft dort, welche Zeiten schon belegt sind, und bucht dann direkt hinein.</dd>",
  outlookOff: "<dd>Belline nimmt heute Buchungsanfragen auf. Direkt in Outlook buchen kann Belline demnächst.</dd>",
  outlookOn: "<dd>Verbinden Sie Outlook, und Belline prüft dort, welche Zeiten schon belegt sind, und bucht dann direkt hinein.</dd>",
};

type Words = typeof EN;

function googleSwaps(file: string, w: Words): SiteSwap[] {
  return [
    { file, off: w.canOff, on: w.canGoogle },
    { file, off: w.badgeOff, on: w.badgeGoogle },
    { file, off: w.sayOff, on: w.sayOn, count: 3 },
    { file, off: w.entryOff, on: w.entryOn },
    { file, off: w.googleOff, on: w.googleOn },
  ];
}

/** Outlook alone, then Google and Outlook: written against the page as Google's flag leaves it. */
function outlookSwaps(file: string, w: Words): SiteSwap[] {
  return [
    { file, off: w.canOff, on: w.canOutlook },
    { file, off: w.canGoogle, on: w.canBoth },
    { file, off: w.badgeOff, on: w.badgeOutlook },
    { file, off: w.badgeGoogle, on: w.badgeBoth },
    // The conversation and the entry read the same whichever calendar it is.
    { file, off: w.sayOff, on: w.sayOn, count: 3 },
    { file, off: w.entryOff, on: w.entryOn },
    { file, off: w.outlookOff, on: w.outlookOn },
  ];
}

/**
 * The video receptionist on the landing pages (`video.avatar`, as the
 * catalogue's `videoLive` reads it). The pages in `public/` say nothing about
 * video; with the flag on they lead with it: the hero's lead and Belle's
 * caption, "What Belline does" with video first, the pricing lead,
 * each card's video row and the trial's video minutes, the two video
 * questions in the FAQ and in its structured data, and the footer.
 *
 * The card rows and the trial are generated (scripts/site-pricing.ts emits
 * them only while video is live), and so are the "video-ratio" and
 * "faq-video" phrases: the words here are what a build with the flag on
 * renders, and check-billing holds them to it, so a catalogue change cannot
 * leave them behind. Every `on` is one line, so a CRLF checkout serves the
 * same page.
 *
 * The eyebrow is not one of these. It names the channels Belline answers
 * rather than the medium it answers them in, and `applyHeroEyebrow` writes it
 * from the phone and WhatsApp flags.
 */
const VIDEO_EN = {
  lead: ["Belline puts an AI receptionist on your website chat and voice button,", "Belline puts an AI receptionist on your website, on video, plus chat,"],
  caption: [
    '<span class="hv-title">Belle on your website</span> <span class="state state-available">Available</span>',
    '<span class="hv-title">Belle on video</span> <span class="state state-available">Included in every plan</span>',
  ],
  ratio: ['<p class="hv-early">Included in every plan.</p>', '<p class="hv-early"><span class="gen" data-gen="video-ratio">Included in every plan. Each video minute uses 2.5 voice minutes.</span></p>'],
  channelsLead: ["Chat and voice on your website, WhatsApp and your", "Belle on video on your website, then chat and voice, WhatsApp and your"],
  channels: [
    '<ul class="channels channels-4 channels-3">',
    '<ul class="channels channels-4"><li><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="6" width="13" height="12" rx="2.5"/><path d="m15.5 10.5 6-3.5v10l-6-3.5"/></svg><div class="channel-head"><h3>Video receptionist on your website</h3><span class="state state-available">Included in every plan</span></div><p>Belle greets visitors face to face and answers out loud, right in their browser. It uses their microphone, never their camera.</p><p class="channel-how">The same line of HTML as the chat.</p></li>',
  ],
  priceLead: [
    "many voice minutes and text conversations they include.",
    "many voice minutes and text conversations they include, and every plan includes Belle on video, which draws on the voice minutes.",
  ],
  trial: [
    "<strong>Trial:</strong> 30 days, 30 voice minutes and 50 text conversations.",
    "<strong>Trial:</strong> 30 days, 30 voice or 12 video minutes and 50 text conversations.",
  ],
  voiceRow: (minutes: number) => `<li class="allow-voice">${minutes} voice minutes a month, shared across your phone line and your website's voice button</li>`,
  videoRow: (minutes: number) => `<li class="allow-video">Video receptionist · ${minutes} video minutes (each uses 2.5 voice minutes)</li>`,
  faq: [
    "<!-- faq:video -->",
    '<details><summary>Can Belle answer our website visitors on video?</summary><div class="answer"><p>Yes, on every plan. Belle answers on video, by voice, in the visitor’s browser: it uses their microphone, never their camera.</p></div></details><details><summary>How are video minutes counted?</summary><div class="answer"><p class="gen" data-gen="faq-video">Each video minute uses 2.5 of your plan’s voice minutes, so a plan’s voice minutes cover up to 30 video minutes on Starter, 100 video minutes on Growth and 200 video minutes on Scale.</p></div></details>',
  ],
  faqData: [
    'You can turn it off yourself at any time." } },',
    'You can turn it off yourself at any time." } }, { "@type": "Question", "name": "Can Belle answer our website visitors on video?", "acceptedAnswer": { "@type": "Answer", "text": "Yes, on every plan. Belle answers on video, by voice, in the visitor’s browser: it uses their microphone, never their camera." } }, { "@type": "Question", "name": "How are video minutes counted?", "acceptedAnswer": { "@type": "Answer", "text": "Each video minute uses 2.5 of your plan’s voice minutes, so a plan’s voice minutes cover up to 30 video minutes on Starter, 100 video minutes on Growth and 200 video minutes on Scale." } },',
  ],
  footer: ["bookings: on your website, WhatsApp and phone.", "bookings: video on your website, plus chat, WhatsApp and phone."],
};

const VIDEO_DE: typeof VIDEO_EN = {
  lead: ["Belline setzt einen KI-Empfang auf Ihren Website-Chat und Sprach-Button,", "Belline setzt einen KI-Empfang auf Ihre Website, per Video, dazu Chat,"],
  caption: [
    '<span class="hv-title">Belle auf Ihrer Website</span> <span class="state state-available">In den VAE verfügbar</span>',
    '<span class="hv-title">Belle per Video</span> <span class="state state-available">In jedem Tarif enthalten</span>',
  ],
  ratio: ['<p class="hv-early">In jedem Tarif enthalten.</p>', '<p class="hv-early"><span class="gen" data-gen="video-ratio">In jedem Tarif enthalten. Jede Videominute verbraucht 2,5 Sprachminuten.</span></p>'],
  channelsLead: ["Chat und Sprache auf Ihrer Website, WhatsApp und", "Belle per Video auf Ihrer Website, dazu Chat und Sprache, WhatsApp und"],
  channels: [
    '<ul class="channels channels-4 channels-3">',
    '<ul class="channels channels-4"><li><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="6" width="13" height="12" rx="2.5"/><path d="m15.5 10.5 6-3.5v10l-6-3.5"/></svg><div class="channel-head"><h3>Video-Empfang auf Ihrer Website</h3><span class="state state-available">In jedem Tarif enthalten</span></div><p>Belle begrüßt Besucher von Angesicht zu Angesicht und antwortet laut, direkt im Browser, derzeit auf Englisch. Dafür wird das Mikrofon genutzt, nie die Kamera.</p><p class="channel-how">Dieselbe Zeile HTML wie der Chat.</p></li>',
  ],
  priceLead: ["Textgespräche sie enthalten.", "Textgespräche sie enthalten, und jeder Tarif enthält Belle per Video, das die Sprachminuten nutzt."],
  trial: [
    "<strong>Geplante Testphase:</strong> 30 Tage, 30 Sprachminuten und 50 Textgespräche.",
    "<strong>Geplante Testphase:</strong> 30 Tage, 30 Sprach- oder 12 Videominuten und 50 Textgespräche.",
  ],
  voiceRow: (minutes: number) => `<li class="allow-voice">${minutes} Sprachminuten pro Monat, geteilt zwischen Ihrer Telefonleitung und dem Sprach-Button auf Ihrer Website</li>`,
  videoRow: (minutes: number) => `<li class="allow-video">Video-Empfang · ${minutes} Videominuten (jede verbraucht 2,5 Sprachminuten)</li>`,
  faq: [
    "<!-- faq:video -->",
    '<details><summary>Kann Belle unsere Website-Besucher per Video empfangen?</summary><div class="answer"><p>Ja, in jedem Tarif. Belle antwortet per Video und Sprache im Browser des Besuchers, derzeit auf Englisch: Dafür wird das Mikrofon genutzt, nie die Kamera.</p></div></details><details><summary>Wie werden Videominuten gezählt?</summary><div class="answer"><p class="gen" data-gen="faq-video">Jede Videominute verbraucht 2,5 der Sprachminuten Ihres Tarifs. Die Sprachminuten reichen so für bis zu 30 Videominuten bei Starter, 100 Videominuten bei Growth und 200 Videominuten bei Scale.</p></div></details>',
  ],
  faqData: [
    'Sie können sie jederzeit selbst wieder ausschalten." } },',
    'Sie können sie jederzeit selbst wieder ausschalten." } }, { "@type": "Question", "name": "Kann Belle unsere Website-Besucher per Video empfangen?", "acceptedAnswer": { "@type": "Answer", "text": "Ja, in jedem Tarif. Belle antwortet per Video und Sprache im Browser des Besuchers, derzeit auf Englisch: Dafür wird das Mikrofon genutzt, nie die Kamera." } }, { "@type": "Question", "name": "Wie werden Videominuten gezählt?", "acceptedAnswer": { "@type": "Answer", "text": "Jede Videominute verbraucht 2,5 der Sprachminuten Ihres Tarifs. Die Sprachminuten reichen so für bis zu 30 Videominuten bei Starter, 100 Videominuten bei Growth und 200 Videominuten bei Scale." } },',
  ],
  footer: ["Buchungen erhalten: auf Ihrer Website, per WhatsApp und am Telefon.", "Buchungen erhalten: per Video auf Ihrer Website, dazu Chat, WhatsApp und Telefon."],
};

/** The plans' voice minutes, and the video minutes each buys (plans.ts `videoMinutesFor`). */
const VIDEO_PLANS: [voice: number, video: number][] = [
  [75, 30],
  [250, 100],
  [500, 200],
];

function videoSwaps(file: string, w: typeof VIDEO_EN): SiteSwap[] {
  const pair = ([off, on]: string[]): SiteSwap => ({ file, off, on });
  return [
    pair(w.lead),
    pair(w.caption),
    pair(w.ratio),
    pair(w.channelsLead),
    pair(w.channels),
    pair(w.priceLead),
    pair(w.trial),
    ...VIDEO_PLANS.map(([voice, video]) => ({ file, off: w.voiceRow(voice), on: w.voiceRow(voice) + w.videoRow(video) })),
    pair(w.faq),
    pair(w.faqData),
    pair(w.footer),
  ];
}

export const SITE_FLAG_COPY: Partial<Record<FlagName, SiteSwap[]>> = {
  "booking.google": [
    ...googleSwaps("landing.html", EN),
    { file: "privacy.html", off: "<li><strong>Google</strong> — only if a business connects a Google Calendar, once that connection is available. No calendar can be connected yet.</li>", on: "<li><strong>Google</strong> — only if a business connects a Google Calendar.</li>" },
    { file: "privacy.html", off: "<p>Connecting a Google Calendar is not available yet. When it is, and only if a business chooses to connect one, this is how Belline treats the information it receives from Google:</p>", on: "<p>Connecting a Google Calendar is optional. Only if a business chooses to connect one, this is how Belline treats the information it receives from Google:</p>" },
    // The German pages: the same pieces, translated, in the same order.
    ...googleSwaps("landing.de.html", DE),
    { file: "privacy.de.html", off: "<li><strong>Google</strong> — nur wenn ein Unternehmen einen Google Kalender verbindet, sobald diese Verbindung verfügbar ist. Derzeit kann noch kein Kalender verbunden werden.</li>", on: "<li><strong>Google</strong> — nur wenn ein Unternehmen einen Google Kalender verbindet.</li>" },
    { file: "privacy.de.html", off: "<p>Die Verbindung eines Google Kalenders ist noch nicht verfügbar. Sobald sie verfügbar ist, und nur wenn sich ein Unternehmen dafür entscheidet, einen zu verbinden, geht Belline mit den Informationen, die es von Google erhält, wie folgt um:</p>", on: "<p>Die Verbindung eines Google Kalenders ist optional. Nur wenn sich ein Unternehmen dafür entscheidet, einen zu verbinden, geht Belline mit den Informationen, die es von Google erhält, wie folgt um:</p>" },
  ],
  "booking.outlook": [
    ...outlookSwaps("landing.html", EN),
    { file: "privacy.html", off: "<li><strong>Microsoft</strong> — only if a business connects an Outlook calendar, once that connection is available. Outlook calendars cannot be connected to Belline yet.</li>", on: "<li><strong>Microsoft</strong> — only if a business connects an Outlook calendar, through Microsoft Graph.</li>" },
    { file: "privacy.html", off: "<p>Outlook calendars cannot be connected to Belline yet. When they can, and only if a business chooses to connect one, this is how Belline treats the information it receives from Microsoft:</p>", on: "<p>Connecting an Outlook calendar is optional. Only if a business chooses to connect one, this is how Belline treats the information it receives from Microsoft:</p>" },
    ...outlookSwaps("landing.de.html", DE),
    { file: "privacy.de.html", off: "<li><strong>Microsoft</strong> — nur wenn ein Unternehmen einen Outlook-Kalender verbindet, sobald diese Verbindung verfügbar ist. Outlook-Kalender können noch nicht mit Belline verbunden werden.</li>", on: "<li><strong>Microsoft</strong> — nur wenn ein Unternehmen einen Outlook-Kalender verbindet, über Microsoft Graph.</li>" },
    { file: "privacy.de.html", off: "<p>Outlook-Kalender können noch nicht mit Belline verbunden werden. Sobald dies möglich ist, und nur wenn sich ein Unternehmen dafür entscheidet, einen zu verbinden, geht Belline mit den Informationen, die es von Microsoft erhält, wie folgt um:</p>", on: "<p>Die Verbindung eines Outlook-Kalenders ist optional. Nur wenn sich ein Unternehmen dafür entscheidet, einen zu verbinden, geht Belline mit den Informationen, die es von Microsoft erhält, wie folgt um:</p>" },
  ],
  "video.avatar": [...videoSwaps("landing.html", VIDEO_EN), ...videoSwaps("landing.de.html", VIDEO_DE)],
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
  if (file === "landing.html" || file === "landing.de.html") out = applyHeroEyebrow(applyHeroLanguages(out, env), env);
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
 * Swaps whose `off` sentence is not in its page exactly `count` times (once by default), as "file:
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
      const parts = (s.count ?? 1) + 1;
      if (page.split(s.off).length !== parts && earlierOn.split(s.off).length !== parts) out.push(`${s.file}: ${s.off}`);
    }
  });
  return out;
}

import { formatMoney, type Market, type PriceLocale } from "../markets";
import {
  ALERT_THRESHOLDS,
  CHANNELS,
  CATALOGUE_VERSION,
  CHANNEL_ORDER,
  POOL_CHANNELS,
  POOL_ORDER,
  PRODUCTS,
  TRIAL,
  VIDEO_VOICE_MINUTE_RATIO,
  packFor,
  videoLive,
  videoMinutesFor,
  type Channel,
  type Feature,
  type Pool,
  type Product,
} from "./plans";

/**
 * The catalogue in German, for the German landing and legal pages.
 *
 * Everything a German page says about a plan comes through here, and nothing
 * is typed into the page itself: `plans.ts` stays the one place a price, an
 * allowance or a feature is decided. What cannot be generated — a product's
 * summary, a feature's wording — is a translation keyed by the English text,
 * and a text with no translation throws. So a feature added or reworded in
 * English stops the German build (and check-billing) instead of quietly
 * shipping an English line, or yesterday's German one, on a German page.
 *
 * Every v2 feature is translated, live or not: the not-yet ones are here so
 * check-billing can prove their German wording never reaches a page either.
 */

export type GermanLocale = Exclude<PriceLocale, "en">;

/** Product summaries and feature lines, English → German. */
export const CATALOGUE_DE: Record<string, string> = {
  // Summaries
  "For a small business that wants every enquiry answered.":
    "Für kleinere Unternehmen, bei denen jede Anfrage eine Antwort bekommen soll.",
  "For a business that wants Belline answering and booking across every channel it has.":
    "Für Unternehmen, bei denen Belline auf allen Kanälen antworten und Buchungsanfragen aufnehmen soll.",
  "For higher-volume teams with more complex reception rules.":
    "Für Teams mit mehr Anfragen und komplexeren Regeln am Empfang.",
  // Features
  "One location": "Ein Standort",
  "Keep your number — forward it to Belline": "Ihre Nummer bleibt – Sie leiten sie an Belline weiter",
  "Answers questions from your own hours, prices and policies":
    "Beantwortet Fragen anhand Ihrer eigenen Öffnungszeiten, Preise und Regeln",
  "Takes booking requests and passes them to your team": "Nimmt Buchungsanfragen auf und gibt sie an Ihr Team weiter",
  "Summary and full transcript of every call and chat": "Zusammenfassung und vollständiges Transkript jedes Anrufs und Chats",
  "Your team can take over any chat from the inbox": "Ihr Team kann jeden Chat aus dem Posteingang übernehmen",
  "Your own words and colours on the website buttons": "Ihre eigenen Texte und Farben auf den Website-Buttons",
  "Video receptionist on your website": "Video-Rezeptionistin auf Ihrer Website",
  "One Google Calendar connection": "Eine Verbindung zu Google Calendar",
  "One Microsoft Outlook connection": "Eine Verbindung zu Microsoft Outlook",
  "One Google Calendar or Microsoft Outlook connection": "Eine Verbindung zu Google Calendar oder Microsoft Outlook",
  "Deposit links by text, paid into your own Stripe account": "Anzahlungslinks per SMS, bezahlt auf Ihr eigenes Stripe-Konto",
  "Puts urgent calls through to your team, live": "Stellt dringende Anrufe live zu Ihrem Team durch",
  "A reminder text the day before every booking": "Eine Erinnerungs-SMS am Tag vor jeder Buchung",
  "Your own rules about what it may and may not decide": "Ihre eigenen Regeln dafür, was Belline entscheiden darf und was nicht",
  "Every change versioned, with one-click revert": "Jede Änderung versioniert, mit Zurücksetzen per Klick",
  "Restore earlier settings any time": "Frühere Einstellungen jederzeit wiederherstellen",
  "Waitlist — when a slot frees, the guest who wanted it is at the top of your list, with their number":
    "Warteliste – wird ein Termin frei, steht der Gast, der ihn wollte, mit Nummer oben auf Ihrer Liste",
  "One specialist booking integration — Fresha, Treatwell, SevenRooms or OpenTable":
    "Eine spezialisierte Buchungsintegration – Fresha, Treatwell, SevenRooms oder OpenTable",
  "Named contact for onboarding and changes": "Feste Ansprechperson für Einrichtung und Änderungen",
  "Priority support": "Bevorzugter Support",
  "Several booking and calendar connections on one location": "Mehrere Buchungs- und Kalenderverbindungen an einem Standort",
  "Advanced routing and staff rules for calls": "Erweiterte Weiterleitungs- und Mitarbeiterregeln für Anrufe",
  "API and webhook access": "API- und Webhook-Zugang",
};

/** The German for one catalogue text. Throws when nobody has translated it. */
export function catalogueDe(english: string): string {
  const german = CATALOGUE_DE[english];
  if (german === undefined) {
    throw new Error(`No German for the catalogue text "${english}". Add it to CATALOGUE_DE in src/lib/billing/speak-de.ts.`);
  }
  return german;
}

/** Every catalogue text a German page could need, for the checks: the v2 plans' summaries and all their features. */
export function germanCatalogueTexts(): { english: string; status: Feature["status"] }[] {
  const plans = PRODUCTS.filter((p) => p.kind === "plan");
  const calendar = ["One Google Calendar connection", "One Microsoft Outlook connection", "One Google Calendar or Microsoft Outlook connection"];
  return [
    ...plans.map((p) => ({ english: p.summary, status: p.status })),
    ...plans.flatMap((p) => p.features.map((f) => ({ english: f.text, status: f.status }))),
    ...calendar.map((english) => ({ english, status: "live" as const })),
  ];
}

/** A count as the page writes it: "1.500" in Germany and Austria, "1’500" in Switzerland. */
export function countDe(n: number, locale: GermanLocale): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, locale === "de-CH" ? "’" : ".");
}

function joinDe(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} und ${items[items.length - 1]}`;
}

const POOL_PLACES_DE: Record<Channel, string> = {
  phone: "Ihrer Telefonleitung",
  web_voice: "dem Sprach-Button auf Ihrer Website",
  chat: "Ihrem Website-Chat",
  whatsapp: "WhatsApp",
};

export const POOL_NAMES_DE: Record<Pool, string> = { minutes: "Sprachminuten", conversations: "Textgespräche" };

/** One pooled allowance, naming only live channels, as `poolText` does in English. */
export function poolTextDe(pool: Pool, amount: number, locale: GermanLocale): string {
  const places = POOL_CHANNELS[pool].filter((c) => CHANNELS[c].status === "live").map((c) => POOL_PLACES_DE[c]);
  return `${countDe(amount, locale)} ${POOL_NAMES_DE[pool]} pro Monat, geteilt zwischen ${joinDe(places)}`;
}

/** `videoAllowanceText`, in German: "30 Videominuten (jede verbraucht 2,5 Sprachminuten)". */
export function videoAllowanceTextDe(voiceMinutes: number, locale: GermanLocale): string {
  const ratio = String(VIDEO_VOICE_MINUTE_RATIO).replace(".", ",");
  return `${countDe(videoMinutesFor(voiceMinutes), locale)} Videominuten (jede verbraucht ${ratio} Sprachminuten)`;
}

/**
 * The lines a pricing card may show, in German: allowances, users, then the
 * live features — the same selection and order as `allowanceFeatures` and
 * `publicLines` make in English.
 */
export function allowanceLinesDe(product: Product, locale: GermanLocale): { text: string; status: Feature["status"] }[] {
  const pools = POOL_ORDER.filter((pool) => typeof product.pools?.[pool] === "number").map((pool) => ({
    text: poolTextDe(pool, product.pools![pool]!, locale),
    status: POOL_CHANNELS[pool].some((c) => CHANNELS[c].status === "live") ? ("live" as const) : ("not-yet" as const),
  }));
  // The video line, in the same place and on the same terms as `allowanceFeatures`.
  if (typeof product.pools?.minutes === "number" && product.version === CATALOGUE_VERSION) {
    pools.push({ text: videoAllowanceTextDe(product.pools.minutes, locale), status: videoLive() ? "live" : "not-yet" });
  }
  const users = product.users ? [{ text: `Bis zu ${product.users} Nutzer in Ihrem Dashboard`, status: "live" as const }] : [];
  return [...pools, ...users];
}

export function publicLinesDe(product: Product, locale: GermanLocale): string[] {
  return [
    ...allowanceLinesDe(product, locale).filter((f) => f.status === "live").map((f) => f.text),
    ...product.features.filter((f) => f.status === "live").map((f) => catalogueDe(f.text)),
  ];
}

const CHANNEL_PHRASE_DE: Record<Channel, string> = {
  phone: "das Telefon",
  web_voice: "der Sprach-Button auf Ihrer Website",
  chat: "Ihr Website-Chat",
  whatsapp: "WhatsApp",
};

/** `trialSentence`, in German. */
export function trialSentenceDe(): string {
  const channels = joinDe(CHANNEL_ORDER.filter((c) => CHANNELS[c].status === "live").map((c) => CHANNEL_PHRASE_DE[c]));
  return (
    `${TRIAL.days} Tage kostenlos: ${TRIAL.minutes} Sprachminuten und ${TRIAL.conversations} Textgespräche. ` +
    `${channels.charAt(0).toUpperCase()}${channels.slice(1)} sind dabei alle eingeschaltet. ` +
    "Keine Karte, keine Kosten. Die Standard-Einrichtung ist kostenlos."
  );
}

/**
 * `overLimitSentence`, in German, with the pack prices of one market. The
 * German terms are a translation of the English ones, so they quote the UAE's;
 * a country's own page quotes its planned prices.
 */
export function overLimitSentenceDe(market: Market, locale: GermanLocale): string {
  const minutes = packFor("minutes");
  const conversations = packFor("conversations");
  const money = (p: typeof minutes) => formatMoney(p.prices[market] ?? 0, market, locale);
  const thresholds = ALERT_THRESHOLDS.map((t) => `${t} %`);
  return (
    "Wenn ein Kontingent aufgebraucht ist, entscheiden Sie, was passiert: automatisch ein Paket hinzubuchen " +
    `(${minutes.units} zusätzliche Sprachminuten für ${money(minutes)} oder ${conversations.units} zusätzliche Textgespräche für ${money(conversations)}), ` +
    "bis zu einer monatlichen Ausgabengrenze, die Sie festlegen; in den nächsten Tarif wechseln; oder beim Kontingent stoppen. " +
    `Wir informieren Sie bei ${joinDe(thresholds)}. Ihrer Rechnung wird nichts hinzugefügt, was Sie nicht selbst gewählt haben.`
  );
}

/** `MINUTE_DEFINITION`, in German. */
export const MINUTE_DEFINITION_DE =
  "Eine Minute ist die Zeit, die Belline in einem laufenden Gespräch mit Ihrem Anrufer verbringt – über Ihre " +
  "Telefonleitung oder den Sprach-Button auf Ihrer Website –, vom Annehmen bis zum Ende des Anrufs, aufgerundet " +
  "auf die nächste volle Minute. Anrufe aus Ihrer eigenen Testkonsole zählen nicht, ebenso wenig Anrufe, die " +
  "durch einen Fehler auf unserer Seite abbrechen.";

/** `CONVERSATION_DEFINITION`, in German. */
export const CONVERSATION_DEFINITION_DE =
  "Ein Gespräch ist der Verlauf eines Kunden in Ihrem Website-Chat oder auf WhatsApp, in dem Belline mindestens " +
  "einmal antwortet. Alles, was dieser Kunde in den 24 Stunden nach Bellines erster Antwort schreibt, gehört zum " +
  "selben Gespräch. Verläufe, die Ihr Team ohne Belline beantwortet, zählen nicht.";

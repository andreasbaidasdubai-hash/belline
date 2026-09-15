import { MARKETS, formatMoney, type Market } from "../markets";
import { CHANNELS, CHANNEL_ORDER, TRIAL, priceOf, sellable, type Channel } from "./plans";

/**
 * What Belle and the website say about price, generated from the catalogue.
 *
 * Her answers used to be typed into the seed by hand, and a price typed twice
 * is a price that will one day be wrong in one of the two places. These are
 * rebuilt from `plans.ts` on every boot (seed.ts refreshes our own venue's
 * knowledge). Spoken answers are in words, because a voice reading "AED 599"
 * aloud is a voice guessing how; the written sentences are for pages.
 *
 * Only live channels are named: WhatsApp is in the catalogue, and nobody may
 * sell it until it works.
 */

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** 599 → "five hundred and ninety-nine". Whole numbers under a million; anything else as digits. */
export function numberWords(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n >= 1_000_000) return String(n);
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : "");
  if (n < 1000) {
    const rest = n % 100;
    return `${ONES[Math.floor(n / 100)]} hundred${rest ? ` and ${numberWords(rest)}` : ""}`;
  }
  const rest = n % 1000;
  const thousands = `${numberWords(Math.floor(n / 1000))} thousand`;
  if (!rest) return thousands;
  return rest < 100 ? `${thousands} and ${numberWords(rest)}` : `${thousands} ${numberWords(rest)}`;
}

function spokenAmount(minor: number, market: Market): string {
  const major = minor / 100;
  const { one, many } = MARKETS[market].spoken;
  return `${numberWords(major)} ${major === 1 ? one : many}`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function list(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const CHANNEL_PHRASE: Record<Channel, string> = {
  phone: "the phone",
  web_voice: "the voice button on your website",
  chat: "your website chat",
  whatsapp: "WhatsApp",
};

/** The channels that work today, as a phrase. */
export function liveChannelsPhrase(): string {
  return list(CHANNEL_ORDER.filter((c) => CHANNELS[c].status === "live").map((c) => CHANNEL_PHRASE[c]));
}

/** "What does it cost?", for a caller in this market. */
export function priceAnswer(market: Market): string {
  const plans = sellable(market);
  const popular = plans.find((p) => p.recommended);
  const ladder = plans.map((p, i) => {
    const price = priceOf(p.id, market);
    const amount = i === 0 ? spokenAmount(price, market) : numberWords(price / 100);
    const minutes = numberWords(p.pools?.minutes ?? 0);
    const conversations = numberWords(p.pools?.conversations ?? 0);
    return `${p.name} is ${amount} with ${minutes} voice minutes and ${conversations} text conversations`;
  });

  return (
    `${capitalise(numberWords(plans.length))} plans, per location, per month, and every one ` +
    `covers ${liveChannelsPhrase()}. ${list(ladder)}.` +
    (popular ? ` ${popular.name} is the one most businesses take.` : "") +
    " Setting up is free."
  );
}

/** "Is there a free trial?" */
export function trialAnswer(): string {
  return (
    `${capitalise(numberWords(TRIAL.days))} days, with ${numberWords(TRIAL.minutes)} voice minutes and ` +
    `${numberWords(TRIAL.conversations)} text conversations, and ${liveChannelsPhrase()} all switched on. ` +
    "No card, nothing charged, and we set your business up with you — that part is free too."
  );
}

// ---------------------------------------------------------------------------
// Written sentences, for every page that quotes them
// ---------------------------------------------------------------------------

/** The trial, in one sentence. */
export function trialSentence(): string {
  return (
    `${TRIAL.days} days free: ${TRIAL.minutes} voice minutes and ${TRIAL.conversations} text conversations, ` +
    `with ${liveChannelsPhrase()} all switched on. No card, nothing charged. Standard onboarding is free.`
  );
}

/** Money in the UAE, where every v2 price is set. */
export function aedText(minor: number): string {
  return formatMoney(minor, "AE");
}

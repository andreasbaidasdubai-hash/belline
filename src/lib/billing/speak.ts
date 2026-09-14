import { MARKETS, type Market } from "../markets";
import { CHANNELS, CHANNEL_ORDER, TRIAL, priceOf, sellable, type Channel } from "./plans";

/**
 * What Belle says about price, generated from the catalogue.
 *
 * Her answers used to be typed into the seed by hand, and a price typed twice
 * is a price that will one day be wrong in one of the two places. These are
 * rebuilt from `plans.ts` on every boot (seed.ts refreshes our own venue's
 * knowledge), in words, because a voice reading "AED 599" aloud is a voice
 * guessing how.
 *
 * Only live channels are named: WhatsApp is in the catalogue, and Belle may
 * not sell it until it works.
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
    return `${p.name} is ${amount} with ${numberWords(p.allowances.phone as number)} phone minutes`;
  });

  return (
    `${numberWords(plans.length).replace(/^./, (c) => c.toUpperCase())} plans, per venue, per month, and every one ` +
    `includes ${liveChannelsPhrase()}. ${list(ladder)}.` +
    (popular ? ` ${popular.name} is the one most venues take.` : "") +
    " No setup fee, and no per-minute charges on any of them."
  );
}

/** "Is there a free trial?" */
export function trialAnswer(): string {
  const days = numberWords(TRIAL.days);
  return (
    `${days.charAt(0).toUpperCase()}${days.slice(1)} days, with ${numberWords(TRIAL.phoneMinutes)} ` +
    `minutes of live calls and ${liveChannelsPhrase()} all switched on. No card, nothing charged, ` +
    `and we set your venue up with you — that part is free too.`
  );
}

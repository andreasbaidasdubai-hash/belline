import { RATE_CARD, rate } from "./cost";
import {
  CHANNEL_ORDER,
  POOL_CHANNELS,
  POOL_ORDER,
  periodFee,
  type BillingCycle,
  type Channel,
  type Pack,
  type Pool,
  type Product,
} from "./plans";
import { toUsd, type Market } from "../markets";

/**
 * What a plan earns us, from the rate card rather than from a spreadsheet.
 *
 * Two bases, both from the strategy doc (§1.3). **Lean**: a US Twilio number,
 * Sonnet on voice, Haiku on text, ElevenLabs Scale. **Conservative**: a UAE
 * line, Sonnet everywhere, ElevenLabs Pro. Every unit cost is built from the
 * same `RATE_CARD` the meter uses, with the shapes written down below, so a
 * vendor price change moves the margin table without anybody re-typing it.
 *
 * `scripts/check-plans.ts` fails the build if a bundle's margin at typical use
 * falls under 30% or a module's under 45% — on the lean basis in every
 * market, and on the conservative basis in the UAE, the launch market, whose
 * line it describes. Its UAE rates are still estimates; the check prints which,
 * and setting RATE_<KEY> replaces them.
 */

export type Basis = "lean" | "conservative";
export const BASIS_ORDER: Basis[] = ["lean", "conservative"];

/** "Typical" use, per §2.2: sixty percent of every allowance. */
export const TYPICAL_USE = 0.6;

/** The floors check-plans enforces, at typical use. */
export const MARGIN_FLOOR = { bundle: 0.3, module: 0.45 } as const;

const PER_MILLION = 1_000_000;

/** A voice minute's model spend: six Sonnet turns over three minutes, ~5k cached tokens a turn. */
const VOICE_TOKENS_PER_MINUTE = { in: 500, out: 600, cacheRead: 10_000 };
/** One written conversation: eight turns. */
const CHAT_TURNS = 8;
const CHAT_TOKENS_PER_TURN = { in: 500, out: 170, cacheRead: 5_000 };
/** ~400 characters of speech a call-minute, at Flash's half a credit a character. */
const TTS_CHARS_PER_MINUTE = 400;
const FLASH_CREDITS_PER_CHAR = 0.5;
/**
 * Share of WhatsApp conversations that end in a template we actually pay for.
 *
 * Corrected 16 September 2026, and the correction is about when a template is
 * free rather than what one costs. Meta has charged per delivered template
 * since 1 July 2025, but a service reply inside the 24-hour customer service
 * window has been free and unlimited since 1 November 2024, and a utility
 * template sent while that window is open is free with it. Belline answers
 * what the customer started, so the window is open when the confirmation goes
 * out and it costs nothing. What we pay for is a template sent after the
 * window has closed — chiefly a next-day reminder, not a confirmation.
 *
 * developers.facebook.com/docs/whatsapp/pricing
 */
const TEMPLATE_SHARE: Record<Basis, number> = { lean: 0.15, conservative: 0.3 };

export const BASES: Record<
  Basis,
  {
    label: string;
    /** The markets this basis describes. The UAE line is the UAE's cost, and nobody else's. */
    markets: Market[] | "all";
    inbound: string;
    number: string;
    ttsCredit: string;
    voiceModel: string;
    textModel: string;
  }
> = {
  lean: {
    label: "Lean — US number, Sonnet voice, Haiku text, ElevenLabs Scale",
    markets: "all",
    inbound: "TWILIO_INBOUND_US",
    number: "TWILIO_NUMBER_US",
    ttsCredit: "ELEVENLABS_CREDIT_SCALE",
    voiceModel: "SONNET_5",
    textModel: "HAIKU_4_5",
  },
  /**
   * Every vendor assumption here is the pessimistic one — a UAE line,
   * ElevenLabs Pro, the top of Meta's UAE template band, the 0.3 paid-template
   * share — with one correction made on 16 September 2026: text is costed on
   * Haiku, because Haiku is what reception actually runs. Voice stays Sonnet.
   *
   * The evidence, so this can be checked rather than trusted. The reception
   * agent's model is per venue — `open()` in agent/runtime.ts reads
   * `this.location.agent.model` — and every venue we ship is Haiku: seed.ts:64,
   * 262 and 426 for the three demo venues, seed-belline.ts:247 for our own
   * line, and the dashboard offers Haiku as "fastest (recommended)"
   * (app/(app)/agents/AgentEditor.tsx:26). Sonnet appears only in
   * prospect.ts:260 and the onboarding assistant (onboarding/index.ts:124,
   * onboarding/assistant.ts:344) — one-off setup and prospecting, never
   * per-conversation reception traffic. Costing text on Sonnet was not a
   * pessimistic assumption, it was a wrong one, and it overstated a text
   * conversation by exactly double.
   *
   * The exposure this leaves, which is real and not hypothetical: an owner can
   * switch their venue to Sonnet on the Agent page, which doubles a text
   * conversation from $0.0148 to $0.0296 and would take Scale to roughly 21%
   * at full use — under the floor. `check-plans.ts` ties this basis to the
   * seeded model so the two cannot drift apart unnoticed, but it cannot see
   * what a customer chooses. If venues start moving to Sonnet, this basis is
   * wrong and the allowances are what has to give.
   */
  conservative: {
    label: "Conservative — UAE line, Sonnet voice, Haiku text, ElevenLabs Pro",
    markets: ["AE"],
    inbound: "TWILIO_INBOUND_AE",
    number: "TWILIO_NUMBER_AE",
    ttsCredit: "ELEVENLABS_CREDIT_PRO",
    voiceModel: "SONNET_5",
    textModel: "HAIKU_4_5",
  },
};

function tokens(model: string, t: { in: number; out: number; cacheRead: number }): number {
  return (
    (t.in * rate(`ANTHROPIC_${model}_IN`) +
      t.out * rate(`ANTHROPIC_${model}_OUT`) +
      t.cacheRead * rate(`ANTHROPIC_${model}_CACHE_READ`)) /
    PER_MILLION
  );
}

/** US dollars per minute (voice) or per conversation (text). */
export function unitCostUsd(channel: Channel, basis: Basis): number {
  const b = BASES[basis];
  const speech =
    rate("DEEPGRAM_STREAMING") +
    TTS_CHARS_PER_MINUTE * FLASH_CREDITS_PER_CHAR * rate(b.ttsCredit) +
    tokens(b.voiceModel, VOICE_TOKENS_PER_MINUTE);
  const conversation = CHAT_TURNS * tokens(b.textModel, CHAT_TOKENS_PER_TURN);
  switch (channel) {
    case "phone":
      return rate(b.inbound) + rate("TWILIO_MEDIA_STREAMS") + speech;
    case "web_voice":
      return speech;
    case "chat":
      return conversation;
    case "whatsapp":
      return conversation + TEMPLATE_SHARE[basis] * rate("META_UTILITY_TEMPLATE_AE");
  }
}

/**
 * US dollars per unit of a pool, at its dearest channel.
 *
 * A pooled allowance can be spent entirely on its most expensive channel —
 * every voice minute on a UAE phone line, every conversation on WhatsApp — so
 * that is what it is costed at. The real mix can only improve on it.
 */
export function poolCostUsd(pool: Pool, basis: Basis): number {
  return Math.max(...POOL_CHANNELS[pool].map((channel) => unitCostUsd(channel, basis)));
}

/** A number's monthly rental, charged once for any plan that includes the phone. */
export function numberRentalUsd(basis: Basis): number {
  return rate(BASES[basis].number);
}

/** Stripe's fee on one charge of this many US dollars. */
export function cardFeeUsd(chargeUsd: number): number {
  return chargeUsd > 0 ? chargeUsd * rate("STRIPE_CARD_SHARE_AE") + rate("STRIPE_CARD_FIXED_AE") : 0;
}

/** Every rate-card line a basis reads. */
export function linesOf(basis: Basis): string[] {
  const b = BASES[basis];
  const model = (m: string) => ["IN", "OUT", "CACHE_READ"].map((k) => `ANTHROPIC_${m}_${k}`);
  return [
    ...new Set([
      b.inbound,
      b.number,
      b.ttsCredit,
      "TWILIO_MEDIA_STREAMS",
      "DEEPGRAM_STREAMING",
      "META_UTILITY_TEMPLATE_AE",
      "STRIPE_CARD_SHARE_AE",
      "STRIPE_CARD_FIXED_AE",
      ...model(b.voiceModel),
      ...model(b.textModel),
    ]),
  ];
}

/**
 * The lines a basis rests on that nobody has verified.
 *
 * A line counts as verified when the card says so, or when a `RATE_<KEY>` has
 * been set in the environment — which is how a real quote from a UAE carrier
 * gets in without a deploy.
 */
export function unverifiedLines(basis: Basis): string[] {
  return linesOf(basis).filter((key) => {
    const env = process.env[`RATE_${key}`];
    return !RATE_CARD[key]?.verified && !(env !== undefined && env.trim() !== "");
  });
}

export interface Margin {
  revenueUsd: number;
  costUsd: number;
  /** (revenue − cost) / revenue. Null for a free product, which has no revenue to share. */
  margin: number | null;
}

/**
 * Gross margin on one product in one market, for one month, at a share of its
 * allowances.
 *
 * Revenue is the month's money: the monthly price, or a twelfth of the annual
 * one. Cost is the allowances used (pools at their dearest channel), the
 * phone number's rental, and Stripe's fee on the charge — spread over twelve
 * months on the annual cycle, which is charged once.
 */
export function marginOf(
  product: Product,
  market: Market,
  basis: Basis,
  share: number,
  cycle: BillingCycle = "monthly",
): Margin {
  const chargeUsd = toUsd(periodFee([product.id], market, cycle), market);
  const months = cycle === "annual" ? 12 : 1;
  const revenueUsd = chargeUsd / months;
  let costUsd = 0;
  for (const channel of CHANNEL_ORDER) {
    const allowance = product.allowances[channel];
    if (typeof allowance === "number") costUsd += allowance * share * unitCostUsd(channel, basis);
  }
  for (const pool of POOL_ORDER) {
    const allowance = product.pools?.[pool];
    if (typeof allowance === "number") costUsd += allowance * share * poolCostUsd(pool, basis);
  }
  if ("phone" in product.allowances || product.pools?.minutes !== undefined) costUsd += numberRentalUsd(basis);
  costUsd += cardFeeUsd(chargeUsd) / months;
  return { revenueUsd, costUsd, margin: revenueUsd > 0 ? (revenueUsd - costUsd) / revenueUsd : null };
}

/** Gross margin on one pack, at a share of its units used (a pack is paid for whole). */
export function packMarginOf(pack: Pack, market: Market, basis: Basis, share = 1): Margin {
  const amount = pack.prices[market];
  if (amount === undefined) throw new Error(`${pack.id} is not sold in ${market}`);
  const revenueUsd = toUsd(amount, market);
  const costUsd = pack.units * share * poolCostUsd(pack.pool, basis) + cardFeeUsd(revenueUsd);
  return { revenueUsd, costUsd, margin: revenueUsd > 0 ? (revenueUsd - costUsd) / revenueUsd : null };
}

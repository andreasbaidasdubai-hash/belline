import { RATE_CARD, rate } from "./cost";
import { CHANNEL_ORDER, priceOf, type Channel, type Product } from "./plans";
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
 * falls under 30% or a module's under 45%. A basis resting on an unverified
 * rate — the UAE line, today — is reported rather than enforced, and becomes a
 * hard gate the moment its rates are verified or set from the environment.
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
 * Share of WhatsApp conversations that end in a confirmation sent after the
 * 24-hour service window, as a paid UAE utility template. Reproduces §1.3's
 * $0.027 and $0.049 per conversation from the rate card.
 */
const TEMPLATE_SHARE: Record<Basis, number> = { lean: 0.4, conservative: 0.7 };

export const BASES: Record<
  Basis,
  { label: string; inbound: string; number: string; ttsCredit: string; voiceModel: string; textModel: string }
> = {
  lean: {
    label: "Lean — US number, Sonnet voice, Haiku text, ElevenLabs Scale",
    inbound: "TWILIO_INBOUND_US",
    number: "TWILIO_NUMBER_US",
    ttsCredit: "ELEVENLABS_CREDIT_SCALE",
    voiceModel: "SONNET_5",
    textModel: "HAIKU_4_5",
  },
  conservative: {
    label: "Conservative — UAE line, Sonnet everywhere, ElevenLabs Pro",
    inbound: "TWILIO_INBOUND_AE",
    number: "TWILIO_NUMBER_AE",
    ttsCredit: "ELEVENLABS_CREDIT_PRO",
    voiceModel: "SONNET_5",
    textModel: "SONNET_5",
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

/** A number's monthly rental, charged once for any plan that includes the phone. */
export function numberRentalUsd(basis: Basis): number {
  return rate(BASES[basis].number);
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

/** Gross margin on one product in one market, at a share of its allowances. */
export function marginOf(product: Product, market: Market, basis: Basis, share: number): Margin {
  const revenueUsd = toUsd(priceOf(product.id, market), market);
  let costUsd = 0;
  for (const channel of CHANNEL_ORDER) {
    const allowance = product.allowances[channel];
    if (typeof allowance === "number") costUsd += allowance * share * unitCostUsd(channel, basis);
  }
  if ("phone" in product.allowances) costUsd += numberRentalUsd(basis);
  return { revenueUsd, costUsd, margin: revenueUsd > 0 ? (revenueUsd - costUsd) / revenueUsd : null };
}

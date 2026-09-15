import crypto from "node:crypto";
import type { Call, Location } from "../types";
import { appendCosts, getCall, listCosts } from "../store";

/**
 * What Belline costs to run, measured rather than assumed.
 *
 * Until now there was one number: 40 fils a minute, a planning constant that
 * sat just above the most expensive stack anybody could build. It was the
 * right number to plan with and the wrong number to price with, because it
 * cannot tell a WhatsApp conversation (about six fils) from a minute on a UAE
 * phone line (about thirty-five), and pricing four channels means knowing
 * what each one costs.
 *
 * So each place that spends money reports what it spent, in the vendor's own
 * units — seconds on a line, characters synthesised, tokens in and out, a
 * message sent — priced from a dated rate card. Everything above that is a
 * sum. A figure is only trusted once a channel has enough samples to mean
 * something; below that the planning figure stands in, and the page says which
 * one it is showing.
 *
 * Vendor invoices remain the truth. This is the estimate you can act on before
 * the invoice arrives, and the thing to reconcile the invoice against.
 */

/** `test` is the setup checks (onboarding/selftest.ts): spend, but never a customer's usage. */
export type CostChannel = "phone" | "embed_voice" | "webchat" | "whatsapp" | "test";
export type CostVendor = "twilio" | "deepgram" | "elevenlabs" | "anthropic" | "meta" | "openai";
export type CostUnit =
  | "min"
  | "chars"
  | "tokens_in"
  | "tokens_out"
  | "tokens_cache_read"
  | "tokens_cache_write"
  | "messages"
  | "templates";

export interface CostEvent {
  id: string;
  at: string;
  venueId: string;
  /** The episode — a call, or the Call record a message thread carries. */
  callId?: string;
  /** The message thread, for chat and WhatsApp. */
  conversationId?: string;
  channel: CostChannel;
  vendor: CostVendor;
  units: number;
  unit: CostUnit;
  usd: number;
  /** Which rate priced it — model id, number country, plan — so a line can be audited. */
  detail?: string;
}

// ---------------------------------------------------------------------------
// The rate card
// ---------------------------------------------------------------------------

/** When the card below was last checked against the vendors' own pages. */
export const RATE_CARD_DATE = "2026-09-14";

export interface Rate {
  usd: number;
  per: "min" | "credit" | "M tokens" | "message" | "month" | "charge" | "share";
  /** Where the number came from. */
  source: string;
  /**
   * False where neither the strategy document nor the vendor's page states the
   * figure outright. A false line is a number to replace, not to quote.
   */
  verified: boolean;
}

/**
 * List prices, USD. Every line can be overridden from the environment as
 * `RATE_<KEY>` — `RATE_TWILIO_INBOUND_AE=0.035` the day there is a UAE quote —
 * without a deploy of anything but the variable.
 */
export const RATE_CARD: Record<string, Rate> = {
  // --- Telephony: Twilio --------------------------------------------------
  TWILIO_INBOUND_US: { usd: 0.0085, per: "min", source: "strategy §1.2; twilio.com/en-us/voice/pricing/us — local number, inbound", verified: true },
  TWILIO_INBOUND_CA: { usd: 0.0085, per: "min", source: "strategy §1.2; twilio.com/en-us/voice/pricing/ca — local number, inbound", verified: true },
  TWILIO_INBOUND_GB: { usd: 0.01, per: "min", source: "strategy §1.2; twilio.com/en-us/voice/pricing/gb — local number, inbound", verified: true },
  TWILIO_INBOUND_AU: { usd: 0.01, per: "min", source: "strategy §1.2; twilio.com/en-us/voice/pricing/au — local number, inbound", verified: true },
  TWILIO_INBOUND_AE: {
    usd: 0.045,
    per: "min",
    source: "strategy §1.2: Twilio does not sell UAE numbers; a licensed carrier or SIP reseller runs ~$0.03–0.06/min — midpoint, unverified. Set RATE_TWILIO_INBOUND_AE from the quote.",
    verified: false,
  },
  TWILIO_MEDIA_STREAMS: { usd: 0.0044, per: "min", source: "strategy §1.2; twilio.com/en-us/voice/pricing — Media Streams, on every phone minute", verified: true },
  TWILIO_NUMBER_US: { usd: 1.15, per: "month", source: "strategy §1.2; twilio.com/en-us/voice/pricing/us — local number rental", verified: true },
  TWILIO_NUMBER_GB: { usd: 3.5, per: "month", source: "strategy §1.2; twilio.com/en-us/voice/pricing/gb — local number rental", verified: true },
  TWILIO_NUMBER_AU: { usd: 3.0, per: "month", source: "strategy §1.2; twilio.com/en-us/voice/pricing/au — local number rental", verified: true },
  TWILIO_NUMBER_AE: { usd: 15, per: "month", source: "strategy §1.2: reseller budget ~$15/mo, unverified", verified: false },
  TWILIO_WHATSAPP_MESSAGE: {
    usd: 0.005,
    per: "message",
    source: "twilio.com/en-us/whatsapp/pricing — Twilio's fee per message on top of Meta's. Not in strategy §1.2, which assumes Meta direct.",
    verified: false,
  },

  // --- Speech ------------------------------------------------------------
  DEEPGRAM_STREAMING: { usd: 0.0077, per: "min", source: "strategy §1.2; deepgram.com/pricing — nova-3 streaming, pay as you go (Growth tier $0.0065)", verified: true },
  DEEPGRAM_PRERECORDED: {
    usd: 0.0043,
    per: "min",
    source: "deepgram.com/pricing — nova-3 pre-recorded, pay as you go. Voice notes are transcribed here, not by Whisper; not in strategy §1.2.",
    verified: false,
  },
  OPENAI_WHISPER: { usd: 0.006, per: "min", source: "strategy §1.2; openai.com/api/pricing — not used today", verified: true },

  // --- Voice: ElevenLabs, USD per credit by plan ---------------------------
  // Flash and Turbo take 0.5 credits a character, the others 1. At ~400
  // characters a call-minute that is 200 credits a minute on Flash.
  ELEVENLABS_CREDIT_CREATOR: { usd: 0.00022, per: "credit", source: "strategy §1.2: Creator ≈ $0.044/min ÷ 200 credits", verified: true },
  ELEVENLABS_CREDIT_PRO: { usd: 0.000198, per: "credit", source: "elevenlabs.io/pricing: Pro $99 / 500k credits — the strategy doc's conservative basis, priced here, unverified", verified: false },
  ELEVENLABS_CREDIT_SCALE: { usd: 0.000165, per: "credit", source: "strategy §1.2: Scale ≈ $0.033/min ÷ 200 credits", verified: true },
  ELEVENLABS_CREDIT_BUSINESS: { usd: 0.00012, per: "credit", source: "strategy §1.2: Business ≈ $0.024/min ÷ 200 credits", verified: true },

  // --- Model: Anthropic, USD per million tokens ----------------------------
  // Cache writes use the one-hour TTL the prompt sets, billed at twice the
  // input rate. The strategy doc lists input, output and cache read only.
  ANTHROPIC_HAIKU_4_5_IN: { usd: 1, per: "M tokens", source: "strategy §1.2; anthropic.com/pricing", verified: true },
  ANTHROPIC_HAIKU_4_5_OUT: { usd: 5, per: "M tokens", source: "strategy §1.2; anthropic.com/pricing", verified: true },
  ANTHROPIC_HAIKU_4_5_CACHE_READ: { usd: 0.1, per: "M tokens", source: "strategy §1.2; anthropic.com/pricing", verified: true },
  ANTHROPIC_HAIKU_4_5_CACHE_WRITE: { usd: 2, per: "M tokens", source: "anthropic.com/pricing — 1h cache write = 2× input", verified: true },
  ANTHROPIC_SONNET_5_IN: { usd: 2, per: "M tokens", source: "strategy §1.2; anthropic.com/pricing", verified: true },
  ANTHROPIC_SONNET_5_OUT: { usd: 10, per: "M tokens", source: "strategy §1.2; anthropic.com/pricing", verified: true },
  ANTHROPIC_SONNET_5_CACHE_READ: { usd: 0.2, per: "M tokens", source: "strategy §1.2; anthropic.com/pricing", verified: true },
  ANTHROPIC_SONNET_5_CACHE_WRITE: { usd: 4, per: "M tokens", source: "anthropic.com/pricing — 1h cache write = 2× input", verified: true },
  ANTHROPIC_OPUS_5_IN: { usd: 5, per: "M tokens", source: "strategy §1.2; anthropic.com/pricing", verified: true },
  ANTHROPIC_OPUS_5_OUT: { usd: 25, per: "M tokens", source: "strategy §1.2; anthropic.com/pricing", verified: true },
  ANTHROPIC_OPUS_5_CACHE_READ: { usd: 0.5, per: "M tokens", source: "anthropic.com/pricing — cache read = 0.1× input", verified: true },
  ANTHROPIC_OPUS_5_CACHE_WRITE: { usd: 10, per: "M tokens", source: "anthropic.com/pricing — 1h cache write = 2× input", verified: true },

  // --- WhatsApp: Meta -----------------------------------------------------
  META_SERVICE_REPLY: { usd: 0, per: "message", source: "strategy §1.2: replies inside the 24-hour customer service window are free", verified: true },
  META_UTILITY_TEMPLATE_AE: { usd: 0.0285, per: "message", source: "strategy §1.2; developers.facebook.com/docs/whatsapp/pricing — utility template, UAE", verified: true },
  META_UTILITY_TEMPLATE_GB: { usd: 0.0171, per: "message", source: "strategy §1.2 — utility template, UK", verified: true },
  META_UTILITY_TEMPLATE_US: { usd: 0.004, per: "message", source: "strategy §1.2 — utility template, US", verified: true },

  // --- Card payments: Stripe ------------------------------------------------
  // Priced as a share of each charge plus a fixed amount per charge. The UAE
  // card rate is taken at its dearer, international-card figure so the
  // margin is not flattered by a customer's choice of card.
  STRIPE_CARD_SHARE_AE: {
    usd: 0.039,
    per: "share",
    source: "stripe.com/ae/pricing — 2.9% domestic cards, +1% international; the dearer figure, unverified against the account's own contract",
    verified: false,
  },
  STRIPE_CARD_FIXED_AE: {
    usd: 0.27,
    per: "charge",
    source: "stripe.com/ae/pricing — AED 1 per successful charge ≈ $0.27, unverified",
    verified: false,
  },
};

/** A rate, from the environment if it has been overridden there. */
export function rate(key: string): number {
  const raw = process.env[`RATE_${key}`];
  if (raw !== undefined && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const line = RATE_CARD[key];
  if (!line) throw new Error(`No rate on the card for ${key}`);
  return line.usd;
}

// ---------------------------------------------------------------------------
// Which rate
// ---------------------------------------------------------------------------

/**
 * The channel a call's costs belong to.
 *
 * `browser` — the venue's own test console and our demo pages — runs the web
 * voice pipeline, so it is priced as web voice. It is real money and it counts
 * in the unit cost; it is simply never billed to anybody.
 */
export function costChannelOf(call: Pick<Call, "channel">): CostChannel {
  switch (call.channel) {
    case "phone":
      return "phone";
    case "webchat":
      return "webchat";
    case "whatsapp":
      return "whatsapp";
    default:
      return "embed_voice";
  }
}

/**
 * The country of the number that was dialled, for the inbound rate.
 * Canada shares +1 with the US and the same Twilio rate, so it needs no case.
 */
export function countryOfNumber(e164: string | undefined): "US" | "GB" | "AU" | "AE" {
  const n = (e164 ?? "").replace(/[^\d+]/g, "");
  if (n.startsWith("+971")) return "AE";
  if (n.startsWith("+44")) return "GB";
  if (n.startsWith("+61")) return "AU";
  return "US";
}

function modelKey(model: string): { key: string; onCard: boolean } {
  if (model.startsWith("claude-haiku-4-5")) return { key: "HAIKU_4_5", onCard: true };
  if (model.startsWith("claude-sonnet-5")) return { key: "SONNET_5", onCard: true };
  if (model.startsWith("claude-opus-5")) return { key: "OPUS_5", onCard: true };
  // Anything else is priced as Sonnet and says so in the detail. Guessing a
  // cheaper rate would flatter the margin, which is the wrong way to be wrong.
  return { key: "SONNET_5", onCard: false };
}

/** Credits ElevenLabs charges per character for a model. */
export function creditsPerChar(model: string): number {
  return /flash|turbo/.test(model) ? 0.5 : 1;
}

function elevenLabsCreditUsd(): { usd: number; plan: string } {
  if ((process.env.RATE_ELEVENLABS_PER_CREDIT ?? "").trim()) {
    const n = Number(process.env.RATE_ELEVENLABS_PER_CREDIT);
    if (Number.isFinite(n) && n >= 0) return { usd: n, plan: "override" };
  }
  const plan = (process.env.ELEVENLABS_PLAN ?? "scale").trim().toUpperCase();
  const key = `ELEVENLABS_CREDIT_${plan}`;
  return RATE_CARD[key] ? { usd: rate(key), plan: plan.toLowerCase() } : { usd: rate("ELEVENLABS_CREDIT_SCALE"), plan: "scale" };
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

export interface CostContext {
  venueId: string;
  channel: CostChannel;
  callId?: string;
  conversationId?: string;
}

/**
 * Events wait here and are written together.
 *
 * The store rewrites a whole collection on every save, and a single call
 * reports thirty-odd events — one per synthesised fragment. Writing each on
 * its own would put thirty file writes inside a live call. A second's delay
 * batches them into one; a crash inside that second loses those events, which
 * is a small hole in an estimate and never a hole in a booking.
 */
const pending = globalThis as unknown as {
  __bellineCostQueue?: CostEvent[];
  __bellineCostTimer?: ReturnType<typeof setTimeout> | null;
};

function queue(): CostEvent[] {
  pending.__bellineCostQueue ??= [];
  return pending.__bellineCostQueue;
}

export function recordCost(input: Omit<CostEvent, "id" | "at"> & { at?: string }): CostEvent | null {
  if (!(input.units > 0) || !Number.isFinite(input.usd) || input.usd < 0) return null;
  const event: CostEvent = {
    ...input,
    id: `cost_${crypto.randomBytes(6).toString("hex")}`,
    at: input.at ?? new Date().toISOString(),
    usd: Math.round(input.usd * 1e8) / 1e8,
  };
  queue().push(event);
  if (!pending.__bellineCostTimer) {
    pending.__bellineCostTimer = setTimeout(() => {
      pending.__bellineCostTimer = null;
      flushCosts();
    }, 1000);
    pending.__bellineCostTimer.unref?.();
  }
  return event;
}

/** Write whatever is waiting. Returns how many events were written. */
export function flushCosts(): number {
  if (pending.__bellineCostTimer) {
    clearTimeout(pending.__bellineCostTimer);
    pending.__bellineCostTimer = null;
  }
  const batch = queue().splice(0);
  if (batch.length) appendCosts(batch);
  return batch.length;
}

process.once("beforeExit", () => {
  flushCosts();
});

/**
 * A voice call's time: the phone line and Media Streams on a phone call,
 * speech-to-text on every voice call.
 *
 * Twilio bills each call rounded up to the whole minute; Deepgram bills the
 * audio it received, which is the length of the call.
 */
export function meterCallTime(
  call: Pick<Call, "id" | "locationId" | "channel">,
  venue: Pick<Location, "phone">,
  seconds: number,
  opts: { stt: boolean },
): void {
  if (!(seconds > 0)) return;
  const ctx: CostContext = { venueId: call.locationId, callId: call.id, channel: costChannelOf(call) };
  const minutes = seconds / 60;

  if (call.channel === "phone") {
    const billed = Math.ceil(minutes);
    const inbound = `TWILIO_INBOUND_${countryOfNumber(venue.phone)}`;
    recordCost({ ...ctx, vendor: "twilio", unit: "min", units: billed, usd: billed * rate(inbound), detail: inbound });
    recordCost({ ...ctx, vendor: "twilio", unit: "min", units: billed, usd: billed * rate("TWILIO_MEDIA_STREAMS"), detail: "TWILIO_MEDIA_STREAMS" });
  }
  if (opts.stt) {
    recordCost({ ...ctx, vendor: "deepgram", unit: "min", units: minutes, usd: minutes * rate("DEEPGRAM_STREAMING"), detail: "DEEPGRAM_STREAMING nova-3" });
  }
}

/** Characters sent to ElevenLabs. Called by the speech provider once a request is accepted. */
export function meterTts(ctx: CostContext, chars: number, model: string): void {
  const credits = chars * creditsPerChar(model);
  const credit = elevenLabsCreditUsd();
  recordCost({
    ...ctx,
    vendor: "elevenlabs",
    unit: "chars",
    units: chars,
    usd: credits * credit.usd,
    detail: `${model} · ${credits} credits · ${credit.plan} plan`,
  });
}

/** The usage block Anthropic returns with every response. */
export interface ModelUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export function meterModel(ctx: CostContext, model: string, usage: ModelUsage): void {
  const { key, onCard } = modelKey(model);
  const detail = onCard ? model : `${model} (not on the rate card — priced as Sonnet 5)`;
  const lines: [CostUnit, number | null | undefined, string][] = [
    ["tokens_in", usage.input_tokens, "IN"],
    ["tokens_out", usage.output_tokens, "OUT"],
    ["tokens_cache_read", usage.cache_read_input_tokens, "CACHE_READ"],
    ["tokens_cache_write", usage.cache_creation_input_tokens, "CACHE_WRITE"],
  ];
  for (const [unit, tokens, suffix] of lines) {
    if (!tokens) continue;
    recordCost({
      ...ctx,
      vendor: "anthropic",
      unit,
      units: tokens,
      usd: (tokens / 1e6) * rate(`ANTHROPIC_${key}_${suffix}`),
      detail,
    });
  }
}

/**
 * A WhatsApp message sent.
 *
 * Free-form text can only be sent inside the 24-hour window, so every message
 * the adapters send today is a free service reply — recorded all the same, so
 * the conversation count is right. A template outside the window is priced by
 * the recipient's country. Twilio adds its own fee per message either way.
 */
export function meterMessage(
  ctx: CostContext,
  provider: "meta" | "twilio",
  opts: { templated?: boolean; recipient?: string } = {},
): void {
  if (provider === "twilio") {
    recordCost({ ...ctx, vendor: "twilio", unit: "messages", units: 1, usd: rate("TWILIO_WHATSAPP_MESSAGE"), detail: "TWILIO_WHATSAPP_MESSAGE" });
  }
  if (opts.templated) {
    const country = countryOfNumber(opts.recipient);
    const key = RATE_CARD[`META_UTILITY_TEMPLATE_${country}`] ? `META_UTILITY_TEMPLATE_${country}` : "META_UTILITY_TEMPLATE_AE";
    recordCost({ ...ctx, vendor: "meta", unit: "templates", units: 1, usd: rate(key), detail: key });
  } else {
    recordCost({ ...ctx, vendor: "meta", unit: "messages", units: 1, usd: rate("META_SERVICE_REPLY"), detail: "META_SERVICE_REPLY" });
  }
}

/** A recording transcribed whole — a voice note. */
export function meterClip(ctx: CostContext, seconds: number, vendor: "deepgram" | "openai"): void {
  const minutes = seconds / 60;
  const key = vendor === "deepgram" ? "DEEPGRAM_PRERECORDED" : "OPENAI_WHISPER";
  recordCost({ ...ctx, vendor, unit: "min", units: minutes, usd: minutes * rate(key), detail: key });
}

// ---------------------------------------------------------------------------
// Rolling it up
// ---------------------------------------------------------------------------

export interface CostSummary {
  usd: number;
  events: number;
  byVendor: Partial<Record<CostVendor, number>>;
}

function summarise(events: CostEvent[]): CostSummary {
  const byVendor: Partial<Record<CostVendor, number>> = {};
  let usd = 0;
  for (const e of events) {
    usd += e.usd;
    byVendor[e.vendor] = (byVendor[e.vendor] ?? 0) + e.usd;
  }
  return { usd, events: events.length, byVendor };
}

export function costOfCall(callId: string): CostSummary {
  flushCosts();
  return summarise(listCosts({ callId }));
}

export function costOfConversation(conversationId: string): CostSummary {
  flushCosts();
  return summarise(listCosts({ conversationId }));
}

/** A venue's spend over a period, `start` inclusive and `end` exclusive, YYYY-MM-DD. */
export function costPerVenuePeriod(
  venueId: string,
  period: { start: string; end: string },
): CostSummary & { byChannel: Partial<Record<CostChannel, number>> } {
  flushCosts();
  const events = listCosts({ venueId }).filter((e) => {
    const day = e.at.slice(0, 10);
    return day >= period.start && day < period.end;
  });
  const byChannel: Partial<Record<CostChannel, number>> = {};
  for (const e of events) byChannel[e.channel] = (byChannel[e.channel] ?? 0) + e.usd;
  return { ...summarise(events), byChannel };
}

/** Below this many calls or conversations, a measured figure is noise. */
export const MIN_SAMPLES = 50;

/** The old constant, kept as the figure planning falls back to. */
export const PLANNING_COST_PER_MINUTE_FILS = 40;

/** The dirham is pegged at 3.6725 to the dollar. */
export const FILS_PER_USD = 367.25;

/**
 * What planning uses for a channel until it has been measured.
 *
 * Phone keeps the old 40 fils. The others take the conservative column of
 * strategy §1.3, for the same reason 40 fils was chosen: a floor on margin,
 * not an estimate of it.
 */
export const PLANNING_USD_PER_UNIT: Record<CostChannel, number> = {
  phone: PLANNING_COST_PER_MINUTE_FILS / FILS_PER_USD,
  embed_voice: 0.06,
  webchat: 0.031,
  whatsapp: 0.049,
  // Not a unit anybody sells; kept out of CHANNELS below.
  test: 0,
};

export interface UnitCost {
  channel: CostChannel;
  unit: "min" | "conversation";
  /** Measured, or null with nothing measured yet. */
  usdPerUnit: number | null;
  samples: number;
  /** True while there are fewer than MIN_SAMPLES; `effectiveUsdPerUnit` is then the planning figure. */
  fallback: boolean;
  effectiveUsdPerUnit: number;
}

const CHANNELS: CostChannel[] = ["phone", "embed_voice", "webchat", "whatsapp"];

/**
 * USD per phone minute, per web-voice minute, per chat conversation and per
 * WhatsApp conversation, with the number of samples behind each.
 *
 * Voice is divided by the minutes of the calls that reported costs, so a call
 * that spent nothing on speech still counts its time. Text is divided by the
 * number of threads.
 */
export function unitCosts(opts: { since?: string } = {}): UnitCost[] {
  flushCosts();
  const events = listCosts({ since: opts.since });

  return CHANNELS.map((channel): UnitCost => {
    const voice = channel === "phone" || channel === "embed_voice";
    const byEpisode = new Map<string, number>();
    for (const e of events) {
      if (e.channel !== channel) continue;
      const key = voice ? e.callId : (e.conversationId ?? e.callId);
      if (!key) continue;
      byEpisode.set(key, (byEpisode.get(key) ?? 0) + e.usd);
    }

    let usd = 0;
    let samples = 0;
    let denominator = 0;
    for (const [key, spent] of byEpisode) {
      if (voice) {
        const call = getCall(key);
        if (!call?.endedAt) continue;
        const seconds = (Date.parse(call.endedAt) - Date.parse(call.startedAt)) / 1000;
        if (!(seconds > 0)) continue;
        denominator += seconds / 60;
      } else {
        denominator += 1;
      }
      usd += spent;
      samples += 1;
    }

    const usdPerUnit = denominator > 0 ? usd / denominator : null;
    const fallback = samples < MIN_SAMPLES || usdPerUnit === null;
    return {
      channel,
      unit: voice ? "min" : "conversation",
      usdPerUnit,
      samples,
      fallback,
      effectiveUsdPerUnit: fallback ? PLANNING_USD_PER_UNIT[channel] : (usdPerUnit as number),
    };
  });
}

/** The phone minute, in fils, that the client book and the projection use. */
export function phoneCostPerMinuteFils(units: UnitCost[] = unitCosts()): number {
  const phone = units.find((u) => u.channel === "phone");
  if (!phone || phone.fallback || phone.usdPerUnit === null) return PLANNING_COST_PER_MINUTE_FILS;
  return Math.round(phone.usdPerUnit * FILS_PER_USD);
}

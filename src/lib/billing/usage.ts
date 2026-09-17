import type { Call, Location, Subscription, UsagePack } from "../types";
import { listCalls } from "../store";
import { callDurationSeconds } from "../calls";
import { marketOf, type Market } from "../markets";
import {
  CHANNELS,
  CHANNEL_ORDER,
  LEGACY_TRIAL_PRODUCTS,
  POOL_CHANNELS,
  POOL_NAMES,
  POOL_ORDER,
  allowancesOf,
  channelsOf,
  grandfatherOf,
  grandfatherExpires,
  isPooled,
  money,
  nextPlanUp,
  packFor,
  poolOf,
  poolPlaces,
  poolsOf,
  productById,
  recommend,
  selectionName,
  type Channel,
  type Pool,
  type ProductId,
  type Recommendation,
  type Unit,
} from "./plans";
import { stripeEnabled } from "./stripe";

/**
 * Minutes, conversations, allowances, and what the invoice will say.
 *
 * Three decisions carry it:
 *
 *   What counts — a minute, a conversation — is defined once, here, and the
 *   website quotes these definitions rather than paraphrasing them.
 *
 *   The invoice is the plan fee, read from what the customer was sold. The
 *   only other thing that can ever appear on it is a pack the owner chose
 *   under their usage policy (billing/usage-policy.ts) — never a metered
 *   charge nobody agreed to.
 *
 *   Where the rule is genuinely ambiguous, the customer wins. Calls we broke
 *   are not counted, and the projection rounds toward telling somebody sooner.
 */

// ---------------------------------------------------------------------------
// What a subscription is
// ---------------------------------------------------------------------------

/** The products a subscription covers, whichever shape it was stored in. */
export function productsOf(sub: Subscription | undefined): ProductId[] {
  if (!sub) return [];
  if (sub.products?.length) return sub.products;
  return sub.planId ? [sub.planId] : [];
}

export function subscriptionMarket(sub: Subscription | undefined): Market {
  return marketOf(sub?.market);
}

/** True for a venue on a product from an earlier catalogue. */
export function isLegacy(sub: Subscription | undefined): boolean {
  return productsOf(sub).some((id) => productById(id).kind === "legacy");
}

/** True for a trial begun under catalogue 2026-10: both units capped, pooled. */
export function isPooledTrial(sub: Subscription | undefined): boolean {
  return sub?.status === "trialing" && typeof sub.trial?.conversations === "number";
}

// ---------------------------------------------------------------------------
// What counts
// ---------------------------------------------------------------------------

/** Which sellable channel an episode record belongs to. The test console belongs to none. */
export function channelOfCall(call: Pick<Call, "channel">): Channel | null {
  switch (call.channel) {
    case "phone":
      return "phone";
    case "embed":
      return "web_voice";
    case "webchat":
      return "chat";
    case "whatsapp":
      return "whatsapp";
    default:
      // `browser` is the venue's own test console.
      return null;
  }
}

/**
 * Billable minutes for one voice call, on the phone or the website button.
 *
 * Connected talking time, from the moment Belline answers to the moment the
 * call ends, rounded up to the next whole minute. Deliberately excluded:
 *
 *   Test-console calls. They cost us money with three vendors, but nobody
 *   should be charged for trying their own agent out.
 *
 *   Demo-line calls. Strangers kicking the tyres are our expense.
 *
 *   Calls that ended in `failed` — the status a call is given when the server
 *   stopped underneath it. A rule that bills for our own crash is the wrong
 *   rule at any volume.
 *
 *   Voicemails left before Go live. Belline never answered: Twilio played a
 *   greeting and recorded the message, so no minute of Belline was spent.
 */
export function billableVoiceMinutes(call: Call): number {
  const channel = channelOfCall(call);
  if (call.isDemo) return 0;
  if (call.voicemail) return 0;
  if (channel !== "phone" && channel !== "web_voice") return 0;
  if (call.status !== "completed") return 0;
  if (!call.endedAt) return 0;

  const seconds = callDurationSeconds(call);
  if (seconds <= 0) return 0;
  return Math.ceil(seconds / 60);
}

/** Phone minutes only — what an older trial caps and the call list on the billing page shows. */
export function billableMinutes(call: Call): number {
  return channelOfCall(call) === "phone" ? billableVoiceMinutes(call) : 0;
}

/** How long one written conversation lasts before the next reply starts another. */
export const CONVERSATION_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * When each billable conversation in a written thread began.
 *
 * A thread is one customer on one channel. A conversation starts with
 * Belline's first reply and runs for 24 hours; a reply after that starts the
 * next one. Counted off Belline's own replies, so a thread nobody answered, a
 * thread a member of staff answered alone, and a message Belline could not
 * reply to are all free.
 */
export function conversationStarts(call: Call): string[] {
  const channel = channelOfCall(call);
  if (call.isDemo) return [];
  if (channel !== "chat" && channel !== "whatsapp") return [];

  const replies = call.transcript
    .filter((line) => line.role === "agent" && line.at)
    .map((line) => Date.parse(line.at))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);

  const starts: string[] = [];
  let open = -Infinity;
  for (const at of replies) {
    if (at >= open + CONVERSATION_WINDOW_MS) {
      starts.push(new Date(at).toISOString());
      open = at;
    }
  }
  return starts;
}

/** Billable units for one episode: minutes for voice, conversations for text. */
export function billableUnits(call: Call): number {
  const channel = channelOfCall(call);
  if (!channel) return 0;
  return CHANNELS[channel].unit === "minutes" ? billableVoiceMinutes(call) : conversationStarts(call).length;
}

/** The definitions, in the words the website and the billing page use. Quoted, not rewritten. */
export const MINUTE_DEFINITION =
  "A minute is time Belline spends on a live call with your caller — on your phone line or " +
  "through the voice button on your website — from the moment it answers to the moment the " +
  "call ends, rounded up to the next whole minute. Calls you make from your own test console " +
  "do not count, and neither do calls cut short by a fault on our side.";

export const CONVERSATION_DEFINITION =
  "A conversation is one customer's thread in your website chat or on WhatsApp in which Belline replies at " +
  "least once. Everything that customer says in the 24 hours after Belline's first reply is " +
  "the same conversation. Threads your team answers without Belline do not count.";

export const UNIT_DEFINITIONS: Record<Unit, string> = {
  minutes: MINUTE_DEFINITION,
  conversations: CONVERSATION_DEFINITION,
};

// ---------------------------------------------------------------------------
// Billing periods
// ---------------------------------------------------------------------------

export interface Period {
  /** Inclusive, YYYY-MM-DD. */
  start: string;
  /** Exclusive, YYYY-MM-DD. */
  end: string;
  /** 0 for the first period since the subscription began. */
  index: number;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function parse(date: string): { y: number; m: number; d: number } {
  const [y, m, d] = date.split("-").map(Number);
  return { y, m: m - 1, d };
}

function fmt(y: number, m: number, d: number): string {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * The k-th period boundary after the anchor date.
 *
 * The anchor *day* is remembered rather than clamped permanently: a
 * subscription that began on the 31st bills on the 28th in February and goes
 * back to the 31st in March. Clamping once and carrying the clamped day
 * forward silently moves every future invoice, which is the kind of bug that
 * is found a year later by a customer with a spreadsheet.
 */
function boundary(anchor: { y: number; m: number; d: number }, k: number): string {
  const months = anchor.m + k;
  const y = anchor.y + Math.floor(months / 12);
  const m = ((months % 12) + 12) % 12;
  return fmt(y, m, Math.min(anchor.d, daysInMonth(y, m)));
}

/** The billing period a given date falls inside. */
export function periodFor(sub: Pick<Subscription, "startedOn">, onDate: string): Period {
  const anchor = parse(sub.startedOn);
  const today = parse(onDate);

  let k = (today.y - anchor.y) * 12 + (today.m - anchor.m);
  // Before this month's billing day: still inside the previous period.
  if (today.d < Math.min(anchor.d, daysInMonth(today.y, today.m))) k -= 1;
  if (k < 0) k = 0;

  return { index: k, start: boundary(anchor, k), end: boundary(anchor, k + 1) };
}

// ---------------------------------------------------------------------------
// Usage and the bill
// ---------------------------------------------------------------------------

/**
 * One allowance being counted down: a pool (catalogue 2026-10 plans and
 * trials) or a single channel (older products).
 */
export interface Meter {
  id: Pool | Channel;
  kind: "pool" | "channel";
  name: string;
  unit: Unit;
  /** The channels drawing on it, in display order. */
  channels: Channel[];
  /** Episodes this period that counted anything at all. */
  episodes: number;
  used: number;
  /**
   * What this period includes, packs added this period counted in. `null`
   * only on the original ladder's uncounted channels — not a very large
   * number, because a very large number renders as a bar.
   */
  included: number | null;
  /** Units of `included` that came from packs this period. */
  packUnits: number;
  overBy: number;
  /** Share of the allowance used. 0 when uncounted. */
  fraction: number;
  /**
   * Where this period will end if the rest of it runs at the same pace.
   *
   * The whole point of showing it is to tell somebody *before* the invoice
   * rather than after, so it is deliberately not conservative.
   */
  projected: number;
}

export interface ChannelUsage {
  channel: Channel;
  unit: Unit;
  /** The meter this channel draws on: its pool, or itself. */
  meter: Pool | Channel;
  episodes: number;
  used: number;
  /** The meter's figures, repeated so a caller holding a channel need not look the meter up. */
  included: number | null;
  overBy: number;
  fraction: number;
  projected: number;
}

export interface Usage {
  period: Period;
  /** The allowances being counted, in display order. */
  meters: Meter[];
  /** The channels this venue has, with their own counts. */
  channels: ChannelUsage[];
  /** The selection they should be on, when this one no longer fits. */
  upgrade: Recommendation | null;
}

export interface Bill {
  /** What the plan costs for this period, in the market's minor unit. */
  planFee: number;
  /** True on the annual cycle: the plan fee was paid up front for the year. */
  prepaid: boolean;
  /** Packs the owner's policy added this period and that will be charged. Pending packs are not. */
  packsMinor: number;
  /** What will be invoiced at the end of this period: the plan fee (unless prepaid) and chosen packs. Nothing else. */
  dueNow: number;
  state: Subscription["status"];
}

export interface Account {
  market: Market;
  products: ProductId[];
  name: string;
  subscription: Subscription;
  usage: Usage;
  bill: Bill;
  /** Plain sentences for the dashboard. Never a bare number. */
  notes: string[];
}

/** A moment's calendar day in the venue's own timezone, which is the only one its invoice means. */
function dayOf(iso: string, location: Location): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: location.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

/** How far through the period we are, 0 to 1. Never 0, so pace never divides by it. */
function elapsed(period: Period, today: string): number {
  const start = Date.parse(`${period.start}T00:00:00Z`);
  const end = Date.parse(`${period.end}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`) + 86_400_000; // through the end of today
  return Math.min(1, Math.max((now - start) / (end - start), 1 / 31));
}

/**
 * Units used on each channel in a period.
 *
 * Minutes belong to the day the call started; conversations to the day each
 * one began, so a thread that runs across a period boundary is billed where
 * its conversations started rather than twice or not at all.
 */
export function usedInPeriod(
  location: Location,
  period: Period,
): Record<Channel, { used: number; episodes: number }> {
  const out = Object.fromEntries(CHANNEL_ORDER.map((c) => [c, { used: 0, episodes: 0 }])) as Record<
    Channel,
    { used: number; episodes: number }
  >;
  const inside = (iso: string) => {
    const day = dayOf(iso, location);
    return day >= period.start && day < period.end;
  };

  for (const call of listCalls(location.id)) {
    const channel = channelOfCall(call);
    if (!channel) continue;
    let units = 0;
    if (CHANNELS[channel].unit === "minutes") {
      if (inside(call.startedAt)) units = billableVoiceMinutes(call);
    } else {
      units = conversationStarts(call).filter(inside).length;
    }
    if (units > 0) {
      out[channel].used += units;
      out[channel].episodes += 1;
    }
  }
  return out;
}

/** An older trial's phone cap when none was stored. */
const LEGACY_TRIAL_PHONE_MINUTES = 60;

/** What is being counted for this subscription: pools, or channels. */
function limitsFor(
  sub: Subscription,
  products: readonly ProductId[],
): { pools: Partial<Record<Pool, number>> | null; channels: Partial<Record<Channel, number | null>>; open: Channel[] } {
  if (sub.status === "trialing") {
    if (isPooledTrial(sub)) {
      return { pools: { minutes: sub.trial!.minutes, conversations: sub.trial!.conversations! }, channels: {}, open: CHANNEL_ORDER };
    }
    // A trial from before 2026-10: every channel on, the old bundle's
    // allowances, and the phone cap it was given.
    return {
      pools: null,
      channels: { ...allowancesOf(LEGACY_TRIAL_PRODUCTS), phone: sub.trial?.minutes ?? LEGACY_TRIAL_PHONE_MINUTES },
      open: CHANNEL_ORDER,
    };
  }
  if (isPooled(products)) return { pools: poolsOf(products), channels: {}, open: channelsOf(products) };
  return { pools: null, channels: allowancesOf(products), open: channelsOf(products) };
}

const METER_WORDS: Record<Pool | Channel, string> = {
  minutes: "voice minutes",
  conversations: "text conversations",
  phone: "phone minutes",
  web_voice: "voice-button minutes",
  chat: "chat conversations",
  whatsapp: "WhatsApp conversations",
};

export function meterWords(id: Pool | Channel): string {
  return METER_WORDS[id];
}

function meter(
  id: Pool | Channel,
  channels: Channel[],
  included: number | null,
  used: Record<Channel, { used: number; episodes: number }>,
  share: number,
  packUnits = 0,
): Meter {
  const n = channels.reduce((sum, c) => sum + used[c].used, 0);
  const episodes = channels.reduce((sum, c) => sum + used[c].episodes, 0);
  const pool = (POOL_ORDER as string[]).includes(id);
  return {
    id,
    kind: pool ? "pool" : "channel",
    name: pool ? POOL_NAMES[id as Pool] : CHANNELS[id as Channel].name,
    unit: pool ? (id as Pool) : CHANNELS[id as Channel].unit,
    channels,
    episodes,
    used: n,
    included,
    packUnits,
    overBy: included === null ? 0 : Math.max(0, n - included),
    fraction: included ? n / included : 0,
    projected: Math.round(n / share),
  };
}

/** The monthly fee, from what was sold when that is recorded, else from the catalogue. */
function feeOf(sub: Subscription, products: readonly ProductId[], market: Market): number {
  const annual = sub.cycle === "annual";
  if (typeof sub.priceMinor === "number" && sub.priceMinor >= 0) {
    return annual ? Math.floor(sub.priceMinor / 12 / 100) * 100 : sub.priceMinor;
  }
  try {
    const monthly = products.reduce((sum, id) => sum + (productById(id).prices[market] ?? 0), 0);
    if (!annual) return monthly;
    const yearly = products.reduce((sum, id) => {
      const p = productById(id);
      return sum + (p.annualPrices?.[market] ?? (p.prices[market] ?? 0) * 10);
    }, 0);
    return Math.floor(yearly / 12 / 100) * 100;
  } catch {
    return 0;
  }
}

export function accountFor(location: Location, today: string): Account | null {
  const sub = location.subscription;
  if (!sub) return null;

  const products = productsOf(sub);
  const market = subscriptionMarket(sub);
  const period = periodFor(sub, today);
  const trialing = sub.status === "trialing";

  const limits = limitsFor(sub, products);
  const used = usedInPeriod(location, period);
  const share = elapsed(period, today);
  // Packs extend this period's pool and nothing else. Only a paid 2026-10
  // plan has them, and only under a policy the owner chose.
  const packs: UsagePack[] = !trialing && limits.pools ? (sub.packs ?? []).filter((p) => p.periodStart === period.start) : [];
  const packUnits = (pool: Pool) => packs.filter((p) => p.pool === pool).reduce((sum, p) => sum + p.units, 0);

  const meters: Meter[] = limits.pools
    ? POOL_ORDER.filter((pool) => limits.pools![pool] !== undefined).map((pool) =>
        meter(
          pool,
          POOL_CHANNELS[pool].filter((c) => limits.open.includes(c)),
          limits.pools![pool]! + packUnits(pool),
          used,
          share,
          packUnits(pool),
        ),
      )
    : limits.open.map((channel) => {
        // `null` is uncounted (the original ladder) and must survive as null;
        // only a channel with no allowance at all reads as nothing included.
        const raw = limits.channels[channel];
        return meter(channel, [channel], raw === undefined ? 0 : raw, used, share);
      });

  const channels: ChannelUsage[] = limits.open.map((channel) => {
    const m = meters.find((x) => x.channels.includes(channel))!;
    return {
      channel,
      unit: CHANNELS[channel].unit,
      meter: m.id,
      episodes: used[channel].episodes,
      used: used[channel].used,
      included: m.included,
      overBy: m.overBy,
      fraction: m.fraction,
      projected: Math.round(used[channel].used / share),
    };
  });

  const usage: Usage = { period, meters, channels, upgrade: null };

  // Recommended off the projection, not off today's total: telling somebody
  // to move up on the last day of the period is telling them too late. Never
  // during a trial — upselling a plan somebody has not finished trying is the
  // wrong conversation.
  if (!trialing) {
    const pace = Object.fromEntries(
      channels.map((c) => [c.channel, Math.max(c.used, c.projected)]),
    ) as Partial<Record<Channel, number>>;
    usage.upgrade = recommend(pace, products, market);
  }

  const fee = feeOf(sub, products, market);
  const prepaid = !trialing && sub.cycle === "annual";
  const packsMinor = packs.filter((p) => !p.pending).reduce((sum, p) => sum + p.priceMinor, 0);
  const bill: Bill = {
    planFee: trialing ? 0 : fee,
    prepaid,
    packsMinor,
    // Prepaid means the year's plan fee is already paid: only chosen packs remain.
    dueNow: (prepaid || trialing ? 0 : fee) + packsMinor,
    state: sub.status,
  };

  const name = trialing ? "Free trial" : selectionName(products);
  return {
    market,
    products,
    name,
    subscription: sub,
    usage,
    bill,
    notes: notesFor(name, market, products, sub, usage, bill, packs),
  };
}

/** The meter a channel draws on, in an account. */
export function meterFor(account: Account, channel: Channel): Meter | undefined {
  return account.usage.meters.find((m) => m.channels.includes(channel));
}

function spokenDate(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long" });
}

/**
 * The sentences the dashboard shows.
 *
 * Written here rather than in the page because they are the same commitment
 * the pricing page makes, and two copies of a promise drift apart.
 */
/** The sentence for a pool at 100%, in the words of the owner's policy. */
function atLimitSentence(
  pool: Pool,
  sub: Subscription,
  products: readonly ProductId[],
  market: Market,
  packs: UsagePack[],
): string {
  const places = poolPlaces(pool);
  // Stopped whether or not card payments are open: an allowance is a cost cap,
  // not a billing switch (entitlement.ts).
  const stopped = `Belline has stopped answering on ${places} until the next period.`;
  const policy = sub.usagePolicy;
  switch (policy?.mode) {
    case "packs": {
      if (!stripeEnabled()) {
        // No pack is added while nothing could be charged for it (usage-policy.ts).
        return `You chose to add a pack automatically, but card payments are not open yet, so no pack can be added. ${stopped} The Belline team has been told and will contact you to keep it going.`;
      }
      const price = packFor(pool).prices[market] ?? 0;
      const spent = packs.reduce((sum, p) => sum + p.priceMinor, 0);
      if (policy.monthlyCapMinor !== undefined && spent + price > policy.monthlyCapMinor) {
        return `Your monthly spending cap of ${money(policy.monthlyCapMinor, market)} is reached, so no more packs are added. ${stopped}`;
      }
      return `A pack of ${packFor(pool).name} is added on the next ${pool === "minutes" ? "call" : "conversation"}, as you chose.`;
    }
    case "upgrade": {
      const next = nextPlanUp(products, market);
      return next
        ? `You chose to move up: ${next.name} would carry it — confirm it from Change plan. Until you do, it stops at the allowance. ${stopped}`
        : `You are on the largest plan, so it stops at the allowance. ${stopped}`;
    }
    case "cap":
      return `You chose to stop at the allowance. ${stopped}`;
    default:
      return `You have not chosen what happens at 100% yet, so it stops at the allowance. ${stopped}`;
  }
}

function notesFor(
  name: string,
  market: Market,
  products: readonly ProductId[],
  sub: Subscription,
  usage: Usage,
  bill: Bill,
  packs: UsagePack[] = [],
): string[] {
  const notes: string[] = [];

  if (sub.status === "trialing") {
    const parts = usage.meters
      .filter((m) => m.included !== null && m.included > 0 && (m.kind === "pool" || m.id === "phone"))
      .map((m) => ({ m, left: Math.max(0, (m.included as number) - m.used) }));
    const spent = parts.filter((p) => p.left === 0);
    if (sub.trial?.extendedFrom && sub.trial.endsOn && !stripeEnabled()) {
      // Extended because card payments were closed when it reached its end
      // (billing/trial-end.ts). Leads the page: it is the date that matters.
      notes.push(`Payments open soon — you're covered until ${spokenDate(sub.trial.endsOn)}.`);
    }
    notes.push(
      spent.length === 0
        ? `Trial: ${parts.map((p) => `${p.left} of ${p.m.included} ${meterWords(p.m.id)}`).join(" and ")} left. Nothing is charged during the trial.`
        : `Trial: all ${spent.map((p) => `${p.m.included} ${meterWords(p.m.id)}`).join(" and ")} used, so Belline has stopped answering on ${spent.map((p) => (p.m.id === "conversations" ? "chat and WhatsApp" : "calls and the voice button")).join(" and on ")}. Nothing has been charged — ${
            stripeEnabled()
              ? "choose a plan to keep going."
              : "card payments are not open yet, so the Belline team has been told and will contact you to keep it going."
          }`,
    );
    return notes;
  }

  if (sub.status === "cancelled") {
    notes.push("Cancelled. Belline answers until the end of this period, then stops.");
  }

  if (sub.paymentFailedAt) {
    // First, above everything else about the period: it is the one line on
    // this screen that needs something done today.
    notes.unshift(
      "The last payment did not go through. Belline is still answering while Stripe retries — " +
        "update the card and we will try again.",
    );
  }

  if (sub.grandfatheredUntil && grandfatherExpires(products)) {
    notes.push(
      `You are on the original ${name} plan, kept exactly as it was until ${spokenDate(sub.grandfatheredUntil)}. ` +
        "Choose a plan from the new range before then.",
    );
  } else if (products.some((id) => grandfatherOf(productById(id)) === "indefinite")) {
    notes.push(`You are on ${name}, kept exactly as you bought it. It is no longer sold, and you can keep it.`);
  }

  // A 2026-10 plan: what happens at 100% is the owner's choice, and until it
  // is made that question leads the page.
  const governed = sub.status !== "cancelled" && isPooled(products);
  if (governed && !sub.usagePolicy) {
    notes.unshift(
      "Choose what happens at 100% of an allowance: add a pack automatically, move up to the next plan, " +
        "or stop at the allowance. Until you choose, Belline stops at 100% — and nothing is added to your bill.",
    );
  }
  for (const pack of packs) {
    const name = packFor(pack.pool).name;
    notes.push(
      pack.pending
        ? `Added ${name} (${money(pack.priceMinor, market)}) — not charged, because card payments are not switched on.`
        : `Added ${name} for ${money(pack.priceMinor, market)}, as you chose — on your next invoice.`,
    );
  }

  for (const m of usage.meters) {
    if (m.included === null) continue;
    const what = meterWords(m.id);
    if (governed && m.kind === "pool") {
      const base = m.included - m.packUnits;
      const covers = m.packUnits ? "your plan and packs include" : "your plan includes";
      if (m.used >= m.included) {
        notes.push(
          m.overBy > 0
            ? `${m.overBy} ${what} past the ${m.included} ${covers} this period.`
            : `All ${m.included} ${what} ${covers} this period are used.`,
        );
        notes.push(atLimitSentence(m.id as Pool, sub, products, market, packs));
      } else if (m.projected > m.included) {
        notes.push(
          `On this pace you will finish the period around ${m.projected} ${what}, past the ` +
            `${m.included} ${covers}. Told now rather than at the end.`,
        );
      } else {
        const crossed = [90, 70].find((t) => base > 0 && m.used * 100 >= t * base);
        if (crossed) notes.push(`${crossed}% of your ${what} used — ${m.used} of ${base}.`);
      }
      continue;
    }
    if (m.overBy > 0) {
      notes.push(`${m.overBy} ${what} past the ${m.included} your plan includes this period.`);
    } else if (m.projected > m.included) {
      notes.push(
        `On this pace you will finish the period around ${m.projected} ${what}, past the ` +
          `${m.included} your plan includes. Told now rather than at the end.`,
      );
    } else if (m.fraction >= 0.8) {
      notes.push(`${Math.round(m.fraction * 100)}% of your ${what} used.`);
    }
  }

  if (sub.alerts?.pendingSince && sub.alerts.periodStart === usage.period.start && sub.alerts.pending) {
    // The alert email has not gone (email is off, or sending failed). Said
    // here so the owner learns it from the page; the sweep keeps trying.
    notes.push("We could not email you about your usage yet, so check this page — the figures here are up to date.");
  }

  if (usage.upgrade) {
    notes.push(`${usage.upgrade.name} would cover it — ${money(usage.upgrade.monthly, market)} a month.`);
  }

  if (bill.prepaid) {
    notes.push("Paid up front for the year, so there is nothing to invoice this period.");
  }

  return notes;
}

export { poolOf };

import type { Call, Location, Subscription } from "../types";
import { listCalls } from "../store";
import { callDurationSeconds } from "../calls";
import { marketOf, type Market } from "../markets";
import {
  ANNUAL_MONTHS_FREE,
  CHANNELS,
  CHANNEL_ORDER,
  TRIAL,
  allowancesOf,
  annualPerMonth,
  channelsOf,
  money,
  productById,
  recommend,
  selectionName,
  type Channel,
  type ProductId,
  type Recommendation,
  type Unit,
} from "./plans";

/**
 * Minutes, conversations, allowances, and what the invoice will say.
 *
 * The promise on the pricing page is "no surprise invoices", and a promise
 * like that is kept in this file or not at all. Three decisions carry it:
 *
 *   What counts — a minute, a conversation — is defined once, here, and the
 *   website quotes these definitions rather than paraphrasing them.
 *
 *   The invoice is the plan fee and nothing else. There is no metered charge
 *   anywhere in this product: an allowance that runs out is a prompt to move
 *   up, never a second number on a bill. The moment anything else can appear
 *   in `dueNow`, the promise stops being true.
 *
 *   Where the rule is genuinely ambiguous, the customer wins. Calls we broke
 *   are not counted; the projection rounds toward telling somebody sooner;
 *   and going past a paid allowance never stops anybody being answered.
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

/** True for a venue still on the ladder sold before the modular catalogue. */
export function isLegacy(sub: Subscription | undefined): boolean {
  return productsOf(sub).some((id) => productById(id).kind === "legacy");
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
 */
export function billableVoiceMinutes(call: Call): number {
  const channel = channelOfCall(call);
  if (call.isDemo) return 0;
  if (channel !== "phone" && channel !== "web_voice") return 0;
  if (call.status !== "completed") return 0;
  if (!call.endedAt) return 0;

  const seconds = callDurationSeconds(call);
  if (seconds <= 0) return 0;
  return Math.ceil(seconds / 60);
}

/** Phone minutes only — what the trial caps and the call list on the billing page shows. */
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
  "A conversation is one customer's thread in your website chat in which Belline replies at " +
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

export interface ChannelUsage {
  channel: Channel;
  unit: Unit;
  /** Episodes this period that counted anything at all. */
  episodes: number;
  used: number;
  /**
   * What this period includes: the plan's allowance, or the trial's.
   * `null` only on a grandfathered legacy plan, which was sold uncounted —
   * not a very large number, because a very large number renders as a bar.
   */
  included: number | null;
  /** Past the allowance. Nothing is charged for it; see `Usage.upgrade`. */
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

export interface Usage {
  period: Period;
  /** The channels this venue has, in display order. */
  channels: ChannelUsage[];
  /** The selection they should be on, when this one no longer fits. */
  upgrade: Recommendation | null;
}

export interface Bill {
  /** What the plan costs for this period, in the market's minor unit. */
  planFee: number;
  /** True on the annual cycle: the plan fee was paid up front for the year. */
  prepaid: boolean;
  /**
   * What will actually be invoiced at the end of this period.
   *
   * This is the plan fee and nothing else, ever. There is no metered charge
   * in this product — going past an allowance is a prompt to move up, not a
   * line on a bill. It is the whole of what "no surprise invoices" means.
   */
  dueNow: number;
  state: Subscription["status"];
}

export interface Account {
  market: Market;
  products: ProductId[];
  /** "Everything Business", or the modules joined. */
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

/** What a trial includes: every channel, the trial's own phone cap, the trialled bundle's other allowances. */
function trialAllowances(sub: Subscription): Partial<Record<Channel, number | null>> {
  const trialled = allowancesOf(TRIAL.products);
  return { ...trialled, phone: sub.trial?.minutes ?? TRIAL.phoneMinutes };
}

export function accountFor(location: Location, today: string): Account | null {
  const sub = location.subscription;
  if (!sub) return null;

  const products = productsOf(sub);
  const market = subscriptionMarket(sub);
  const period = periodFor(sub, today);
  const trialing = sub.status === "trialing";

  const allowances = trialing ? trialAllowances(sub) : allowancesOf(products);
  const channels = trialing ? CHANNEL_ORDER : channelsOf(products);
  const used = usedInPeriod(location, period);
  const share = elapsed(period, today);

  const usage: Usage = {
    period,
    channels: channels.map((channel) => {
      // `null` is uncounted (a grandfathered plan) and must survive as null;
      // only a channel with no allowance at all reads as nothing included.
      const raw = allowances[channel];
      const included = raw === undefined ? 0 : raw;
      const { used: n, episodes } = used[channel];
      return {
        channel,
        unit: CHANNELS[channel].unit,
        episodes,
        used: n,
        included,
        overBy: included === null ? 0 : Math.max(0, n - included),
        fraction: included ? n / included : 0,
        projected: Math.round(n / share),
      };
    }),
    upgrade: null,
  };

  // Recommended off the projection, not off today's total: telling somebody
  // to move up on the last day of the period is telling them too late. Never
  // during a trial — upselling a plan somebody has not finished trying is the
  // wrong conversation.
  if (!trialing) {
    const pace = Object.fromEntries(
      usage.channels.map((c) => [c.channel, Math.max(c.used, c.projected)]),
    ) as Partial<Record<Channel, number>>;
    usage.upgrade = recommend(pace, products, market);
  }

  const fee = (() => {
    try {
      return sub.cycle === "annual" ? annualPerMonth(products, market) : monthlyOfSafe(products, market);
    } catch {
      return 0;
    }
  })();

  const prepaid = !trialing && sub.cycle === "annual";
  const bill: Bill = {
    planFee: trialing ? 0 : fee,
    prepaid,
    // Prepaid means the year is already paid: nothing further this period.
    dueNow: prepaid || trialing ? 0 : fee,
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
    notes: notesFor(name, market, products, sub, usage, bill),
  };
}

function monthlyOfSafe(products: readonly ProductId[], market: Market): number {
  return products.reduce((sum, id) => sum + (productById(id).prices[market] ?? 0), 0);
}

function unitWord(channel: Channel): string {
  switch (channel) {
    case "phone":
      return "phone minutes";
    case "web_voice":
      return "voice-button minutes";
    case "chat":
      return "chat conversations";
    case "whatsapp":
      return "WhatsApp conversations";
  }
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
function notesFor(
  name: string,
  market: Market,
  products: readonly ProductId[],
  sub: Subscription,
  usage: Usage,
  bill: Bill,
): string[] {
  const notes: string[] = [];

  if (sub.status === "trialing") {
    const phone = usage.channels.find((c) => c.channel === "phone");
    const allowance = phone?.included ?? 0;
    const left = Math.max(0, allowance - (phone?.used ?? 0));
    notes.push(
      left > 0
        ? `Trial: ${left} of ${allowance} phone minutes left, and every channel is switched on. Nothing is charged during the trial.`
        : `Trial: all ${allowance} phone minutes used. Nothing has been charged — pick a plan to keep going.`,
    );
    return notes;
  }

  if (sub.status === "cancelled") {
    notes.push("Cancelled. Belline keeps answering until the end of this period, then stops.");
  }

  if (sub.paymentFailedAt) {
    // First, above everything else about the period: it is the one line on
    // this screen that needs something done today.
    notes.unshift(
      "The last payment did not go through. Belline is still answering — update the card " +
        "and we will try again; nothing stops before the retries run out.",
    );
  }

  if (sub.grandfatheredUntil && isLegacy(sub)) {
    notes.push(
      `You are on the original ${name} plan, kept exactly as it was until ${spokenDate(sub.grandfatheredUntil)}. ` +
        "Choose a plan from the new range before then.",
    );
  }

  for (const c of usage.channels) {
    if (c.included === null) continue;
    const what = unitWord(c.channel);
    if (c.overBy > 0) {
      // Deliberately not an apology and not a threat. A receptionist that
      // stops answering because of an invoice is not a receptionist, and the
      // answer is a bigger plan, not a bigger bill.
      notes.push(
        `${c.overBy} ${what} past the ${c.included} your plan includes. ` +
          "Everyone is still being answered and nothing extra has been charged.",
      );
    } else if (c.projected > c.included) {
      notes.push(
        `On this pace you will finish the period around ${c.projected} ${what}, past the ` +
          `${c.included} your plan includes. Told now rather than at the end.`,
      );
    } else if (c.fraction >= 0.8) {
      notes.push(`${Math.round(c.fraction * 100)}% of your ${what} used.`);
    }
  }

  if (usage.upgrade) {
    notes.push(`${usage.upgrade.name} would cover it — ${money(usage.upgrade.monthly, market)} a month.`);
  }

  if (bill.prepaid) {
    notes.push(
      `Paid up front for the year — ${ANNUAL_MONTHS_FREE} months free — so there is ` +
        "nothing to invoice this period.",
    );
  }

  return notes;
}

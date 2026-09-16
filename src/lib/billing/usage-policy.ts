import type { Location, Subscription, UsageAlertThreshold, UsagePack, UsagePolicy, User } from "../types";
import { getLocation, getTenant, listLocations as listAllLocations, listLocationsFor, listUsersFor, upsertLocation } from "../store";
import { canManageUsers } from "../auth";
import { MARKETS } from "../markets";
import { deliverEmail } from "../mailer";
import { todayIn } from "../time";
import {
  ALERT_THRESHOLDS,
  POOL_ORDER,
  isPooled,
  money,
  nextPlanUp,
  packFor,
  type Pool,
  type ProductId,
} from "./plans";
import { accountFor, productsOf, subscriptionMarket } from "./usage";
import { stripe, stripeEnabled } from "./stripe";

/**
 * What happens at 100% of an allowance.
 *
 * The owner chooses, and nothing is ever charged that they did not choose:
 *
 *   packs   — add a pack automatically when a pool runs out, as many times
 *             as it takes, up to an optional monthly spending cap. Past the
 *             cap it stops like `cap`.
 *   upgrade — recommend the next plan. Changing a plan is the owner's to
 *             confirm (Change plan → checkout); until then it behaves as `cap`.
 *   cap     — stop answering on that pool's channels until the next period.
 *
 * No choice yet behaves as `cap`, adds nothing, and the dashboard asks for
 * a choice at the top of every note.
 *
 * Stopping is enforced by entitlement.ts whether or not card payments are
 * switched on: an allowance is cost protection, not billing. (With payments
 * off a `packs` policy still records packs as pending and uncharged.)
 *
 * Applies to catalogue 2026-10 plans only. Older products were sold on other
 * terms and keep them; trials have their own caps.
 *
 * `decide` is pure over the store's current state; `applyUsagePolicy` writes
 * what it decided; `settlePacks` is the only thing here that talks to Stripe.
 */

export { ALERT_THRESHOLDS };

export interface Alert {
  pool: Pool;
  threshold: UsageAlertThreshold;
}

export interface PoolDecision {
  pool: Pool;
  used: number;
  /** The plan's own allowance. */
  base: number;
  /** Units added by this period's packs, before any this decision adds. */
  packUnits: number;
  /** What is available after this decision's packs. */
  allowance: number;
  exhausted: boolean;
  action: "none" | "pack_added" | "cap_reached" | "upgrade_recommended" | "choose_policy";
  upgradeTo?: ProductId;
}

export interface Decision {
  /** False for anything the policy does not govern: no subscription, a trial, an older product, one of our own venues. */
  applies: boolean;
  periodStart: string;
  alerts: Alert[];
  pools: Record<Pool, PoolDecision>;
  /** Packs to add now. Empty unless the owner chose `packs`. */
  packs: UsagePack[];
}

function exempt(location: Location): boolean {
  if (location.demo?.enabled || location.prospect || location.internal) return true;
  return Boolean(getTenant(location.tenantId)?.internal);
}

/** Does the usage policy govern this subscription? */
export function governs(location: Location): boolean {
  const sub = location.subscription;
  return Boolean(sub && sub.status !== "trialing" && isPooled(productsOf(sub)) && !exempt(location));
}

function idle(pool: Pool): PoolDecision {
  return { pool, used: 0, base: 0, packUnits: 0, allowance: 0, exhausted: false, action: "none" };
}

function packsIn(sub: Subscription, periodStart: string): UsagePack[] {
  return (sub.packs ?? []).filter((p) => p.periodStart === periodStart);
}

export function decide(location: Location, today: string, opts: { stripe?: boolean } = {}): Decision {
  const none: Decision = {
    applies: false,
    periodStart: "",
    alerts: [],
    pools: { minutes: idle("minutes"), conversations: idle("conversations") },
    packs: [],
  };
  if (!governs(location)) return none;
  const account = accountFor(location, today);
  if (!account) return none;

  const sub = location.subscription!;
  const market = subscriptionMarket(sub);
  const periodStart = account.usage.period.start;
  const thisPeriod = packsIn(sub, periodStart);
  const policy = sub.usagePolicy;
  // Already sent, or raised and waiting to be sent: neither is raised again.
  const record = sub.alerts?.periodStart === periodStart ? sub.alerts : undefined;
  const sent: Partial<Record<Pool, UsageAlertThreshold[]>> = {};
  for (const pool of POOL_ORDER) {
    sent[pool] = [...(record?.sent[pool] ?? []), ...(record?.pending?.[pool] ?? [])];
  }
  const chargeable = opts.stripe ?? stripeEnabled();

  let spent = thisPeriod.reduce((sum, p) => sum + p.priceMinor, 0);
  const decision: Decision = { ...none, applies: true, periodStart };

  for (const pool of POOL_ORDER) {
    const meter = account.usage.meters.find((m) => m.id === pool);
    if (!meter || meter.included === null) continue;
    const packUnits = thisPeriod.filter((p) => p.pool === pool).reduce((sum, p) => sum + p.units, 0);
    const base = meter.included - packUnits;
    const used = meter.used;

    // Alerts are against the plan's own allowance, once each per period.
    for (const threshold of ALERT_THRESHOLDS) {
      if (base > 0 && used * 100 >= threshold * base && !(sent[pool] ?? []).includes(threshold)) {
        decision.alerts.push({ pool, threshold });
      }
    }

    let allowance = meter.included;
    const out: PoolDecision = { pool, used, base, packUnits, allowance, exhausted: false, action: "none" };
    if (used < allowance) {
      decision.pools[pool] = out;
      continue;
    }

    switch (policy?.mode) {
      case "packs": {
        const pack = packFor(pool);
        const price = pack.prices[market];
        let added = 0;
        let n = thisPeriod.filter((p) => p.pool === pool).length;
        while (pack.status === "live" && price !== undefined && used >= allowance) {
          if (policy.monthlyCapMinor !== undefined && spent + price > policy.monthlyCapMinor) break;
          n += 1;
          decision.packs.push({
            periodStart,
            pool,
            units: pack.units,
            priceMinor: price,
            key: `${location.id}:${periodStart}:${pool}:${n}`,
            at: new Date().toISOString(),
            ...(chargeable ? {} : { pending: true as const }),
          });
          spent += price;
          allowance += pack.units;
          added += 1;
        }
        out.allowance = allowance;
        out.exhausted = used >= allowance;
        out.action = out.exhausted ? "cap_reached" : added > 0 ? "pack_added" : "none";
        break;
      }
      case "upgrade": {
        const next = nextPlanUp(productsOf(sub), market);
        out.exhausted = true;
        out.action = next ? "upgrade_recommended" : "cap_reached";
        if (next) out.upgradeTo = next.id;
        break;
      }
      case "cap":
        out.exhausted = true;
        out.action = "cap_reached";
        break;
      default:
        out.exhausted = true;
        out.action = "choose_policy";
    }
    decision.pools[pool] = out;
  }

  return decision;
}

/** Is the pool this channel draws on used up, after the policy has done what it may? */
export function poolExhausted(location: Location, today: string, pool: Pool): boolean {
  const d = decide(location, today);
  return d.applies && d.pools[pool].exhausted;
}

export interface Applied {
  location: Location;
  decision: Decision;
  /** Alerts raised by this call, recorded as pending until `markAlertsSent`. */
  alerts: Alert[];
  /** Packs added by this call. */
  added: UsagePack[];
}

type Thresholds = Partial<Record<Pool, UsageAlertThreshold[]>>;

function withAlerts(into: Thresholds, alerts: Alert[]): Thresholds {
  const out: Thresholds = { ...into };
  for (const { pool, threshold } of alerts) {
    out[pool] = [...new Set([...(out[pool] ?? []), threshold])].sort((a, b) => a - b) as UsageAlertThreshold[];
  }
  return out;
}

function withoutAlerts(from: Thresholds, alerts: Alert[]): Thresholds {
  const out: Thresholds = {};
  for (const pool of POOL_ORDER) {
    const left = (from[pool] ?? []).filter((t) => !alerts.some((a) => a.pool === pool && a.threshold === t));
    if (left.length) out[pool] = left;
  }
  return out;
}

/**
 * Record what `decide` decided: alerts as pending, packs as added. Idempotent.
 *
 * An alert is not "sent" until the email went. It used to be recorded as sent
 * before anything was tried, so with email off or failing the owner was never
 * told and never would be.
 */
export function applyUsagePolicy(location: Location, today: string, opts: { stripe?: boolean; now?: Date } = {}): Applied {
  const decision = decide(location, today, opts);
  if (!decision.applies || (decision.alerts.length === 0 && decision.packs.length === 0)) {
    return { location, decision, alerts: [], added: [] };
  }
  const sub = location.subscription!;
  const next: Subscription = { ...sub };

  if (decision.alerts.length) {
    const same = sub.alerts?.periodStart === decision.periodStart ? sub.alerts : undefined;
    next.alerts = {
      periodStart: decision.periodStart,
      sent: { ...(same?.sent ?? {}) },
      pending: withAlerts(same?.pending ?? {}, decision.alerts),
      pendingSince: same?.pendingSince ?? (opts.now ?? new Date()).toISOString(),
    };
  }

  const keys = new Set((sub.packs ?? []).map((p) => p.key));
  const added = decision.packs.filter((p) => !keys.has(p.key));
  if (added.length) next.packs = [...(sub.packs ?? []), ...added];

  const saved = upsertLocation({ ...location, subscription: next });
  return { location: saved ?? { ...location, subscription: next }, decision, alerts: decision.alerts, added };
}

/**
 * Put the chosen packs on the customer's next Stripe invoice.
 *
 * Only packs recorded while card payments were on, only once each — Stripe's
 * idempotency key is the pack's own key, so a retry after a crash cannot
 * charge twice. Nothing happens without card payments switched on.
 */
export async function settlePacks(locationId: string): Promise<number> {
  if (!stripeEnabled()) return 0;
  const location = getLocation(locationId);
  const sub = location?.subscription;
  const customer = location?.stripe?.customerId;
  if (!location || !sub || !customer) return 0;

  let settled = 0;
  for (const pack of (sub.packs ?? []).filter((p) => !p.pending && !p.invoiceItemId)) {
    const market = subscriptionMarket(sub);
    const item = await stripe().invoiceItems.create(
      {
        customer,
        amount: pack.priceMinor,
        currency: MARKETS[market].currency.toLowerCase(),
        description: `${packFor(pack.pool).name}, billing period from ${pack.periodStart}`,
        metadata: { belline_location: location.id, belline_pack: pack.key },
      },
      { idempotencyKey: pack.key },
    );
    const fresh = getLocation(locationId);
    if (!fresh?.subscription) break;
    upsertLocation({
      ...fresh,
      subscription: {
        ...fresh.subscription,
        packs: (fresh.subscription.packs ?? []).map((p) => (p.key === pack.key ? { ...p, invoiceItemId: item.id } : p)),
      },
    });
    settled++;
  }
  return settled;
}

/** The alerts waiting to be sent for this venue's current record. */
export function pendingAlerts(location: Location): { periodStart: string; alerts: Alert[] } | null {
  const record = location.subscription?.alerts;
  if (!record?.pending) return null;
  const alerts = POOL_ORDER.flatMap((pool) => (record.pending?.[pool] ?? []).map((threshold) => ({ pool, threshold })));
  return alerts.length ? { periodStart: record.periodStart, alerts } : null;
}

/**
 * Move alerts from pending to sent, once the email actually went. Re-reads the
 * venue, so a call that raced it is not overwritten; does nothing if the
 * period has moved on since.
 */
export function markAlertsSent(locationId: string, periodStart: string, alerts: Alert[]): Location | undefined {
  const fresh = getLocation(locationId);
  const record = fresh?.subscription?.alerts;
  if (!fresh?.subscription || !record || record.periodStart !== periodStart || alerts.length === 0) return fresh;
  const pending = withoutAlerts(record.pending ?? {}, alerts);
  const still = Object.keys(pending).length > 0;
  return upsertLocation({
    ...fresh,
    subscription: {
      ...fresh.subscription,
      alerts: {
        periodStart,
        sent: withAlerts(record.sent, alerts),
        ...(still ? { pending, pendingSince: record.pendingSince } : {}),
      },
    },
  });
}

/**
 * Try every pending alert again. The billing sweep calls this; an alert whose
 * period has ended is dropped with the period's record, not sent late.
 */
export async function retryPendingAlerts(
  send: (location: Location, alerts: Alert[]) => Promise<boolean> = notifyAlerts,
  opts: { today?: string } = {},
): Promise<{ sent: number; pending: number }> {
  let sent = 0;
  let pending = 0;
  for (const venue of listAllLocations()) {
    const waiting = pendingAlerts(venue);
    if (!waiting || !governs(venue)) continue;
    const account = accountFor(venue, opts.today ?? todayIn(venue.timezone));
    if (!account || account.usage.period.start !== waiting.periodStart) continue;
    const ok = await send(venue, waiting.alerts).catch(() => false);
    if (ok) {
      markAlertsSent(venue.id, waiting.periodStart, waiting.alerts);
      sent += waiting.alerts.length;
    } else {
      pending += waiting.alerts.length;
    }
  }
  return { sent, pending };
}

const POOL_WORDS: Record<Pool, string> = { minutes: "voice minutes", conversations: "text conversations" };

/**
 * Tell the owner by email. True only when the email went: the caller marks
 * the alerts sent on true and leaves them pending otherwise. The dashboard
 * notes say the same thing regardless.
 */
export async function notifyAlerts(location: Location, alerts: Alert[]): Promise<boolean> {
  const owner = listUsersFor(location.tenantId).find((u) => u.role === "owner");
  if (!owner || alerts.length === 0) return false;
  const lines = alerts.map((a) => `${a.threshold}% of this period's ${POOL_WORDS[a.pool]} used at ${location.name}.`);
  const mode = location.subscription?.usagePolicy?.mode;
  const next =
    mode === "packs"
      ? "At 100% a pack is added, as you chose, within your monthly cap."
      : mode === "upgrade"
        ? "At 100% we recommend the next plan; until you confirm it, Belline stops at the allowance."
        : mode === "cap"
          ? "At 100% Belline stops at the allowance, as you chose."
          : "You have not chosen what happens at 100% yet — until you do, Belline stops at the allowance.";
  const delivery = await deliverEmail({
    to: owner.email,
    subject: `Belline usage at ${location.name}`,
    text: `${lines.join("\n")}\n\n${next}\n\nNothing is added to your bill unless you chose it.`,
    html: `<p>${lines.join("<br>")}</p><p>${next}</p><p>Nothing is added to your bill unless you chose it.</p>`,
  });
  return delivery.delivered;
}

// ---------------------------------------------------------------------------
// The owner's choice
// ---------------------------------------------------------------------------

export interface PolicyResponse {
  status: number;
  body: { ok: true; usagePolicy: UsagePolicy } | { error: string };
}

const MODES = new Set<UsagePolicy["mode"]>(["packs", "upgrade", "cap"]);

/**
 * Set a venue's usage policy. The route is a wrapper around this, so the rules
 * — signed in, an owner, a venue of their own tenant, a real choice — are
 * tested without a request.
 */
export function setUsagePolicyRequest(user: User | null, raw: unknown, now = new Date()): PolicyResponse {
  if (!user) return { status: 401, body: { error: "Not signed in." } };
  if (!canManageUsers(user)) return { status: 403, body: { error: "Only an owner can do that." } };

  const body = (raw && typeof raw === "object" ? raw : {}) as { locationId?: unknown; mode?: unknown; monthlyCapAed?: unknown };
  const venues = listLocationsFor(user.tenantId);
  const location = typeof body.locationId === "string" ? venues.find((l) => l.id === body.locationId) : venues[0];
  if (!location) return { status: 404, body: { error: "No such venue." } };
  if (!location.subscription) return { status: 409, body: { error: "This venue is not on a plan yet." } };

  if (typeof body.mode !== "string" || !MODES.has(body.mode as UsagePolicy["mode"])) {
    return { status: 400, body: { error: "Choose packs, upgrade or stop." } };
  }
  const mode = body.mode as UsagePolicy["mode"];

  let monthlyCapMinor: number | undefined;
  const cap = body.monthlyCapAed;
  if (cap !== undefined && cap !== null && cap !== "") {
    const n = typeof cap === "number" ? cap : typeof cap === "string" && /^\d+$/.test(cap.trim()) ? Number(cap) : NaN;
    if (!Number.isInteger(n) || n < 0) {
      return { status: 400, body: { error: "The monthly cap is a whole number of dirhams, or empty for none." } };
    }
    monthlyCapMinor = n * 100;
  }

  const usagePolicy: UsagePolicy = {
    mode,
    ...(mode === "packs" && monthlyCapMinor !== undefined ? { monthlyCapMinor } : {}),
    chosenAt: now.toISOString(),
    chosenBy: user.id,
  };
  upsertLocation({ ...location, subscription: { ...location.subscription, usagePolicy } });
  return { status: 200, body: { ok: true, usagePolicy } };
}

/** The pack sentence for one pool, for notes. */
export function packLine(pack: UsagePack, marketMinor: (minor: number) => string = (m) => money(m, "AE")): string {
  const name = packFor(pack.pool).name;
  return pack.pending
    ? `Added ${name} (${marketMinor(pack.priceMinor)}) — not charged, because card payments are not switched on.`
    : pack.invoiceItemId
      ? `Added ${name} for ${marketMinor(pack.priceMinor)}, on your next invoice.`
      : `Added ${name} for ${marketMinor(pack.priceMinor)}, to go on your next invoice.`;
}

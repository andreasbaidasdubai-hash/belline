import type Stripe from "stripe";
import type { Location } from "../types";
import { getLocation, getTenant, upsertLocation } from "../store";
import { flag } from "../flags";
import { addDays } from "../time";
import { TRIAL, periodFee } from "./plans";
import { productsOf, subscriptionMarket } from "./usage";
import { priceFor, stripe, stripeEnabled } from "./stripe";

/**
 * The card at Go live (trial-at-golive.md, founder decision 2026-09-16).
 *
 *   Signing up and setting up ask for nothing.
 *   Go live asks for a card, charges nothing, and starts the free month:
 *     "Free until <date>. Cancel any time before then and you pay nothing."
 *   The first charge is the plan fee on day 31.
 *
 * The card is captured with Stripe Checkout in setup mode, so no card number
 * touches Belline. Its webhook records the setup intent; the card's
 * fingerprint is looked up at Go live and compared with every other account's
 * (one trial per business, abuse/review.ts). Then a Stripe subscription is
 * created with `trial_end` on day 31, so Stripe raises the first invoice and
 * a cancel before then charges nothing.
 *
 * Only while `billing.stripe` is on. With payments closed none of this runs:
 * Go live is not blocked, the team gets a `stripe_off_trial_end` row, the
 * usage caps still hold, and trial-end.ts extends rather than switching
 * anybody off. Under stubs every Stripe call is played by testing/stubs.ts.
 */

export const CARD_PURPOSE = "golive_card";
export const TRIAL_PURPOSE = "golive_trial";

function exempt(location: Location): boolean {
  if (location.demo?.enabled || location.prospect || location.internal) return true;
  return Boolean(getTenant(location.tenantId)?.internal);
}

/** The venue's local date at an instant. */
export function dayIn(timezone: string, at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** The free month's last day, counted from the day the venue went live in its own timezone. */
export function trialEndFor(activatedAt: Date, timezone: string): string {
  return addDays(dayIn(timezone, activatedAt), TRIAL.days);
}

/** Does Go live need a card first? Only a trial, only with payments open, only once. */
export function cardRequired(location: Location, opts: { payments?: boolean } = {}): boolean {
  if (!(opts.payments ?? stripeEnabled())) return false;
  if (exempt(location) || location.subscription?.status !== "trialing") return false;
  return !location.stripe?.cardSavedAt;
}

/** The sentence beside the card step. Never says payment is live when it is not. */
export function cardSentence(location: Location, now: Date = new Date()): string {
  const ends = trialEndFor(now, location.timezone);
  const spoken = new Date(`${ends}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long" });
  return `Add a card to go live. Nothing is charged today: Belline is free until ${spoken}. Cancel any time before then and you pay nothing.`;
}

export interface CardSetupInput {
  location: Location;
  email: string;
  successUrl: string;
  cancelUrl: string;
}

/** The setup-mode session Stripe is asked to open. Pure, so a check can read it. */
export function cardSetupParams(input: CardSetupInput, customer?: string): Stripe.Checkout.SessionCreateParams {
  const meta = { belline_location: input.location.id, belline_tenant: input.location.tenantId, belline_purpose: CARD_PURPOSE };
  return {
    mode: "setup",
    payment_method_types: ["card"],
    ...(customer ? { customer } : { customer_email: input.email }),
    client_reference_id: input.location.id,
    metadata: meta,
    setup_intent_data: { metadata: meta },
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
  };
}

/** Open Stripe's card page. Returns the URL for the browser. */
export async function createCardSetup(input: CardSetupInput): Promise<{ url: string }> {
  if (flag("stubs")) {
    const { stubCheckoutSession } = await import("../testing/stubs");
    const params = cardSetupParams(input, input.location.stripe?.customerId ?? `cus_stub_${input.location.id.slice(-12)}`);
    return stubCheckoutSession(new URL(input.successUrl).origin, params as unknown as Record<string, unknown>);
  }
  const s = stripe();
  const customer =
    input.location.stripe?.customerId ??
    (await s.customers.create({ email: input.email, metadata: { belline_location: input.location.id, belline_tenant: input.location.tenantId } })).id;
  if (customer !== input.location.stripe?.customerId) {
    upsertLocation({ ...input.location, stripe: { ...input.location.stripe, customerId: customer } });
  }
  const session = await s.checkout.sessions.create(cardSetupParams(input, customer));
  if (!session.url) throw new Error("Stripe returned a setup session with no URL.");
  return { url: session.url };
}

/**
 * A completed setup-mode checkout: the card is on file. Null for any other
 * event, so stripe.ts carries on with its own cases.
 */
export function applyCardEvent(event: Stripe.Event): { locationId?: string; applied: string } | null {
  if (event.type !== "checkout.session.completed") return null;
  const session = event.data.object;
  if (session.mode !== "setup" || session.metadata?.belline_purpose !== CARD_PURPOSE) return null;
  const locationId = session.metadata?.belline_location ?? session.client_reference_id ?? undefined;
  if (!locationId) return { applied: "ignored: no venue on the card session" };
  const location = getLocation(locationId);
  if (!location) return { locationId, applied: "ignored: unknown venue" };
  const setupIntentId = typeof session.setup_intent === "string" ? session.setup_intent : session.setup_intent?.id;
  if (location.stripe?.setupIntentId && location.stripe.setupIntentId === setupIntentId) {
    return { locationId, applied: "ignored: this card is already saved" };
  }
  const at = typeof event.created === "number" && event.created > 0 ? new Date(event.created * 1000).toISOString() : new Date().toISOString();
  upsertLocation({
    ...location,
    stripe: {
      ...location.stripe,
      customerId: typeof session.customer === "string" ? session.customer : location.stripe?.customerId,
      setupIntentId,
      cardSavedAt: at,
      // A new card is looked up afresh at Go live.
      cardFingerprint: undefined,
    },
  });
  return { locationId, applied: "card saved" };
}

/** The saved card's fingerprint, looked up once and kept. Null when there is no card. */
export async function resolveCardFingerprint(location: Location): Promise<string | null> {
  if (location.stripe?.cardFingerprint) return location.stripe.cardFingerprint;
  const setupIntentId = location.stripe?.setupIntentId;
  if (!setupIntentId) return null;
  let fingerprint: string | null = null;
  if (flag("stubs")) {
    const { stubCardFingerprint } = await import("../testing/stubs");
    fingerprint = stubCardFingerprint(setupIntentId) ?? null;
  } else {
    const intent = await stripe().setupIntents.retrieve(setupIntentId, { expand: ["payment_method"] });
    const method = intent.payment_method;
    fingerprint = typeof method === "object" && method?.card?.fingerprint ? method.card.fingerprint : null;
  }
  if (fingerprint) {
    const fresh = getLocation(location.id) ?? location;
    upsertLocation({ ...fresh, stripe: { ...fresh.stripe, cardFingerprint: fingerprint } });
  }
  return fingerprint;
}

/**
 * The free month at Stripe: a subscription on the saved card whose trial ends
 * on `endsOn`, so the first invoice is the plan fee on day 31 and a cancel
 * before then charges nothing. Returns its id.
 */
export async function startTrialSubscription(location: Location, endsOn: string): Promise<string> {
  const products = productsOf(location.subscription);
  const market = subscriptionMarket(location.subscription);
  const cycle = location.subscription?.cycle ?? "monthly";
  const trialEnd = Math.floor(Date.parse(`${endsOn}T12:00:00Z`) / 1000);
  const meta = {
    belline_location: location.id,
    belline_tenant: location.tenantId,
    belline_purpose: TRIAL_PURPOSE,
    belline_products: products.join(","),
    belline_market: market,
    belline_cycle: cycle,
    belline_amount: String(periodFee(products, market, cycle)),
  };
  const customer = location.stripe?.customerId;
  if (!customer) throw new Error("No Stripe customer for the saved card.");

  if (flag("stubs")) {
    const { stubCreateSubscription } = await import("../testing/stubs");
    return stubCreateSubscription({
      customer,
      setupIntent: location.stripe?.setupIntentId,
      prices: products.map((p) => `price_stub_${p}_${market.toLowerCase()}_${cycle}`),
      trialEnd,
      firstInvoiceOn: endsOn,
      metadata: meta,
    }).id;
  }

  const s = stripe();
  const intent = location.stripe?.setupIntentId ? await s.setupIntents.retrieve(location.stripe.setupIntentId) : null;
  const paymentMethod = typeof intent?.payment_method === "string" ? intent.payment_method : intent?.payment_method?.id;
  const prices = await Promise.all(products.map((id) => priceFor(id, market, cycle)));
  const sub = await s.subscriptions.create({
    customer,
    items: prices.map((p) => ({ price: p.id })),
    ...(paymentMethod ? { default_payment_method: paymentMethod } : {}),
    trial_end: trialEnd,
    trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
    metadata: meta,
  });
  return sub.id;
}

/**
 * Stripe says the free month is over and the first invoice was paid: the venue
 * is on its plan. Null for any other event.
 */
export function applyTrialSubscriptionEvent(event: Stripe.Event): { locationId?: string; applied: string } | null {
  if (event.type !== "customer.subscription.updated") return null;
  const sub = event.data.object;
  if (sub.metadata?.belline_purpose !== TRIAL_PURPOSE) return null;
  const locationId = sub.metadata?.belline_location;
  const location = locationId ? getLocation(locationId) : undefined;
  if (!location?.subscription) return { locationId, applied: "ignored: unknown venue" };
  if (location.stripe?.trialSubscriptionId !== sub.id) return { locationId, applied: "ignored: not this venue's trial subscription" };
  if (sub.status !== "active" || location.subscription.status !== "trialing") return { locationId, applied: `ignored: ${sub.status}` };
  const today = dayIn(location.timezone, new Date());
  const stated = Number(sub.metadata?.belline_amount);
  upsertLocation({
    ...location,
    subscription: {
      ...location.subscription,
      status: "active",
      startedOn: today,
      trial: undefined,
      ...(Number.isInteger(stated) && stated > 0 ? { priceMinor: stated } : {}),
    },
    stripe: { ...location.stripe, subscriptionId: sub.id },
  });
  return { locationId, applied: "free month over, plan active" };
}

/** Cancel a Stripe subscription that a plan chosen later replaces. Never throws. */
export async function cancelReplacedSubscription(subscriptionId: string): Promise<void> {
  try {
    if (flag("stubs")) {
      const { stubCancelSubscription } = await import("../testing/stubs");
      stubCancelSubscription(subscriptionId);
      return;
    }
    await stripe().subscriptions.cancel(subscriptionId);
  } catch (err) {
    console.error(`[stripe] could not cancel the replaced trial subscription ${subscriptionId}:`, err);
  }
}

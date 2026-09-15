import Stripe from "stripe";
import type { Location, Subscription } from "../types";
import { getLocation, upsertLocation } from "../store";
import { MARKETS, marketOf, type Market } from "../markets";
import {
  GRANDFATHER_DAYS,
  checkPurchased,
  checkSelection,
  isProductId,
  periodFee,
  productById,
  type BillingCycle,
  type LegacyPlanId,
  type ProductId,
} from "./plans";
import { addDays, todayIn } from "../time";

/**
 * Taking money.
 *
 * Three decisions worth stating, because each rules out a worse version.
 *
 * **Stripe's hosted Checkout, not a form of ours.** It arrives with PCI scope
 * we do not want, 3D Secure, Apple Pay, Google Pay, local card rules and a
 * dozen languages. Building our own would be a worse page that also made us
 * responsible for card data.
 *
 * **Prices are created here, from `plans.ts`, not configured in a dashboard.**
 * One Stripe price per product, per market, per cycle, found again by a lookup
 * key that carries the amount — so changing a price in `plans.ts` creates a
 * new Stripe price and existing subscriptions keep the one they were sold.
 * A subscription is one of those prices.
 *
 * **Nothing believes a redirect.** A customer returning to a success URL
 * proves only that their browser followed a link. The subscription becomes
 * real when Stripe's webhook says so, signed.
 *
 * `STRIPE_SECRET_KEY` unset is a supported state, exactly like the speech and
 * telephony providers: the button says so rather than failing, and everything
 * else in the product works.
 */

let client: Stripe | null = null;

export function stripeEnabled(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

/**
 * Stripe Tax on checkout (§2.4: VAT and GST handled by Stripe, not baked into
 * prices). On by default; `STRIPE_TAX=off` exists only for an account whose
 * head-office address and tax registrations are not yet entered, where
 * Stripe refuses to open a session with tax switched on.
 */
export function stripeTaxEnabled(): boolean {
  return process.env.STRIPE_TAX !== "off";
}

export function stripe(): Stripe {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY is not set — Belline cannot take a payment.");
  }
  if (!client) {
    client = new Stripe(process.env.STRIPE_SECRET_KEY, {
      // Pinned to what this build of the SDK types against. An API version
      // that moves on its own is a breaking change arriving at a time nobody
      // chose.
      apiVersion: "2026-08-26.dahlia",
      appInfo: { name: "Belline", url: "https://belline.ai" },
      maxNetworkRetries: 2,
    });
  }
  return client;
}

/**
 * The lookup key a price is found by. Exported so the check can pin its shape.
 *
 * Never change this shape: every price already in Stripe was created under
 * it. A new catalogue gets new product ids, and so new keys, rather than a
 * new shape that could find — or miss — an old price.
 */
export function lookupKeyFor(id: ProductId, market: Market, cycle: BillingCycle): string {
  return `belline_${id}_${market.toLowerCase()}_${cycle}_${periodFee([id], market, cycle)}`;
}

/** The catalogue version(s) a selection belongs to, for Stripe metadata. */
export function catalogueOf(ids: readonly ProductId[]): string {
  return [...new Set(ids.map((id) => productById(id).version))].join(",");
}

/**
 * The product and price, created on first use and reused after.
 *
 * Looked up rather than stored, so this is idempotent across deploys,
 * environments and a wiped database.
 */
async function priceFor(id: ProductId, market: Market, cycle: BillingCycle): Promise<Stripe.Price> {
  const product = productById(id);
  const s = stripe();

  // Minor units. Stripe wants them, and this codebase has never let a float
  // near an invoice.
  const amount = periodFee([id], market, cycle);
  const lookupKey = lookupKeyFor(id, market, cycle);

  const existing = await s.prices.list({ lookup_keys: [lookupKey], limit: 1, active: true });
  if (existing.data[0]) return existing.data[0];

  const found = await s.products.search({ query: `metadata['belline_product']:'${id}'`, limit: 1 });
  const stripeProduct =
    found.data[0] ??
    (await s.products.create({
      name: `Belline ${product.name}`,
      description: product.summary,
      metadata: { belline_product: id, belline_catalogue: product.version },
    }));

  return s.prices.create({
    product: stripeProduct.id,
    currency: MARKETS[market].currency.toLowerCase(),
    unit_amount: amount,
    recurring: { interval: cycle === "annual" ? "year" : "month" },
    // Prices are shown before tax; Stripe Tax adds what the customer's
    // country requires.
    tax_behavior: "exclusive",
    lookup_key: lookupKey,
    metadata: { belline_product: id, belline_market: market, belline_cycle: cycle, belline_catalogue: product.version },
  });
}

export interface CheckoutInput {
  location: Location;
  products: ProductId[];
  market: Market;
  cycle: BillingCycle;
  email: string;
  /** Absolute, and ours — never taken from a query parameter. */
  successUrl: string;
  cancelUrl: string;
}

/** The session Stripe is asked to open. Pure, so the check can read it without a network. */
export function checkoutParams(
  input: CheckoutInput,
  priceIds: string[],
): Stripe.Checkout.SessionCreateParams {
  const meta = {
    belline_location: input.location.id,
    belline_tenant: input.location.tenantId,
    belline_products: input.products.join(","),
    belline_market: input.market,
    belline_cycle: input.cycle,
    // What the period was sold at, and under which catalogue. The webhook
    // stamps both on the subscription, so the fee shown later is this one.
    belline_amount: String(periodFee(input.products, input.market, input.cycle)),
    belline_catalogue: catalogueOf(input.products),
  };
  return {
    mode: "subscription",
    line_items: priceIds.map((price) => ({ price, quantity: 1 })),
    customer_email: input.email,
    client_reference_id: input.location.id,
    // The venue id rides as metadata *and* as the client reference, because
    // neither field is guaranteed to survive every event shape Stripe sends.
    metadata: meta,
    subscription_data: { metadata: meta },
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    allow_promotion_codes: true,
    automatic_tax: { enabled: stripeTaxEnabled() },
    // A business buying needs its tax number on the invoice, and Stripe Tax
    // needs an address to know which tax applies.
    tax_id_collection: { enabled: true },
    billing_address_collection: "required",
  };
}

/** Start a checkout for a selection the catalogue accepts. */
export async function createCheckout(input: CheckoutInput): Promise<{ url: string }> {
  const selection = checkSelection(input.products, input.market);
  if (!selection.ok) throw new Error(selection.error);
  const prices = await Promise.all(selection.products.map((id) => priceFor(id, input.market, input.cycle)));
  const session = await stripe().checkout.sessions.create(
    checkoutParams({ ...input, products: selection.products }, prices.map((p) => p.id)),
  );

  if (!session.url) throw new Error("Stripe returned a checkout session with no URL.");
  return { url: session.url };
}

/** The customer portal, for changing a card or cancelling without emailing us. */
export async function portalUrl(customerId: string, returnUrl: string): Promise<string> {
  const session = await stripe().billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
  return session.url;
}

// ---------------------------------------------------------------------------
// The webhook
// ---------------------------------------------------------------------------

export function verifyWebhook(raw: string, signature: string | null): Stripe.Event {
  // Two endpoints' secrets: the account's own events, and — for deposits —
  // events on venues' connected accounts, which Stripe signs separately.
  const secrets = [process.env.STRIPE_WEBHOOK_SECRET, process.env.STRIPE_CONNECT_WEBHOOK_SECRET].filter(
    (s): s is string => Boolean(s),
  );
  if (!secrets.length) throw new Error("STRIPE_WEBHOOK_SECRET is not set.");
  if (!signature) throw new Error("No Stripe signature on that request.");
  // Over the raw bytes, and Stripe's own constructEvent so the timestamp
  // tolerance that stops a replay is applied too.
  let last: unknown;
  for (const secret of secrets) {
    try {
      return stripe().webhooks.constructEvent(raw, signature, secret);
    } catch (err) {
      last = err;
    }
  }
  throw last instanceof Error ? last : new Error("Signature did not verify.");
}

const LEGACY = new Set<string>(["starter", "business", "enterprise"]);

/**
 * What a Stripe event means for a venue's plan.
 *
 * Deliberately small. Belline stores what it needs to decide whether to answer
 * and what to show on the billing page — not a mirror of Stripe's data model.
 */
export function applyStripeEvent(event: Stripe.Event): { locationId?: string; applied: string } {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      // A guest's deposit is not a venue's plan. See billing/deposits.ts.
      if (session.mode === "payment" || session.metadata?.belline_booking) {
        return { applied: "ignored: a deposit, not a subscription" };
      }
      const locationId =
        session.metadata?.belline_location ?? session.client_reference_id ?? undefined;
      if (!locationId) return { applied: "ignored: no venue on the session" };

      const location = getLocation(locationId);
      if (!location) return { locationId, applied: "ignored: unknown venue" };

      const market = marketOf(session.metadata?.belline_market);
      const cycle: BillingCycle = session.metadata?.belline_cycle === "annual" ? "annual" : "monthly";
      const today = todayIn(location.timezone);
      let next: Subscription;

      const legacy = session.metadata?.belline_plan;
      if (!session.metadata?.belline_products && legacy && LEGACY.has(legacy)) {
        // A checkout opened on the old ladder before this catalogue shipped
        // and paid after. They bought that plan, so they get it, grandfathered
        // like everybody else who did.
        next = {
          planId: legacy as LegacyPlanId,
          cycle,
          startedOn: today,
          status: "active",
          grandfatheredUntil: addDays(today, GRANDFATHER_DAYS),
          priceMinor: periodFee([legacy as LegacyPlanId], "AE", cycle),
          catalogueVersion: productById(legacy as LegacyPlanId).version,
        };
      } else {
        const raw = (session.metadata?.belline_products ?? "").split(",");
        const ids = raw.filter(isProductId);
        // Something we sell now, or a September 2026 bundle whose checkout was
        // opened before 2026-10 shipped and paid after: they bought it, so
        // they get it, as sold. Refused rather than guessed otherwise — a
        // session whose products do not form a valid purchase was not opened
        // by us.
        const selection = ids.length === raw.length ? checkPurchased(ids, market) : checkSelection([], market);
        if (!selection.ok) return { locationId, applied: "ignored: no valid products on the session" };
        const stated = Number(session.metadata?.belline_amount);
        const priceMinor =
          Number.isInteger(stated) && stated > 0 ? stated : periodFee(selection.products, market, cycle);
        // The anniversary is today. `periodFor` remembers the anchor day
        // rather than clamping it, so a 31st stays a 31st.
        next = {
          products: selection.products,
          market,
          cycle,
          startedOn: today,
          status: "active",
          priceMinor,
          catalogueVersion: session.metadata?.belline_catalogue || catalogueOf(selection.products),
        };
      }

      upsertLocation({
        ...location,
        subscription: next,
        // Kept when an event omits them: a session with no ids must not erase
        // the customer the portal and the free-chat guard depend on.
        stripe: {
          customerId: typeof session.customer === "string" ? session.customer : location.stripe?.customerId,
          subscriptionId:
            typeof session.subscription === "string" ? session.subscription : location.stripe?.subscriptionId,
        },
      });
      return { locationId, applied: "subscription active" };
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object;
      const locationId = subscription.metadata?.belline_location;
      if (!locationId) return { applied: "ignored: no venue on the subscription" };
      const location = getLocation(locationId);
      if (!location?.subscription) return { locationId, applied: "ignored: unknown venue" };

      upsertLocation({
        ...location,
        subscription: {
          ...location.subscription,
          status: "cancelled",
          cancelledAt: new Date().toISOString(),
        },
      });
      return { locationId, applied: "subscription cancelled" };
    }

    case "invoice.payment_failed": {
      // Not a cancellation. Stripe retries for a fortnight, and switching a
      // venue's receptionist off over one declined card would do more damage
      // than the unpaid invoice. Recorded, and the dashboard says so.
      const invoice = event.data.object;
      const locationId =
        typeof invoice.parent?.subscription_details?.metadata?.belline_location === "string"
          ? invoice.parent.subscription_details.metadata.belline_location
          : undefined;
      if (!locationId) return { applied: "ignored: no venue on the invoice" };
      const location = getLocation(locationId);
      if (!location?.subscription) return { locationId, applied: "ignored: unknown venue" };
      upsertLocation({
        ...location,
        subscription: { ...location.subscription, paymentFailedAt: new Date().toISOString() },
      });
      return { locationId, applied: "payment failed, recorded" };
    }

    default:
      return { applied: `ignored: ${event.type}` };
  }
}

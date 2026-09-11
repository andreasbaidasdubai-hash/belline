import Stripe from "stripe";
import type { Location, Subscription } from "../types";
import { getLocation, upsertLocation } from "../store";
import { PLANS, periodFee, planById, type BillingCycle, type PlanId } from "./plans";
import { todayIn } from "../time";

/** Every plan is priced in dirhams; see plans.ts for why that is not converted. */
const CURRENCY = "aed";

/**
 * Taking money.
 *
 * The last hole in the funnel. Signup creates an account on a fortnight's
 * trial; without this, the fortnight ends and nothing happens — no card, no
 * invoice, no way to become a customer.
 *
 * Three decisions worth stating, because each rules out a worse version.
 *
 * **Stripe's hosted Checkout, not a form of ours.** The brief asks for a
 * checkout page showing a logo, a plan, a price, what is included and a
 * payment field. That is precisely what Stripe Checkout is, and it arrives
 * with PCI scope we do not want, 3D Secure, Apple Pay, Google Pay, local card
 * rules and a dozen languages. Building our own would be a worse page that
 * also made us responsible for card data.
 *
 * **Prices are created here, from `plans.ts`, not configured in a dashboard.**
 * A price that lives in the Stripe dashboard is a second source of truth for
 * what Belline costs, and the two drift. The pricing page, the invoice and the
 * dashboard all read the same array; Stripe is told about it, rather than
 * asked.
 *
 * **Nothing believes a redirect.** A customer returning to a success URL
 * proves only that their browser followed a link. The subscription becomes
 * real when Stripe's webhook says so, signed — which is also what makes it
 * survive somebody closing the tab on the payment screen.
 *
 * `STRIPE_SECRET_KEY` unset is a supported state, exactly like the speech and
 * telephony providers: the button says so rather than failing, and everything
 * else in the product works.
 */

let client: Stripe | null = null;

export function stripeEnabled(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

function stripe(): Stripe {
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
 * The product and prices, created on first use and reused after.
 *
 * Looked up by a stable lookup key rather than an id we would have to store,
 * so this is idempotent across deploys, environments and a wiped database.
 * Changing a price in `plans.ts` creates a new Stripe price; existing
 * subscriptions keep the one they were sold, which is both what Stripe does
 * and what a customer would expect.
 */
async function priceFor(planId: PlanId, cycle: BillingCycle): Promise<Stripe.Price> {
  const plan = planById(planId);
  const s = stripe();

  // Fils, not dirhams. Stripe wants the minor unit, and this codebase has
  // never let a float near an invoice.
  const amount = periodFee(plan, cycle);
  const lookupKey = `belline_${planId}_${cycle}_${amount}`;

  const existing = await s.prices.list({ lookup_keys: [lookupKey], limit: 1, active: true });
  if (existing.data[0]) return existing.data[0];

  const products = await s.products.search({
    query: `metadata['belline_plan']:'${planId}'`,
    limit: 1,
  });
  const product =
    products.data[0] ??
    (await s.products.create({
      name: `Belline ${plan.name}`,
      description: plan.summary,
      metadata: { belline_plan: planId },
    }));

  return s.prices.create({
    product: product.id,
    currency: CURRENCY,
    unit_amount: amount,
    recurring: { interval: cycle === "annual" ? "year" : "month" },
    lookup_key: lookupKey,
    metadata: { belline_plan: planId, belline_cycle: cycle },
  });
}

export interface CheckoutInput {
  location: Location;
  planId: PlanId;
  cycle: BillingCycle;
  email: string;
  /** Absolute, and ours — never taken from a query parameter. */
  successUrl: string;
  cancelUrl: string;
}

/**
 * Start a checkout.
 *
 * The venue id rides on the session as metadata *and* as the client reference,
 * because the webhook has to know which diary just got paid for and neither
 * field is guaranteed to survive every event shape Stripe sends.
 */
export async function createCheckout(input: CheckoutInput): Promise<{ url: string }> {
  const price = await priceFor(input.planId, input.cycle);
  const s = stripe();

  const session = await s.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: price.id, quantity: 1 }],
    customer_email: input.email,
    client_reference_id: input.location.id,
    // Belline is sold per venue: a second branch is a second line, a second
    // diary and a second set of rules. The metadata is what the webhook uses
    // to find the right one.
    metadata: {
      belline_location: input.location.id,
      belline_tenant: input.location.tenantId,
      belline_plan: input.planId,
      belline_cycle: input.cycle,
    },
    subscription_data: {
      metadata: {
        belline_location: input.location.id,
        belline_tenant: input.location.tenantId,
      },
    },
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    allow_promotion_codes: true,
    // A UAE business buying in dirhams needs a TRN on the invoice.
    tax_id_collection: { enabled: true },
    billing_address_collection: "auto",
  });

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
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not set.");
  if (!signature) throw new Error("No Stripe signature on that request.");
  // Over the raw bytes, and Stripe's own constructEvent so the timestamp
  // tolerance that stops a replay is applied too.
  return stripe().webhooks.constructEvent(raw, signature, secret);
}

/**
 * What a Stripe event means for a venue's plan.
 *
 * Deliberately small. Belline stores what it needs to decide whether to answer
 * the telephone and what to show on the billing page — not a mirror of
 * Stripe's data model, which would be a second source of truth for something
 * Stripe is already authoritative about.
 */
export function applyStripeEvent(event: Stripe.Event): { locationId?: string; applied: string } {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const locationId =
        session.metadata?.belline_location ?? session.client_reference_id ?? undefined;
      const planId = (session.metadata?.belline_plan ?? PLANS[0].id) as PlanId;
      const cycle = (session.metadata?.belline_cycle ?? "monthly") as BillingCycle;
      if (!locationId) return { applied: "ignored: no venue on the session" };

      const location = getLocation(locationId);
      if (!location) return { locationId, applied: "ignored: unknown venue" };

      const next: Subscription = {
        planId,
        cycle,
        // The anniversary is today. `periodFor` remembers the anchor day
        // rather than clamping it, so a 31st stays a 31st.
        startedOn: todayIn(location.timezone),
        status: "active",
      };

      upsertLocation({
        ...location,
        subscription: next,
        stripe: {
          customerId: typeof session.customer === "string" ? session.customer : undefined,
          subscriptionId:
            typeof session.subscription === "string" ? session.subscription : undefined,
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
      return { locationId, applied: "payment failed, noted" };
    }

    default:
      return { applied: `ignored: ${event.type}` };
  }
}

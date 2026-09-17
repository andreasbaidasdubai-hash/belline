import type Stripe from "stripe";
import { getLocation, recordStripeEvent, stripeEventSeen, upsertLocation } from "../store";
import { applyCardEvent, applyTrialSubscriptionEvent, cancelReplacedSubscription } from "./card";
import { applyDepositEvent } from "./deposits";
import { applyStripeEvent, verifyWebhook } from "./stripe";

/**
 * The Stripe webhook, without the request.
 *
 * Three rules, each one a bug it replaces:
 *
 * **An event is applied once.** Stripe redelivers anything it is not sure
 * arrived. Its id is recorded after it is applied, and a second delivery is
 * acknowledged without being applied again. `applyStripeEvent` is also safe to
 * repeat on its own, for when that record is lost.
 *
 * **A failure is not acknowledged.** A handler that throws returns 500, and
 * the id is not recorded, so Stripe tries again. Acknowledging a failure used
 * to mean a paid checkout that never became a subscription, and nothing left
 * to retry it.
 *
 * **Only a bad signature is a 400.** It was never Stripe's.
 */

export interface WebhookOutcome {
  status: 200 | 400 | 500;
  /** For the log line. Never sent to Stripe beyond a word. */
  applied: string;
  locationId?: string;
}

type Apply = (event: Stripe.Event) => { locationId?: string; applied: string };

const defaultApply: Apply = (event) =>
  applyDepositEvent(event) ?? applyCardEvent(event) ?? applyTrialSubscriptionEvent(event) ?? replacingTrial(event, applyStripeEvent);

/**
 * A plan chosen after Go live replaces the free month's Stripe subscription
 * (billing/card.ts): once the new one is active, the old one is cancelled so
 * the card is never charged twice.
 */
function replacingTrial(event: Stripe.Event, apply: Apply): { locationId?: string; applied: string } {
  const session = event.type === "checkout.session.completed" ? event.data.object : null;
  const before = session?.metadata?.belline_location ? getLocation(session.metadata.belline_location) : undefined;
  const trial = before?.stripe?.trialSubscriptionId;
  const out = apply(event);
  if (!session || !out.locationId) return out;
  const venue = getLocation(out.locationId);
  if (!venue || !trial || venue.subscription?.status !== "active" || venue.stripe?.subscriptionId === trial) return out;
  upsertLocation({ ...venue, stripe: { ...venue.stripe, trialSubscriptionId: undefined } });
  void cancelReplacedSubscription(trial);
  return { ...out, applied: `${out.applied}; free-month subscription cancelled` };
}

/** Failures per event id in this process, so a stuck event is raised once rather than on every retry. */
const failures = new Map<string, number>();
const RAISE_AFTER = 3;

export function webhookConfigured(): boolean {
  return Boolean(process.env.STRIPE_WEBHOOK_SECRET || process.env.STRIPE_CONNECT_WEBHOOK_SECRET);
}

export function handleStripeWebhook(raw: string, signature: string | null, apply: Apply = defaultApply): WebhookOutcome {
  // Not configured is not an error worth retrying.
  if (!webhookConfigured()) return { status: 200, applied: "ignored: Stripe webhooks are not configured" };

  let event: Stripe.Event;
  try {
    event = verifyWebhook(raw, signature);
  } catch (err) {
    console.warn("[stripe] rejected:", (err as Error).message);
    return { status: 400, applied: "rejected: bad signature" };
  }

  const seen = stripeEventSeen(event.id);
  if (seen) return { status: 200, applied: `ignored: already applied (${seen.applied})` };

  let result: { locationId?: string; applied: string };
  try {
    result = apply(event);
  } catch (err) {
    const n = (failures.get(event.id) ?? 0) + 1;
    failures.set(event.id, n);
    console.error(`[stripe] ${event.type} ${event.id} failed (attempt ${n}):`, err);
    // The log key the exception queue watches for; once, not on every retry.
    if (n === RAISE_AFTER) console.error(`[exception] webhook_failures stripe:${event.id}: ${event.type} failed ${n} times`);
    return { status: 500, applied: "failed" };
  }

  failures.delete(event.id);
  recordStripeEvent({
    id: event.id,
    type: event.type,
    ...(typeof event.created === "number" ? { createdAt: new Date(event.created * 1000).toISOString() } : {}),
    appliedAt: new Date().toISOString(),
    applied: result.applied,
  });
  return { status: 200, ...result };
}

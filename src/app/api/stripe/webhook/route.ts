import { NextResponse } from "next/server";
import { applyStripeEvent, stripeEnabled, verifyWebhook } from "@/lib/billing/stripe";
import { seedIfEmpty } from "@/lib/seed";
import { applyDepositEvent } from "@/lib/billing/deposits";

export const dynamic = "force-dynamic";

/**
 * What Stripe says actually happened.
 *
 * The subscription becomes real here, not on the success page. A customer
 * returning to a success URL proves only that a browser followed a link —
 * they may have closed the tab on the payment screen, the card may have needed
 * a second authentication, the redirect may never have happened at all. Every
 * one of those is a customer who has paid and, without this route, would not
 * have a subscription.
 *
 * Same discipline as the WhatsApp webhook: verify against the raw bytes,
 * return 200 fast, and never 500 at a provider that will simply send it again.
 */
export async function POST(req: Request) {
  if (!stripeEnabled() || !(process.env.STRIPE_WEBHOOK_SECRET || process.env.STRIPE_CONNECT_WEBHOOK_SECRET)) {
    // Not configured is not an error worth retrying.
    console.warn("[stripe] webhook arrived but Stripe is not configured");
    return new NextResponse(null, { status: 200 });
  }

  const raw = await req.text();

  let event;
  try {
    event = verifyWebhook(raw, req.headers.get("stripe-signature"));
  } catch (err) {
    // The one genuine rejection. An unsigned request is not an event we failed
    // to handle — it is one that was never Stripe's.
    console.warn("[stripe] rejected:", (err as Error).message);
    return new NextResponse("bad signature", { status: 400 });
  }

  seedIfEmpty();

  try {
    const result = applyDepositEvent(event) ?? applyStripeEvent(event);
    console.log(
      `[stripe] ${event.type}${result.locationId ? ` ${result.locationId}` : ""} — ${result.applied}`,
    );
  } catch (err) {
    // Logged and acknowledged. A retry will not fix a bug in our handler, and
    // Stripe retrying for three days makes the log harder to read, not the
    // subscription more correct.
    console.error(`[stripe] ${event.type} failed:`, err);
  }

  return new NextResponse(null, { status: 200 });
}

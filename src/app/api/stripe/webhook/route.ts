import { NextResponse } from "next/server";
import { handleStripeWebhook } from "@/lib/billing/webhook";
import { seedIfEmpty } from "@/lib/seed";

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
 * Verify against the raw bytes, apply each event once, and return 500 when
 * applying it failed so Stripe sends it again. See billing/webhook.ts.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  seedIfEmpty();
  const out = handleStripeWebhook(raw, req.headers.get("stripe-signature"));
  console.log(`[stripe] ${out.status}${out.locationId ? ` ${out.locationId}` : ""} — ${out.applied}`);
  if (out.status === 400) return new NextResponse("bad signature", { status: 400 });
  if (out.status === 500) return new NextResponse("not applied", { status: 500 });
  return new NextResponse(null, { status: 200 });
}

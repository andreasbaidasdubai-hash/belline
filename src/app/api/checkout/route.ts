import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { canManageUsers } from "@/lib/auth";
import { listLocationsFor } from "@/lib/store";
import { createCheckout, stripeEnabled } from "@/lib/billing/stripe";
import { LEGACY_TO_BUNDLE, checkSelection, type BillingCycle } from "@/lib/billing/plans";
import { subscriptionMarket } from "@/lib/billing/usage";
import { appOrigin } from "@/lib/origin";
import { flag } from "@/lib/flags";

export const dynamic = "force-dynamic";

/**
 * Choose a plan.
 *
 * The one place a card is asked for — never at signup (the trial stays
 * card-free). Returns a URL for the browser to follow rather than
 * redirecting, so a failure is a message on the page the customer is already
 * looking at.
 *
 * The return URLs are built from the request's own origin and never taken
 * from the body. A `successUrl` a caller can set is an open redirect, on the
 * page that says "you have paid".
 */
export async function POST(req: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const user = auth.user;

  // Money is a manager's concern, the same rule the billing page already uses.
  if (!canManageUsers(user)) {
    return NextResponse.json({ error: "Only an owner can do that." }, { status: 403 });
  }

  if (!stripeEnabled()) {
    // The page does not offer the button while payments are closed; this is
    // for anything that calls the route anyway.
    return NextResponse.json({ error: "Payments open soon. Belline keeps answering until then." }, { status: 503 });
  }

  let body: { products?: unknown; bundle?: unknown; planId?: unknown; cycle?: unknown; locationId?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }

  const venues = listLocationsFor(user.tenantId);
  const location =
    typeof body.locationId === "string" ? venues.find((l) => l.id === body.locationId) : venues[0];
  if (!location) {
    return NextResponse.json({ error: "No venue to subscribe." }, { status: 404 });
  }

  // Prices are the venue's market's, never the request's.
  const market = subscriptionMarket(location.subscription);
  const raw = Array.isArray(body.products)
    ? body.products
    : typeof body.bundle === "string"
      ? [body.bundle]
      : typeof body.planId === "string" && body.planId in LEGACY_TO_BUNDLE
        ? [LEGACY_TO_BUNDLE[body.planId as keyof typeof LEGACY_TO_BUNDLE]]
        : [];
  const selection = checkSelection(raw, market);
  if (!selection.ok) {
    return NextResponse.json({ error: selection.error }, { status: 400 });
  }
  const cycle: BillingCycle = body.cycle === "annual" ? "annual" : "monthly";

  // Where Stripe sends them back. Never the request's origin: behind the proxy
  // that is localhost, and a customer who has just paid would land there.
  // A stubbed local run comes back to this machine, never to the real app.
  const origin = flag("stubs") ? `http://localhost:${process.env.PORT ?? 3000}` : appOrigin();

  try {
    const { url } = await createCheckout({
      location,
      products: selection.products,
      market,
      cycle,
      email: user.email,
      successUrl: `${origin}/billing?paid=1`,
      cancelUrl: `${origin}/checkout?cancelled=1`,
    });
    return NextResponse.json({ ok: true, url });
  } catch (err) {
    console.error("[checkout]", err);
    return NextResponse.json({ error: "Could not open checkout. Try again in a moment." }, { status: 502 });
  }
}

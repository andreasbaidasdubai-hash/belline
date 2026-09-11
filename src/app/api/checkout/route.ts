import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { canManageUsers } from "@/lib/auth";
import { listLocationsFor } from "@/lib/store";
import { createCheckout, stripeEnabled } from "@/lib/billing/stripe";
import { PLANS, type BillingCycle, type PlanId } from "@/lib/billing/plans";

export const dynamic = "force-dynamic";

/**
 * Start a checkout.
 *
 * Returns a URL for the browser to follow rather than redirecting, so a failure
 * is a message on the page the customer is already looking at instead of a
 * redirect to a Stripe error they cannot read.
 *
 * The return URLs are built here from the request's own origin and never taken
 * from the request body. A `successUrl` a caller can set is an open redirect,
 * and an open redirect on the page that says "you have paid" is a good day for
 * somebody phishing our customers.
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
    return NextResponse.json(
      {
        error:
          "Card payments are not switched on yet. Email hello@belline.ai and we will set it up with you.",
      },
      { status: 503 },
    );
  }

  let body: { planId?: string; cycle?: string; locationId?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }

  const planId = (PLANS.find((p) => p.id === body.planId)?.id ?? PLANS[0].id) as PlanId;
  const cycle: BillingCycle = body.cycle === "annual" ? "annual" : "monthly";

  const venues = listLocationsFor(user.tenantId);
  const location = body.locationId
    ? venues.find((l) => l.id === body.locationId)
    : venues[0];

  if (!location) {
    return NextResponse.json({ error: "No venue to subscribe." }, { status: 404 });
  }

  const origin = new URL(req.url).origin;

  try {
    const { url } = await createCheckout({
      location,
      planId,
      cycle,
      email: user.email,
      successUrl: `${origin}/billing?paid=1`,
      cancelUrl: `${origin}/checkout?cancelled=1`,
    });
    return NextResponse.json({ ok: true, url });
  } catch (err) {
    console.error("[checkout]", err);
    return NextResponse.json(
      { error: "Could not open checkout. Try again in a moment." },
      { status: 502 },
    );
  }
}

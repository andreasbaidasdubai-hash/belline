import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { canManageUsers } from "@/lib/auth";
import { listLocationsFor } from "@/lib/store";
import { portalUrl, stripeEnabled } from "@/lib/billing/stripe";

export const dynamic = "force-dynamic";

/**
 * A link into Stripe's customer portal — card, invoices, cancellation.
 *
 * Same shape as checkout: returns a URL for the browser to follow, built from
 * the request's own origin rather than the body, so a failure is a message on
 * the page rather than a redirect to somewhere unreadable, and nothing here is
 * an open redirect.
 */
export async function POST(req: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!canManageUsers(auth.user)) {
    return NextResponse.json({ error: "Only an owner can do that." }, { status: 403 });
  }
  if (!stripeEnabled()) {
    return NextResponse.json({ error: "Card payments are not switched on yet." }, { status: 503 });
  }

  let body: { locationId?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }

  // Only a venue of the caller's own tenant, and only one Stripe knows.
  const venues = listLocationsFor(auth.user.tenantId);
  const location = body.locationId ? venues.find((l) => l.id === body.locationId) : venues[0];
  const customerId = location?.stripe?.customerId;
  if (!location || !customerId) {
    return NextResponse.json({ error: "Nothing to manage yet." }, { status: 404 });
  }

  try {
    const url = await portalUrl(customerId, `${new URL(req.url).origin}/billing`);
    return NextResponse.json({ ok: true, url });
  } catch (err) {
    console.error("[billing portal]", err);
    return NextResponse.json({ error: "Could not open billing. Try again in a moment." }, { status: 502 });
  }
}

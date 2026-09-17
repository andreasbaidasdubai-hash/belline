import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth-server";
import { canManageUsers } from "@/lib/auth";
import { listLocationsFor } from "@/lib/store";
import { stripeEnabled } from "@/lib/billing/stripe";
import { createCardSetup } from "@/lib/billing/card";
import { appOrigin } from "@/lib/origin";
import { flag } from "@/lib/flags";
import { verifyRefusal } from "@/lib/abuse/gate";

export const dynamic = "force-dynamic";

/**
 * The card at Go live: open Stripe's page to save a card, charging nothing.
 *
 *   GET /api/billing/card?locationId=   → 303 to Stripe, back to /setup/golive
 *   POST { locationId? }                → { url } for a button to follow
 *
 * A link as well as an API, because the Go live step shows it as the "fix"
 * beside the refusal. Only with card payments open, only for an owner, only
 * for a venue of their own. The card becomes real when Stripe's signed webhook
 * says so (billing/card.ts), never because the browser came back.
 */

async function open(locationId: string | null): Promise<{ url?: string; error?: string; status: number }> {
  const user = await currentUser();
  if (!user) return { status: 401, error: "Not signed in." };
  if (!canManageUsers(user)) return { status: 403, error: "Only an owner can do that." };
  const held = verifyRefusal(user);
  if (held) return { status: held.status, error: held.error };
  if (!stripeEnabled()) return { status: 503, error: "Payments open soon. Belline does not need a card until then." };

  const venues = listLocationsFor(user.tenantId);
  const location = locationId ? venues.find((l) => l.id === locationId) : venues[0];
  if (!location) return { status: 404, error: "No venue to go live." };

  // Never the request's origin: behind the proxy that is localhost. A stubbed
  // local run comes back to this machine, never to the real app.
  const origin = flag("stubs") ? `http://localhost:${process.env.PORT ?? 3000}` : appOrigin();
  try {
    const { url } = await createCardSetup({
      location,
      email: user.email,
      successUrl: `${origin}/setup/golive?card=saved`,
      cancelUrl: `${origin}/setup/golive?card=cancelled`,
    });
    return { status: 200, url };
  } catch (err) {
    console.error("[billing card]", err);
    return { status: 502, error: "Could not open the card page. Try again in a moment." };
  }
}

export async function GET(req: Request) {
  const out = await open(new URL(req.url).searchParams.get("locationId"));
  if (out.url) return NextResponse.redirect(out.url, 303);
  return NextResponse.json({ error: out.error }, { status: out.status });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { locationId?: unknown };
  const out = await open(typeof body.locationId === "string" ? body.locationId : null);
  if (out.url) return NextResponse.json({ ok: true, url: out.url });
  return NextResponse.json({ error: out.error }, { status: out.status });
}

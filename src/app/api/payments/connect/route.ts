import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { canEditAgent } from "@/lib/auth";
import { getLocation } from "@/lib/store";
import { stripeEnabled } from "@/lib/billing/stripe";
import { connectOnboardingUrl } from "@/lib/billing/deposits";

export const dynamic = "force-dynamic";

/**
 * Send an owner to Stripe to set up deposits.
 *
 * A link from the Integrations page. Stripe runs the identity checks and the
 * bank details on its own pages and sends them back to the same page, which
 * then asks Stripe whether cards can be taken yet.
 */
export async function GET(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const url = new URL(request.url);
  const location = getLocation(url.searchParams.get("locationId") ?? "");
  if (!location || !canEditAgent(auth.user, location.id)) {
    return NextResponse.json({ error: "Not your venue." }, { status: 403 });
  }

  const origin = (process.env.PUBLIC_ORIGIN || url.origin).replace(/\/$/, "");
  const back = `${origin}/integrations?loc=${encodeURIComponent(location.id)}&payments=1`;

  if (!stripeEnabled()) {
    return NextResponse.redirect(`${back}&error=${encodeURIComponent("Card payments are not switched on yet.")}`);
  }
  try {
    return NextResponse.redirect(await connectOnboardingUrl(location, back));
  } catch (err) {
    console.error("[payments] connect failed:", err);
    return NextResponse.redirect(
      `${back}&error=${encodeURIComponent("Stripe could not start the setup just now. Try again in a minute.")}`,
    );
  }
}

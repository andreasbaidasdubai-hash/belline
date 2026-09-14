import Brand from "@/components/Brand";
import { currentUser } from "@/lib/auth-server";
import { listLocationsFor } from "@/lib/store";
import { seedIfEmpty } from "@/lib/seed";
import { LEGACY_TO_BUNDLE, checkSelection, sellable, type BillingCycle } from "@/lib/billing/plans";
import { productsOf, subscriptionMarket } from "@/lib/billing/usage";
import { MARKETS, marketOf } from "@/lib/markets";
import { stripeEnabled } from "@/lib/billing/stripe";
import Order from "./Order";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Get Belline",
  description: "Belline, your AI receptionist. Fourteen days free, no card, cancel anytime.",
};

/**
 * The checkout. Where "Get Belline" lands.
 *
 * One page: the order on the left — the plan, the price, what is
 * included, what is due — and the four fields it takes to own it on the
 * right. No navigation, no footer, no second offer: a page whose only job is
 * to be agreed with should not contain a way to wander off.
 *
 * Public, deliberately. Asking somebody to create an account *before* showing
 * them the price is the single most common way a low-ticket SaaS funnel leaks.
 * Signed out, it starts a card-free trial; signed in, it is where a plan is
 * chosen and the card is taken.
 *
 * Prices are in the venue's market. Signed out, a `?market=` is honoured only
 * for a market that is open — a derived price for a country we cannot serve
 * yet is not one to show anybody.
 */
export default async function CheckoutPage({
  searchParams,
}: {
  searchParams: Promise<{
    products?: string;
    bundle?: string;
    plan?: string;
    cycle?: string;
    market?: string;
    cancelled?: string;
  }>;
}) {
  seedIfEmpty();
  const params = await searchParams;
  const user = await currentUser();
  const venue = user ? listLocationsFor(user.tenantId)[0] : undefined;

  const asked = marketOf(params.market);
  const market = venue
    ? subscriptionMarket(venue.subscription)
    : MARKETS[asked].status === "live"
      ? asked
      : "AE";

  // Old links still say ?plan=starter. They land on the bundle that replaced it.
  const legacy = params.plan && params.plan in LEGACY_TO_BUNDLE ? LEGACY_TO_BUNDLE[params.plan as keyof typeof LEGACY_TO_BUNDLE] : null;
  const raw = params.products?.split(",") ?? (params.bundle ? [params.bundle] : legacy ? [legacy] : []);
  const picked = checkSelection(raw, market);
  const current = checkSelection(productsOf(venue?.subscription), market);
  const recommended = sellable(market).find((p) => p.recommended)?.id ?? "everything_business";
  const initial = picked.ok ? picked.products : current.ok ? current.products : [recommended];

  const cycle: BillingCycle = params.cycle === "annual" ? "annual" : "monthly";

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)" }}>
      <main className="checkout">
        <div style={{ gridArea: "brand", marginBottom: 30 }}>
          <a href="https://belline.ai" style={{ textDecoration: "none" }}>
            <Brand size={28} />
          </a>
        </div>
        <Order
          market={market}
          initial={initial}
          initialCycle={cycle}
          signedIn={Boolean(user)}
          venueName={venue?.name ?? "your venue"}
          stripe={stripeEnabled()}
          cancelled={Boolean(params.cancelled)}
        />
      </main>
    </div>
  );
}

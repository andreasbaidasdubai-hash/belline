import Brand from "@/components/Brand";
import { currentUser } from "@/lib/auth-server";
import { listLocationsFor } from "@/lib/store";
import { seedIfEmpty } from "@/lib/seed";
import { LEGACY_TO_BUNDLE, TRIAL, checkSelection, recommendedPlan, type BillingCycle } from "@/lib/billing/plans";
import { productsOf, subscriptionMarket } from "@/lib/billing/usage";
import { MARKETS, liveMarkets, marketOf } from "@/lib/markets";
import { tradeFromParam } from "@/lib/signup-rules";
import { stripeEnabled } from "@/lib/billing/stripe";
import { paymentsSoonSentence } from "@/lib/billing/trial-end";
import { siteOrigin } from "@/lib/origin";
import Order from "./Order";
import { cycleFromParam } from "./order-state";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Get Belline",
  description: `Belline, your AI receptionist. ${TRIAL.days} days free, no card, cancel anytime.`,
};

/**
 * The checkout. Where "Get Belline" lands.
 *
 * One page: the order on the left — the plan, the price, what is
 * included, what is due — and the account fields on the right, with the steps
 * that follow them (confirm the email, add the business, test Belle, go live). No navigation, no footer, no second offer: a page whose only job is
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
    trade?: string;
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

  // Old links still say ?plan=starter or ?products=everything_business. They
  // land on the 2026-10 plan that replaced it.
  const upgradeId = (id: string) => (id in LEGACY_TO_BUNDLE ? LEGACY_TO_BUNDLE[id as keyof typeof LEGACY_TO_BUNDLE] : id);
  const legacy = params.plan ? upgradeId(params.plan) : null;
  const raw = (params.products?.split(",") ?? (params.bundle ? [params.bundle] : legacy ? [legacy] : [])).map(upgradeId);
  const picked = checkSelection(raw, market);
  const current = checkSelection(productsOf(venue?.subscription), market);
  const recommended = recommendedPlan(market).id;
  const initial = picked.ok ? picked.products : current.ok ? current.products : [recommended];

  const cycle: BillingCycle = cycleFromParam(params.cycle);
  const site = siteOrigin();

  // A campaign link can say who it is for — /checkout?trade=dentist. Anything
  // we do not recognise selects nothing, rather than guessing at their trade.
  const trade = tradeFromParam(params.trade);

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)" }}>
      <main className="checkout">
        <div style={{ gridArea: "brand", marginBottom: 30 }}>
          <a href={site} style={{ textDecoration: "none" }}>
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
          coveredNote={paymentsSoonSentence(venue)}
          cancelled={Boolean(params.cancelled)}
          markets={liveMarkets()}
          trade={trade}
          siteOrigin={site}
        />
      </main>
    </div>
  );
}

import Brand from "@/components/Brand";
import { currentUser } from "@/lib/auth-server";
import { listLocationsFor } from "@/lib/store";
import { seedIfEmpty } from "@/lib/seed";
import { PLANS, periodFee, FILS, annualPerMonth, type BillingCycle } from "@/lib/billing/plans";
import { stripeEnabled } from "@/lib/billing/stripe";
import CheckoutForm from "./CheckoutForm";
import PayButton from "./PayButton";
import PlanSwitch from "./PlanSwitch";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Get Belline",
  description: "Belline, your AI receptionist. Fourteen days free, cancel anytime.",
};

/**
 * The checkout. Where "Get Belline" lands.
 *
 * It used to land on a signup form with no price on it, and the checkout was a
 * separate page behind a login that a visitor never saw. That is a signup
 * flow wearing a purchase's clothes: somebody who has decided to buy is shown
 * a form about themselves instead of the thing they are buying.
 *
 * So they are one page now. The order on the left — plan, price, what is
 * included, what is due — and the four fields it takes to own it on the right.
 * No navigation, no footer, no second offer: a page whose only job is to be
 * agreed with should not contain a way to wander off.
 *
 * Public, deliberately. Asking somebody to create an account *before* showing
 * them the price is the single most common way a low-ticket SaaS funnel leaks,
 * and it is the thing the audit found.
 *
 * Signed in already — arriving from the end of setup, or from the billing page
 * — they get the same order without the fields.
 */
export default async function CheckoutPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string; cycle?: string; cancelled?: string }>;
}) {
  seedIfEmpty();
  const params = await searchParams;
  const user = await currentUser();

  const plan = PLANS.find((p) => p.id === params.plan) ?? PLANS[0];
  const cycle: BillingCycle = params.cycle === "annual" ? "annual" : "monthly";
  const venue = user ? listLocationsFor(user.tenantId)[0] : undefined;

  const fee = periodFee(plan, cycle);
  const money = (fils: number) =>
    `AED ${(fils / FILS).toLocaleString("en-GB", { maximumFractionDigits: 0 })}`;

  const live = plan.features.filter((f) => f.status === "live");
  const serif = { fontFamily: '"Fraunces", Georgia, serif', fontWeight: 500 } as const;

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)" }}>
      <main className="checkout">
        <div style={{ gridArea: "brand", marginBottom: 30 }}>
          <a href="https://belline.ai" style={{ textDecoration: "none" }}>
            <Brand size={28} />
          </a>
        </div>

        {/* The order. */}
        <section className="checkout-order">
          <PlanSwitch current={plan.id} cycle={cycle} />

          <h1 style={{ ...serif, fontSize: 25, letterSpacing: "-0.02em", margin: "0 0 6px" }}>
            Belline {plan.name}
          </h1>
          <p className="muted" style={{ fontSize: 13.5, margin: "0 0 22px", lineHeight: 1.55 }}>
            {plan.summary}
          </p>

          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 9,
              paddingBottom: 18,
              marginBottom: 18,
              borderBottom: "1px solid var(--border-soft)",
            }}
          >
            <span style={{ ...serif, fontSize: 34, letterSpacing: "-0.02em", lineHeight: 1 }}>
              {money(fee)}
            </span>
            <span className="muted" style={{ fontSize: 13 }}>
              {cycle === "annual" ? "a year" : "a month"}
            </span>
          </div>

          <ul style={{ listStyle: "none", padding: 0, margin: "0 0 20px" }}>
            {live.map((f) => (
              <li
                key={f.text}
                style={{
                  position: "relative",
                  paddingLeft: 19,
                  marginBottom: 8,
                  fontSize: 13,
                  color: "var(--text-2)",
                  lineHeight: 1.5,
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    position: "absolute",
                    left: 0,
                    top: "0.62em",
                    width: 8,
                    height: 1,
                    background: "var(--gold-ink)",
                  }}
                />
                {f.text}
              </li>
            ))}
          </ul>

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              padding: "15px 0 0",
              borderTop: "1px solid var(--border)",
            }}
          >
            <span style={{ fontSize: 13.5, fontWeight: 600 }}>Due today</span>
            <span style={{ ...serif, fontSize: 21, letterSpacing: "-0.015em" }}>
              {user ? money(fee) : money(0)}
            </span>
          </div>
          {!user && (
            <p className="muted" style={{ fontSize: 11.5, margin: "8px 0 0", lineHeight: 1.6 }}>
              Fourteen days free. Then {money(fee)} {cycle === "annual" ? "a year" : "a month"},
              cancel any time before.
            </p>
          )}

          {cycle === "monthly" && (
            <p className="muted" style={{ fontSize: 11.5, margin: "14px 0 0", lineHeight: 1.6 }}>
              {/* annualPerMonth already returns fils. Multiplying by FILS
                  again put "AED 14,900 a month" on the page. */}
              Or {money(annualPerMonth(plan))} a month{" "}
              <a href={`/checkout?plan=${plan.id}&cycle=annual`}>paid annually</a> — two months free.
            </p>
          )}
        </section>

        {/* The part that makes it theirs. */}
        <section className="checkout-act">
          {params.cancelled && (
            <p
              style={{
                fontSize: 12.5,
                padding: "10px 13px",
                borderRadius: 9,
                background: "var(--panel-2)",
                border: "1px solid var(--border)",
                margin: "0 0 20px",
                color: "var(--text-2)",
              }}
            >
              Nothing was charged. Pick it up whenever you like.
            </p>
          )}

          {user ? (
            <>
              <h2 style={{ ...serif, fontSize: 21, letterSpacing: "-0.015em", margin: "0 0 6px" }}>
                Add a card
              </h2>
              <p className="muted" style={{ fontSize: 13, margin: "0 0 22px", lineHeight: 1.55 }}>
                Billed for {venue?.name ?? "your venue"}.
              </p>
              <PayButton
                planId={plan.id}
                cycle={cycle}
                enabled={stripeEnabled()}
                venueName={venue?.name ?? "your venue"}
              />
            </>
          ) : (
            <>
              <h2 style={{ ...serif, fontSize: 21, letterSpacing: "-0.015em", margin: "0 0 6px" }}>
                Someone always answers.
              </h2>
              <p className="muted" style={{ fontSize: 13, margin: "0 0 22px", lineHeight: 1.55 }}>
                Four things and you are set up.
              </p>
              <CheckoutForm planId={plan.id} cycle={cycle} takesCard={stripeEnabled()} />
            </>
          )}

          <p
            className="muted"
            style={{ fontSize: 11, margin: "18px 0 0", textAlign: "center", lineHeight: 1.65 }}
          >
            {stripeEnabled() ? "Secure checkout by Stripe · " : ""}Cancel anytime
            <br />
            Several venues? <a href="mailto:hello@belline.ai">Email us</a> and we will price it
            properly.
          </p>
        </section>
      </main>
    </div>
  );
}

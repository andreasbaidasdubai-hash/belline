import Brand from "@/components/Brand";
import { requireUser } from "@/lib/auth-server";
import { listLocationsFor } from "@/lib/store";
import { seedIfEmpty } from "@/lib/seed";
import { PLANS, periodFee, FILS, annualPerMonth, type BillingCycle } from "@/lib/billing/plans";
import { stripeEnabled } from "@/lib/billing/stripe";
import PayButton from "./PayButton";

export const dynamic = "force-dynamic";

export const metadata = { title: "Checkout" };

/**
 * The checkout page.
 *
 * Everything on it is the order and nothing else: the logo, the plan, the
 * price, what is included, what happens next. No navigation, no footer, no
 * second offer — a page whose only job is to be agreed with should not contain
 * a way to wander off.
 *
 * The card itself is taken on Stripe's hosted page, which is where the "Pay"
 * button goes. That is not a shortcut: it arrives with 3D Secure, Apple Pay,
 * Google Pay, local card rules and PCI scope we are much better off not
 * having, and a form of ours would be a worse version of it that also made us
 * responsible for card numbers.
 */
export default async function CheckoutPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string; cycle?: string; cancelled?: string }>;
}) {
  seedIfEmpty();
  const user = await requireUser();
  const params = await searchParams;

  const plan = PLANS.find((p) => p.id === params.plan) ?? PLANS[0];
  const cycle: BillingCycle = params.cycle === "annual" ? "annual" : "monthly";
  const venue = listLocationsFor(user.tenantId)[0];

  const fee = periodFee(plan, cycle);
  const money = (fils: number) =>
    `AED ${(fils / FILS).toLocaleString("en-GB", { maximumFractionDigits: 0 })}`;

  const live = plan.features.filter((f) => f.status === "live");
  const serif = { fontFamily: '"Fraunces", Georgia, serif', fontWeight: 500 } as const;

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", display: "grid", placeItems: "start center" }}>
      <main style={{ width: "100%", maxWidth: 520, padding: "56px 26px 90px" }}>
        <div style={{ textAlign: "center", marginBottom: 34 }}>
          <Brand size={28} />
        </div>

        {params.cancelled && (
          <p
            style={{
              fontSize: 13,
              padding: "11px 14px",
              borderRadius: 9,
              background: "var(--panel-2)",
              border: "1px solid var(--border)",
              margin: "0 0 24px",
              color: "var(--text-2)",
            }}
          >
            Nothing was charged. You can pick it up again whenever you like.
          </p>
        )}

        <div className="panel" style={{ padding: "30px 28px" }}>
          <h1 style={{ ...serif, fontSize: 26, letterSpacing: "-0.02em", margin: "0 0 6px" }}>
            Belline {plan.name}
          </h1>
          <p className="muted" style={{ fontSize: 13.5, margin: "0 0 24px", lineHeight: 1.55 }}>
            {plan.summary}
          </p>

          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 10,
              paddingBottom: 20,
              marginBottom: 20,
              borderBottom: "1px solid var(--border-soft)",
            }}
          >
            <span style={{ ...serif, fontSize: 38, letterSpacing: "-0.02em", lineHeight: 1 }}>
              {money(fee)}
            </span>
            <span className="muted" style={{ fontSize: 13.5 }}>
              {cycle === "annual" ? "a year" : "a month"}
            </span>
          </div>

          <ul style={{ listStyle: "none", padding: 0, margin: "0 0 24px" }}>
            {live.map((f) => (
              <li
                key={f.text}
                style={{
                  position: "relative",
                  paddingLeft: 20,
                  marginBottom: 9,
                  fontSize: 13.5,
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
              padding: "16px 0",
              borderTop: "1px solid var(--border)",
              marginBottom: 22,
            }}
          >
            <span style={{ fontSize: 14, fontWeight: 600 }}>Due today</span>
            <span style={{ ...serif, fontSize: 22, letterSpacing: "-0.015em" }}>{money(fee)}</span>
          </div>

          <PayButton
            planId={plan.id}
            cycle={cycle}
            enabled={stripeEnabled()}
            venueName={venue?.name ?? "your venue"}
          />

          <p className="muted" style={{ fontSize: 11.5, margin: "16px 0 0", textAlign: "center", lineHeight: 1.6 }}>
            Secure checkout by Stripe · Cancel anytime
            {cycle === "monthly" && plan.annual > 0 ? (
              <>
                <br />
                Or {money(annualPerMonth(plan))} a month{" "}
                <a href={`/checkout?plan=${plan.id}&cycle=annual`}>paid annually</a>.
              </>
            ) : null}
          </p>
        </div>

        <p className="muted" style={{ fontSize: 12, textAlign: "center", marginTop: 22, lineHeight: 1.6 }}>
          Billed for {venue?.name ?? "your venue"}. Several venues?{" "}
          <a href="mailto:hello@belline.ai">Email us</a> — we will price it properly.
        </p>
      </main>
    </div>
  );
}

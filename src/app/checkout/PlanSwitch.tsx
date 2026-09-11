import { PLANS, periodFee, FILS, type BillingCycle, type PlanId } from "@/lib/billing/plans";

/**
 * Moving between plans, without going back.
 *
 * The checkout leads with one plan because three plans and a billing toggle is
 * four decisions in front of a purchase. But "leads with" is not "only offers"
 * — somebody who arrives on Starter and knows their phone is busier than that
 * needs a way up that is not the back button.
 *
 * So: one line, the three names, the current one marked. Deliberately not a
 * pricing table — a pricing table is the thing the checkout exists to be the
 * other side of. Prices are shown because a switcher without them makes
 * somebody click to find out, which is the same as hiding them.
 *
 * Links rather than a control, so each plan is a real URL that can be sent to
 * somebody, put in an email, or linked from the pricing page.
 */
export default function PlanSwitch({
  current,
  cycle,
}: {
  current: PlanId;
  cycle: BillingCycle;
}) {
  const money = (fils: number) =>
    `AED ${(fils / FILS).toLocaleString("en-GB", { maximumFractionDigits: 0 })}`;

  return (
    <nav className="plan-switch" aria-label="Choose a plan">
      {PLANS.map((plan) => {
        const active = plan.id === current;
        return (
          <a
            key={plan.id}
            href={`/checkout?plan=${plan.id}${cycle === "annual" ? "&cycle=annual" : ""}`}
            aria-current={active ? "page" : undefined}
            className={active ? "is-on" : undefined}
          >
            <strong>{plan.name}</strong>
            <span>{money(periodFee(plan, cycle))}</span>
          </a>
        );
      })}
    </nav>
  );
}

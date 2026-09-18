import Link from "next/link";

import ManageBilling from "./ManageBilling";

/**
 * Payment details: what can actually be done about them today.
 *
 * The founder's note (f6) was "Billing gets its own tab where payment details
 * can be added". The tab is now its own menu item; this is the panel. What it
 * must not be is a card form, because there is nowhere for a card to go:
 * `billing.stripe` needs both Stripe keys, and until it has them no card can
 * be taken, stored or charged. A form that looked real and quietly did nothing
 * would be worse than the gap it papers over — and a form that posted a card
 * number to a server with no processor behind it would be worse again.
 *
 * So there are exactly three states, and each says what is true of it:
 *
 *   closed   — payments are not open. Nothing to add, nothing being charged,
 *              and the trial is extended rather than ended while that lasts
 *              (billing/trial-end.ts). Somebody is told; it is not on the
 *              owner to chase it.
 *   open     — payments work and this venue has no customer record yet, which
 *              means it has never chosen a plan. The card is asked for there,
 *              on Stripe's own page, never here.
 *   onFile   — Stripe has this venue. Its own portal is where the card, the
 *              invoices and the cancellation live, and it is one button away.
 *
 * Belline never sees a card number in any of the three: the only place one is
 * ever typed is Stripe's own page.
 */
export default function PaymentDetails({
  locationId,
  paymentsOpen,
  hasCustomer,
  trialEndsOn,
}: {
  locationId: string;
  /** `billing.stripe`: both Stripe keys are configured and card payments are open. */
  paymentsOpen: boolean;
  /** This venue has a Stripe customer, so there is a portal to open. */
  hasCustomer: boolean;
  /** The trial's end, spoken, where there is one and payments are closed. */
  trialEndsOn?: string | null;
}) {
  return (
    <div className="panel" style={{ marginBottom: 14 }} data-testid="payment-details">
      <div className="panel-head">Payment details</div>
      <div style={{ padding: "16px 18px" }}>
        {!paymentsOpen ? (
          <>
            <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6, maxWidth: "62ch" }}>
              <strong style={{ fontWeight: 600 }}>Card payments are not open yet</strong>, so there is nothing to add here
              today and nothing is being charged. Belline is not holding a card for you and has never asked for one.
            </p>
            <p className="muted" style={{ margin: "8px 0 0", fontSize: 12.5, lineHeight: 1.6, maxWidth: "62ch" }}>
              Your receptionist keeps answering in the meantime{trialEndsOn ? `, and your trial is being extended past ${trialEndsOn} rather than ending` : ""}.
              The Belline team is told when an account reaches this point and will contact you to set payment up — you do
              not need to chase it. When card payments open, this is where the card goes.
            </p>
          </>
        ) : hasCustomer ? (
          <>
            <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6, maxWidth: "62ch" }}>
              Your card, your invoices and cancelling are on Stripe&rsquo;s own secure page. Belline never sees or stores a
              card number.
            </p>
            <ManageBilling locationId={locationId} />
          </>
        ) : (
          <>
            <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6, maxWidth: "62ch" }}>
              No card on file, and none is needed yet — the trial does not ask for one. The card is asked for when you
              choose a plan, on Stripe&rsquo;s own secure page. Belline never sees or stores a card number.
            </p>
            <Link href="/checkout" className="btn" style={{ marginTop: 14, display: "inline-block" }}>
              Choose a plan
            </Link>
          </>
        )}
      </div>
    </div>
  );
}

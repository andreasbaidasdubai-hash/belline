import type Stripe from "stripe";
import type { Booking, Location } from "../types";
import { getBooking, getLocation, listLocations, saveBooking, upsertLocation } from "../store";
import { sendSms, smsEnabled } from "../providers/sms";
import { stripe, stripeEnabled } from "./stripe";

/**
 * Deposits, taken by card, paid to the venue.
 *
 * Built ahead of card payments being switched on, and inert until then: every
 * entry point checks `depositsReady` and the rest of the product carries on
 * saying "the team will send a link", exactly as before.
 *
 * Three decisions that rule out worse versions:
 *
 *   **The money is the venue's, so the account is the venue's.** Stripe
 *   Connect, with the Checkout session created *on* the venue's connected
 *   account. A deposit collected into Belline's own account would make us the
 *   merchant for somebody else's restaurant — their refunds, their disputes,
 *   their VAT — which is a business we do not want to be in.
 *
 *   **A link by text, never a card read over the phone.** The agent says a
 *   link is coming; the guest pays on Stripe's page. No card number ever
 *   passes through a transcript.
 *
 *   **Paid is what the webhook says, not what a redirect says.** Same rule as
 *   the subscription: somebody landing on the thank-you page proves only that
 *   their browser followed a link.
 */

export function depositsReady(location: Location): boolean {
  return (
    stripeEnabled() &&
    Boolean(location.payments?.stripeAccountId) &&
    Boolean(location.payments?.chargesEnabled)
  );
}

function appOrigin(): string {
  return (process.env.PUBLIC_ORIGIN || "https://app.belline.ai").replace(/\/$/, "");
}

export interface DepositLink {
  link: string | null;
  texted: boolean;
  detail?: string;
}

/**
 * Open a payment link for a booking's deposit and text it to the guest.
 *
 * Never throws: it runs while a caller is on the line, and a booking that is
 * already made must not be undone by a payment provider being slow.
 */
export async function requestDeposit(location: Location, bookingId: string): Promise<DepositLink> {
  const booking = getBooking(bookingId);
  const deposit = booking?.deposit;
  if (!booking || !deposit || deposit.status !== "required") {
    return { link: null, texted: false, detail: "No deposit is owed on this booking." };
  }
  if (!depositsReady(location)) {
    return { link: null, texted: false, detail: "Card payments are not set up for this venue." };
  }

  try {
    const session = await stripe().checkout.sessions.create(
      {
        mode: "payment",
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: deposit.currency.toLowerCase(),
              // Minor units. AED and every currency a venue here would use has two.
              unit_amount: Math.round(deposit.amount * 100),
              product_data: {
                name: `Deposit — ${location.name}`,
                description: `Booking ${booking.ref}`,
              },
            },
          },
        ],
        metadata: { belline_booking: booking.id, belline_location: location.id },
        payment_intent_data: {
          metadata: { belline_booking: booking.id, belline_location: location.id },
        },
        success_url: `${appOrigin()}/pay/paid?ref=${encodeURIComponent(booking.ref)}`,
        cancel_url: `${appOrigin()}/pay/cancelled?ref=${encodeURIComponent(booking.ref)}`,
        // Stripe's ceiling. A link that lives longer than a day is chased by the team.
        expires_at: Math.floor(Date.now() / 1000) + 23 * 60 * 60,
      },
      { stripeAccount: location.payments!.stripeAccountId },
    );

    const link = session.url ?? null;
    saveBooking({
      ...booking,
      deposit: {
        ...deposit,
        link: link ?? undefined,
        checkoutId: session.id,
        requestedAt: new Date().toISOString(),
      },
    });
    if (!link) return { link: null, texted: false, detail: "Stripe returned no link." };

    if (!smsEnabled()) return { link, texted: false, detail: "Texts are not configured." };
    const sms = await sendSms(
      booking.guestPhone,
      `${location.name}: to hold booking ${booking.ref}, please pay the ${deposit.currency} ${deposit.amount} deposit here: ${link}`,
    );
    return { link, texted: sms.sent, detail: sms.reason };
  } catch (err) {
    return { link: null, texted: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** A manager settling it by hand: paid at the desk, or let off. */
export function settleDeposit(bookingId: string, how: "paid" | "waived"): Booking | null {
  const booking = getBooking(bookingId);
  if (!booking?.deposit) return null;
  return saveBooking({
    ...booking,
    deposit: {
      ...booking.deposit,
      status: how,
      ...(how === "paid" ? { paidAt: new Date().toISOString() } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Connecting the venue's own Stripe account
// ---------------------------------------------------------------------------

/**
 * Where to send an owner to set up payouts.
 *
 * Express accounts: Stripe runs identity checks, bank details and payouts on
 * its own pages, which is both less for us to build and less for us to hold.
 */
export async function connectOnboardingUrl(location: Location, returnUrl: string): Promise<string> {
  const s = stripe();
  let accountId = location.payments?.stripeAccountId;

  if (!accountId) {
    const account = await s.accounts.create({
      type: "express",
      country: "AE",
      business_profile: { name: location.name },
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      metadata: { belline_location: location.id },
    });
    accountId = account.id;
    upsertLocation({
      ...location,
      payments: { stripeAccountId: accountId, chargesEnabled: false, updatedAt: new Date().toISOString() },
    });
  }

  const link = await s.accountLinks.create({
    account: accountId,
    type: "account_onboarding",
    return_url: returnUrl,
    refresh_url: returnUrl,
  });
  return link.url;
}

/** Ask Stripe whether the venue can take a card yet. Called when the owner comes back. */
export async function refreshConnectedAccount(location: Location): Promise<Location> {
  const accountId = location.payments?.stripeAccountId;
  if (!accountId || !stripeEnabled()) return location;
  const account = await stripe().accounts.retrieve(accountId);
  return upsertLocation({
    ...location,
    payments: { stripeAccountId: accountId, chargesEnabled: Boolean(account.charges_enabled), updatedAt: new Date().toISOString() },
  });
}

// ---------------------------------------------------------------------------
// The webhook
// ---------------------------------------------------------------------------

/**
 * What a Stripe event means for a deposit or a connected account.
 *
 * Returns null for anything that is not ours, so the subscription handler can
 * have it. Checked first, because a deposit's `checkout.session.completed`
 * looks exactly like a subscription's to anything that does not read the
 * metadata — and treating one as the other would put a guest's AED 100 on the
 * venue's plan.
 */
export function applyDepositEvent(event: Stripe.Event): { locationId?: string; applied: string } | null {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const session = event.data.object;
      const bookingId = session.metadata?.belline_booking;
      if (!bookingId) return null;
      const booking = getBooking(bookingId);
      if (!booking?.deposit) return { applied: "ignored: unknown booking" };
      if (session.payment_status !== "paid") {
        return { locationId: booking.locationId, applied: "deposit not paid yet" };
      }
      saveBooking({
        ...booking,
        deposit: { ...booking.deposit, status: "paid", paidAt: new Date().toISOString() },
      });
      return { locationId: booking.locationId, applied: "deposit paid" };
    }

    case "checkout.session.expired": {
      const session = event.data.object;
      const bookingId = session.metadata?.belline_booking;
      if (!bookingId) return null;
      const booking = getBooking(bookingId);
      if (!booking?.deposit || booking.deposit.status !== "required") {
        return { applied: "ignored: nothing owed" };
      }
      saveBooking({ ...booking, deposit: { ...booking.deposit, link: undefined, linkExpiredAt: new Date().toISOString() } });
      return { locationId: booking.locationId, applied: "deposit link expired" };
    }

    case "account.updated": {
      const account = event.data.object;
      const location = listLocations({ includeInternal: true }).find(
        (l) => l.payments?.stripeAccountId === account.id,
      );
      if (!location) return null;
      upsertLocation({
        ...location,
        payments: {
          stripeAccountId: account.id,
          chargesEnabled: Boolean(account.charges_enabled),
          updatedAt: new Date().toISOString(),
        },
      });
      return { locationId: location.id, applied: `card payments ${account.charges_enabled ? "on" : "not ready"}` };
    }

    default:
      return null;
  }
}

/** For the dashboard: bookings still owing, soonest first. */
export function openDeposits(locationId: string, bookings: Booking[]): Booking[] {
  const location = getLocation(locationId);
  if (!location) return [];
  return bookings
    .filter((b) => b.locationId === locationId && b.status === "confirmed" && b.deposit?.status === "required")
    .sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin);
}

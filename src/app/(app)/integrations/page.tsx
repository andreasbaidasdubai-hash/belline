import Link from "next/link";
import { requireUser, resolveLocation } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import { integrationErrorText } from "@/lib/errors/customer";
import { seedIfEmpty } from "@/lib/seed";
import { destinationOf, googleUsable, takesRequestsOnly } from "@/lib/booking/destination";
import { GOOGLE_EXPIRED_TEXT, connectionState, listCalendarsFor } from "@/lib/integrations/google";
import { flag } from "@/lib/flags";
import { getLocation } from "@/lib/store";
import GoogleCalendarControls from "./GoogleCalendarControls";
import { whatsappStatus } from "@/lib/whatsapp";
import { whatsappCard } from "@/lib/whatsapp-selfserve";
import { LocationTabs, PageHeader } from "@/components/LocationTabs";
import WhatsAppCard from "./WhatsAppCard";
import RemindersForm from "./RemindersForm";
import { smsEnabled } from "@/lib/providers/sms";
import { reminderHours, remindersEnabled } from "@/lib/reminders";
import { stripeEnabled } from "@/lib/billing/stripe";
import { depositsReady, refreshConnectedAccount } from "@/lib/billing/deposits";

export const dynamic = "force-dynamic";

/**
 * What Belline is connected to.
 *
 * Deliberately honest about the ones that are not built. Four of the systems
 * on the website are partner-gated — they issue credentials under a signed
 * agreement and there is no self-serve route — so showing them as "coming
 * soon" beside a working connection would be the kind of half-truth an
 * operator discovers at exactly the wrong moment.
 */

const PARTNER_GATED = [
  { name: "Fresha", note: "Partner programme. Credentials are issued under agreement." },
  { name: "SevenRooms", note: "Partner programme. Credentials are issued under agreement." },
  { name: "OpenTable", note: "Connect partner programme. Commercial agreement required." },
  { name: "Treatwell", note: "Partner programme. Credentials are issued under agreement." },
];

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<{ loc?: string; connected?: string; error?: string; payments?: string }>;
}) {
  seedIfEmpty();
  const user = await requireUser();
  const { loc, connected, error, payments } = await searchParams;
  const location = await resolveLocation(user, loc);
  if (!location) return <p className="muted">No venues are assigned to your account yet.</p>;
  // Back from Stripe's onboarding: ask whether cards can be taken yet.
  const paymentsVenue =
    payments && location.payments?.stripeAccountId
      ? await refreshConnectedAccount(location).catch(() => location)
      : location;

  // Calendars first: loading them is what finds out a token has expired, and
  // the state below should say so on this load, not the next.
  const googleOn = flag("booking.google");
  const calendars = googleOn && googleUsable(location) ? await listCalendarsFor(location).catch(() => null) : null;
  const googleVenue = getLocation(location.id) ?? location;
  const google = connectionState(googleVenue);
  const twoWay = destinationOf(googleVenue) === "google";
  const whatsapp = await whatsappStatus(location);
  const account = whatsapp.state === "connected" ? whatsapp.account : null;

  return (
    <>
      <PageHeader
        title="Integrations"
        subtitle={
          takesRequestsOnly(location)
            ? "Belline takes booking requests and your team confirms each one. Calendars and booking systems below are shown as they are today."
            : "Belline decides availability. A connected calendar is where the team already looks, so bookings are mirrored into it."
        }
      />
      <LocationTabs base="/integrations" active={location.id} />

      {connected && (
        <div
          className="panel"
          style={{
            padding: "12px 16px",
            marginBottom: 14,
            background: "var(--ok-soft)",
            borderColor: "var(--ok)",
            fontSize: 13,
          }}
        >
          Connected. Everything upcoming has been written across.
        </div>
      )}
      {error && (
        <div
          className="panel"
          style={{
            padding: "12px 16px",
            marginBottom: 14,
            background: "var(--bad-soft)",
            borderColor: "var(--bad)",
            color: "var(--bad)",
            fontSize: 13,
          }}
        >
          {integrationErrorText(error)}
        </div>
      )}

      {/*
        WhatsApp, the second-number way: the venue keeps its own WhatsApp
        untouched and Belle answers a number we register for it. Connected by
        us, shown here, and honest when it is not.
      */}
      {/* The text the day before. */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">Reminder texts</div>
        <div style={{ padding: 18 }}>
          <p className="muted" style={{ fontSize: 13, lineHeight: 1.6, maxWidth: "68ch", margin: 0 }}>
            {smsEnabled()
              ? `Every booking gets a text ${reminderHours(location)} hours before, with the time, the reference and your number to change it. A booking made inside that window is not reminded — its confirmation already was.`
              : "Texts are not switched on for Belline yet, so no reminders are going out. There is nothing to do on your side: they start the day texts are switched on, with the setting below."}
          </p>
          <RemindersForm
            locationId={location.id}
            enabled={remindersEnabled(location)}
            hours={reminderHours(location)}
          />
        </div>
      </div>

      {/* Deposits, paid into the venue's own Stripe account. */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">Deposits</div>
        <div style={{ padding: 18 }}>
          <p className="muted" style={{ fontSize: 13, lineHeight: 1.6, maxWidth: "68ch", margin: 0 }}>
            {!location.policy?.deposit
              ? "No deposit rule is set. Add one under How it works — who pays, how much, on which days — and Belline tells callers about it when they book."
              : !stripeEnabled()
                ? "Belline tells callers about your deposit when they book, and the booking is marked as owing it. Card payments are not switched on yet, so your team sends the link and marks it paid in Bookings."
                : depositsReady(paymentsVenue)
                  ? "Connected. When a booking needs a deposit, the guest is texted a Stripe link straight away, and the money goes to your own Stripe account. Paid deposits are marked in Bookings on their own."
                  : "Connect your own Stripe account and guests are texted a link to pay the deposit the moment they book. The money goes to your account, not ours — Stripe checks who you are and where to pay out."}
          </p>
          {location.policy?.deposit && stripeEnabled() && !depositsReady(paymentsVenue) && (
            <a className="btn btn-accent" href={`/api/payments/connect?locationId=${location.id}`} style={{ display: "inline-block", marginTop: 14 }}>
              {paymentsVenue.payments?.stripeAccountId ? "Finish setting up Stripe" : "Set up card payments with Stripe"}
            </a>
          )}
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">WhatsApp</div>
        <div style={{ padding: 18 }}>
          <WhatsAppCard
            locationId={location.id}
            venueName={location.name}
            card={location.demo?.enabled && !account ? { state: "soon" } : whatsappCard(location, whatsapp)}
            pendingName={location.whatsappPending?.displayName ?? null}
            notifyRequested={Boolean(location.onboarding?.integrationRequests?.includes("whatsapp"))}
          />
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">Google Calendar</div>
        <div style={{ padding: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
            <span
              className="pill"
              style={
                google.connected && google.healthy
                  ? { background: "var(--ok-soft)", color: "var(--ok)", borderColor: "var(--ok)" }
                  : google.connected
                    ? { background: "var(--bad-soft)", color: "var(--bad)", borderColor: "var(--bad)" }
                    : undefined
              }
            >
              {google.connected ? (google.healthy ? "Connected" : "Needs attention") : "Not connected"}
            </span>
            <span className="muted" style={{ fontSize: 12.5 }}>
              {google.detail}
            </span>
          </div>

          {google.expired && (
            <div
              role="alert"
              className="panel"
              style={{ padding: "12px 14px", margin: "0 0 12px", borderColor: "var(--bad)", background: "var(--bad-soft)", fontSize: 13.5 }}
            >
              {GOOGLE_EXPIRED_TEXT}
            </div>
          )}

          {twoWay ? (
            <p className="muted" style={{ fontSize: 13, lineHeight: 1.6, maxWidth: "68ch" }}>
              Belline reads busy times from the calendars you pick and adds each booking to
              them. Your hours, services and rules still decide what can be booked; the
              calendar can only take times away. To change or cancel a booking, do it in
              Belline, so the customer&apos;s record stays right.
            </p>
          ) : (
            <p className="muted" style={{ fontSize: 13, lineHeight: 1.6, maxWidth: "68ch" }}>
              Bookings are written into the venue&apos;s calendar as they happen — one way.
              Belline stays in charge of availability, because it knows things a calendar
              cannot: which practitioner is qualified, how many covers the kitchen can take at
              eight, that the chair is held for ten minutes after the guest leaves. An event
              dragged about in Google does not change the booking, and the event text says so.
            </p>
          )}

          {googleOn ? (
            <>
              <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
                <a className="btn btn-accent" href={`/api/integrations/google?locationId=${location.id}`}>
                  {google.connected ? "Reconnect" : "Connect Google Calendar"}
                </a>
                {google.connected && !google.expired && (
                  <Link className="btn" href={`/calendar?loc=${location.id}`}>
                    See the diary
                  </Link>
                )}
              </div>
              {googleUsable(googleVenue) && googleVenue.google && (
                <GoogleCalendarControls
                  locationId={location.id}
                  calendars={calendars}
                  calendarId={googleVenue.google.calendarId}
                  staff={(location.salon?.staff ?? []).map((s) => ({ id: s.id, name: s.name }))}
                  staffCalendars={googleVenue.google.staffCalendars ?? {}}
                />
              )}
            </>
          ) : (
            <p style={{ fontSize: 12.5, color: "var(--warn)", marginTop: 14 }}>
              Google Calendar isn&apos;t available on this account yet.
              {isBellineStaff(user) && (
                <span className="muted"> (Ours to fix: the booking.google flag is off. See the ops flags.)</span>
              )}
            </p>
          )}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          Booking systems
          <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>
            not yet available
          </span>
        </div>
        <div style={{ padding: 18 }}>
          <p className="muted" style={{ fontSize: 13, lineHeight: 1.6, maxWidth: "68ch" }}>
            These are not a matter of engineering time. Each issues API credentials only
            under a signed partner agreement, so none can be built until that agreement
            exists — and saying &ldquo;coming soon&rdquo; instead would be a half-truth an
            operator discovers at the worst possible moment.
          </p>
          <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
            {PARTNER_GATED.map((system) => (
              <div key={system.name} style={{ display: "flex", gap: 12, alignItems: "baseline" }}>
                <span style={{ fontWeight: 600, fontSize: 13.5, minWidth: 110 }}>{system.name}</span>
                <span className="muted" style={{ fontSize: 12.5 }}>
                  {system.note}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

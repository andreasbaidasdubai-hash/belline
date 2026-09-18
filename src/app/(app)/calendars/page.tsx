import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser, resolveLocation } from "@/lib/auth-server";
import { canEditAgent, isBellineStaff } from "@/lib/auth";
import { integrationErrorText } from "@/lib/errors/customer";
import { seedIfEmpty } from "@/lib/seed";
import { calendlyUsable, destinationOf, googleUsable, onBellineDiary, outlookUsable, takesRequestsOnly } from "@/lib/booking/destination";
import {
  CALENDLY_ABANDONED_TEXT,
  calendlyConnectionState,
  calendlyLimits,
  refreshCalendlyEventTypes,
} from "@/lib/integrations/calendly";
import { GOOGLE_ABANDONED_TEXT, GOOGLE_EXPIRED_TEXT, connectionState, listCalendarsFor } from "@/lib/integrations/google";
import {
  OUTLOOK_ABANDONED_TEXT,
  OUTLOOK_ADMIN_APPROVAL_TEXT,
  listOutlookCalendarsFor,
  outlookConnectionState,
} from "@/lib/integrations/outlook";
import { canEditCalendarPeople } from "@/lib/integrations/calendar-people";
import { isActivated } from "@/lib/onboarding/journey";
import { readiness } from "@/lib/onboarding";
import { flag } from "@/lib/flags";
import { getLocation } from "@/lib/store";
import { LocationTabs, PageHeader } from "@/components/LocationTabs";
import { smsEnabled } from "@/lib/providers/sms";
import { reminderHours, remindersEnabled } from "@/lib/reminders";
import { stripeConfigured } from "@/lib/billing/stripe";
import { depositsReady, refreshConnectedAccount } from "@/lib/billing/deposits";
import type { DestinationKind, Location } from "@/lib/types";
import CalendarControls from "./CalendarControls";
import CalendlyControls from "./CalendlyControls";
import DestinationSwitch from "./DestinationSwitch";
import RemindersForm from "./RemindersForm";

export const dynamic = "force-dynamic";

export const metadata = { title: "Calendars" };

/**
 * Where this venue's bookings go, and the calendars behind it.
 *
 * Moved here from Integrations, which had become calendars, WhatsApp, reminder
 * texts and deposits on one page. A business whose team keeps several
 * calendars — each stylist their own Google calendar, the practice one shared
 * Outlook — needs to see who uses which in one place, so the per-person
 * mapping is a list of people rather than a footnote under a picker.
 *
 * Deliberately honest about the ones that are not built. Four of the booking
 * systems on the website are partner-gated — they issue credentials under a
 * signed agreement and there is no self-serve route — so showing them as
 * "coming soon" beside a working connection would be the kind of half-truth an
 * operator discovers at exactly the wrong moment.
 *
 * Owners and managers only: every calendar route refuses the staff role
 * (`canEditAgent`), so the page does too rather than showing buttons that fail.
 */

const PARTNER_GATED = [
  { name: "Fresha", note: "Partner programme. Credentials are issued under agreement." },
  { name: "SevenRooms", note: "Partner programme. Credentials are issued under agreement." },
  { name: "OpenTable", note: "Connect partner programme. Commercial agreement required." },
  { name: "Treatwell", note: "Partner programme. Credentials are issued under agreement." },
];

/** "Google Calendar", "your Outlook calendar", "your Calendly". */
const CALENDAR_NAME: Record<"google" | "outlook" | "calendly", string> = {
  google: "Google Calendar",
  outlook: "your Outlook calendar",
  calendly: "your Calendly",
};

/** One sentence: where a booking made today actually ends up. */
function whereBookingsGo(location: Location): string {
  if (location.onboarding && !location.onboarding.destination) {
    return "You have not chosen where bookings go yet, so Belline takes booking requests for your team to confirm.";
  }
  const kind = destinationOf(location);
  if (kind === "belline") {
    return location.google || location.outlook
      ? "Bookings go into Belline's diary, and each one is copied into your connected calendar."
      : "Bookings go into Belline's diary.";
  }
  if (kind === "calendly") {
    return calendlyUsable(location)
      ? "Belline books straight into your Calendly, as one of your own event types. Calendly decides which times are open and how long the appointment is; Belline offers what it says and books it."
      : "You chose Calendly, but Belline cannot use it right now, so it takes booking requests for your team to confirm until it is connected again.";
  }
  if (kind === "google") {
    return googleUsable(location)
      ? "Belline books straight into your Google Calendar."
      : "You chose Google Calendar, but Belline cannot use it right now, so it takes booking requests for your team to confirm until it is connected again.";
  }
  if (kind === "outlook") {
    return outlookUsable(location)
      ? "Belline books straight into your Outlook calendar."
      : "You chose Outlook, but Belline cannot use it right now, so it takes booking requests for your team to confirm until it is connected again.";
  }
  if (kind === "partner") {
    return "Belline takes booking requests for your team to confirm, because your booking system cannot be connected yet.";
  }
  return location.onboarding?.destination?.bookingLink
    ? "Belline takes booking requests for your team to confirm, and can point customers to your own booking link."
    : "Belline takes booking requests, and your team confirms each one.";
}

/** What the venue would still need before booking straight into a calendar, by readiness's own list. */
function missingToBook(location: Location, kind: DestinationKind): string[] {
  const o = location.onboarding;
  if (!o) return [];
  const would: Location = { ...location, onboarding: { ...o, destination: { kind, setAt: new Date().toISOString() } } };
  return readiness(would).missing.map((m) => m.label);
}

export default async function CalendarsPage({
  searchParams,
}: {
  searchParams: Promise<{ loc?: string; connected?: string; error?: string; payments?: string }>;
}) {
  seedIfEmpty();
  const user = await requireUser();
  const { loc, connected, error, payments } = await searchParams;
  const location = await resolveLocation(user, loc);
  if (!location) return <p className="muted">No venues are assigned to your account yet.</p>;
  if (!canEditAgent(user, location.id)) notFound();

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
  // Outlook, the same way, from its own flag.
  const outlookOn = flag("booking.outlook");
  const outlookCalendars = outlookOn && outlookUsable(googleVenue) ? await listOutlookCalendarsFor(googleVenue).catch(() => null) : null;
  const outlookVenue = getLocation(location.id) ?? googleVenue;
  const outlook = outlookConnectionState(outlookVenue);
  const outlookTwoWay = destinationOf(outlookVenue) === "outlook";
  // Calendly, the same way. Its event types are read again on every load,
  // because they are the thing that decides what Belline can book: an owner who
  // deletes an event type in Calendly must see that here, not on a call.
  const calendlyOn = flag("booking.calendly");
  const calendlyRefreshed =
    calendlyOn && calendlyUsable(outlookVenue) ? await refreshCalendlyEventTypes(outlookVenue).catch(() => outlookVenue) : outlookVenue;
  const venue = getLocation(location.id) ?? calendlyRefreshed;
  const calendly = calendlyConnectionState(venue);
  const calendlyLimitList = venue.calendly ? calendlyLimits(venue).limits : [];
  const calendlyBlocked = calendlyLimitList.some((l) => l.severity === "blocking");

  const diary = onBellineDiary(venue);
  const live = isActivated(venue);
  const kind = destinationOf(venue);
  const mapsPeople = venue.vertical !== "restaurant";
  const people = (venue.salon?.staff ?? []).map((s) => ({ id: s.id, name: s.name }));
  const canEditPeople = canEditCalendarPeople(venue);
  const anyUsable = googleUsable(venue) || outlookUsable(venue);

  // The in-place switch, for a live venue that is not on the diary: between a
  // usable calendar and requests. Anything else is the setup step's.
  //
  // Calendly counts only when this account can actually take the venue's
  // bookings. An account with a service that has no event type, or a plan that
  // refuses the API, is connected but not offerable — the honest limits are
  // listed in its own panel below, and the switch is not shown until they are
  // dealt with. `recordStep` refuses on exactly the same answer, so the button
  // and the server cannot disagree.
  const usableKind: "google" | "outlook" | "calendly" | null = googleUsable(venue)
    ? "google"
    : outlookUsable(venue)
      ? "outlook"
      : calendlyUsable(venue) && !calendlyBlocked
        ? "calendly"
        : null;
  const usableName = usableKind ? CALENDAR_NAME[usableKind] : "";
  const booksIntoCalendar = (kind === "google" || kind === "outlook" || kind === "calendly") && !takesRequestsOnly(venue);
  const missing = live && !diary && usableKind && !booksIntoCalendar ? missingToBook(venue, usableKind) : [];

  // Reminder texts and deposits only mean something once there is a booking:
  // a venue that only takes requests has none, unless it asks for a deposit.
  const afterBooking = !takesRequestsOnly(venue) || Boolean(venue.policy?.deposit);

  return (
    <>
      <PageHeader
        title="Calendars"
        subtitle="Where bookings go, the calendars Belline reads and writes, and who on your team uses which."
      />
      <LocationTabs base="/calendars" active={location.id} />

      {connected && (
        <div
          role="status"
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
          role="alert"
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

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">Where bookings go</div>
        <div style={{ padding: 18, display: "grid", gap: 12 }}>
          <p style={{ fontSize: 14, lineHeight: 1.6, maxWidth: "68ch", margin: 0 }}>{whereBookingsGo(venue)}</p>
          {!live ? (
            <p style={{ fontSize: 13, margin: 0 }}>
              <Link href="/setup/bookings" style={{ color: "var(--accent)" }}>
                Change where bookings go
              </Link>
            </p>
          ) : diary ? null : booksIntoCalendar ? (
            <div>
              <DestinationSwitch locationId={venue.id} to="requests" label="Take booking requests instead" />
              <p className="muted" style={{ fontSize: 12.5, margin: "8px 0 0", maxWidth: "68ch" }}>
                Belline would stop booking and take each customer&apos;s details for your team to confirm. The calendar
                stays connected, and bookings already made stay in it.
              </p>
            </div>
          ) : usableKind ? (
            missing.length === 0 ? (
              <div>
                <DestinationSwitch
                  locationId={venue.id}
                  to={usableKind}
                  label={
                    usableKind === "google"
                      ? "Book straight into Google Calendar"
                      : usableKind === "outlook"
                        ? "Book straight into Outlook"
                        : "Book straight into Calendly"
                  }
                />
                <p className="muted" style={{ fontSize: 12.5, margin: "8px 0 0", maxWidth: "68ch" }}>
                  {usableKind === "calendly"
                    ? "Belline would offer the times Calendly says are open for the matching event type, inside your opening hours, and book each customer in as a Calendly invitee. Calendly sends its own confirmation, and its event type decides how long the appointment is."
                    : `Belline would offer times your hours and services allow, leave out anything busy in ${usableName}, and add each booking to it.`}
                </p>
              </div>
            ) : (
              <p className="muted" style={{ fontSize: 13, margin: 0, maxWidth: "68ch" }}>
                To book straight into {usableName}, Belline first needs: {missing.join(", ").toLowerCase()}.
              </p>
            )
          ) : (
            <p className="muted" style={{ fontSize: 13, margin: 0, maxWidth: "68ch" }}>
              Connect Google Calendar, Outlook or Calendly below and Belline can book straight into it.
            </p>
          )}
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">Google Calendar</div>
        <div style={{ padding: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
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

          {googleOn && !google.connected && googleVenue.googleConnectAbandonedAt && (
            <div
              role="status"
              className="panel"
              style={{ padding: "12px 14px", margin: "0 0 12px", borderColor: "var(--warn)", fontSize: 13.5, lineHeight: 1.55 }}
            >
              {GOOGLE_ABANDONED_TEXT}
            </div>
          )}

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
          ) : diary ? (
            <p className="muted" style={{ fontSize: 13, lineHeight: 1.6, maxWidth: "68ch" }}>
              Bookings are written into the venue&apos;s calendar as they happen — one way.
              Belline stays in charge of availability, because it knows things a calendar
              cannot: which practitioner is qualified, how many covers the kitchen can take at
              eight, that the chair is held for ten minutes after the guest leaves. An event
              dragged about in Google does not change the booking, and the event text says so.
            </p>
          ) : (
            <p className="muted" style={{ fontSize: 13, lineHeight: 1.6, maxWidth: "68ch" }}>
              Belline reads busy times only from the calendars you pick, and adds only the
              bookings it takes. Until bookings go into Google Calendar (above), Belline takes
              requests and nothing is written to it.
            </p>
          )}

          {googleOn ? (
            <>
              <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
                {venue.outlook ? (
                  <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
                    Outlook is connected to this venue. Belline uses one calendar per venue: disconnect Outlook first to use Google Calendar.
                  </p>
                ) : (
                  <a className="btn btn-accent" href={`/api/integrations/google?locationId=${location.id}`}>
                    {google.connected ? "Reconnect" : "Connect Google Calendar"}
                  </a>
                )}
                {diary && google.connected && !google.expired && (
                  <Link className="btn" href={`/calendar?loc=${location.id}`}>
                    See the diary
                  </Link>
                )}
              </div>
              {googleUsable(googleVenue) && googleVenue.google && (
                <CalendarControls
                  endpoint="/api/integrations/google"
                  idPrefix="google"
                  service="Google"
                  locationId={location.id}
                  calendars={calendars}
                  calendarId={googleVenue.google.calendarId}
                  staff={people}
                  staffCalendars={googleVenue.google.staffCalendars ?? {}}
                  mapsPeople={mapsPeople}
                  canEditPeople={canEditPeople}
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

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">Outlook</div>
        <div style={{ padding: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
            <span
              className="pill"
              style={
                outlook.connected && outlook.healthy
                  ? { background: "var(--ok-soft)", color: "var(--ok)", borderColor: "var(--ok)" }
                  : outlook.connected
                    ? { background: "var(--bad-soft)", color: "var(--bad)", borderColor: "var(--bad)" }
                    : undefined
              }
            >
              {outlook.connected ? (outlook.healthy ? "Connected" : "Needs attention") : "Not connected"}
            </span>
            <span className="muted" style={{ fontSize: 12.5 }}>
              {outlook.detail}
            </span>
          </div>

          {outlookOn && !outlook.connected && venue.outlookAdminApprovalAt && (
            <div role="status" className="panel" style={{ padding: "12px 14px", margin: "0 0 12px", borderColor: "var(--warn)", fontSize: 13.5, lineHeight: 1.55 }}>
              {OUTLOOK_ADMIN_APPROVAL_TEXT}
            </div>
          )}
          {outlookOn && !outlook.connected && !venue.outlookAdminApprovalAt && venue.outlookConnectAbandonedAt && (
            <div role="status" className="panel" style={{ padding: "12px 14px", margin: "0 0 12px", borderColor: "var(--warn)", fontSize: 13.5, lineHeight: 1.55 }}>
              {OUTLOOK_ABANDONED_TEXT}
            </div>
          )}
          {outlook.expired && (
            <div role="alert" className="panel" style={{ padding: "12px 14px", margin: "0 0 12px", borderColor: "var(--bad)", background: "var(--bad-soft)", fontSize: 13.5 }}>
              {outlook.detail}
            </div>
          )}

          {outlookOn ? (
            <>
              <p className="muted" style={{ fontSize: 13, lineHeight: 1.6, maxWidth: "68ch" }}>
                {outlookTwoWay
                  ? "Belline reads busy times from the Outlook calendars you pick and adds each booking to them. Your hours, services and rules still decide what can be booked; the calendar can only take times away. To change or cancel a booking, do it in Belline, so the customer's record stays right."
                  : "Works with a Microsoft 365 work account or an Outlook.com account. Belline reads busy times only from the calendars you pick, and adds, changes and removes only the bookings it takes. Some organisations need their IT admin to approve Belline first; if Microsoft asks for that, we help."}
              </p>
              <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
                {venue.google ? (
                  <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
                    Google Calendar is connected to this venue. Belline uses one calendar per venue: disconnect Google Calendar first to use Outlook.
                  </p>
                ) : (
                  <a className="btn btn-accent" href={`/api/integrations/microsoft?locationId=${location.id}`}>
                    {outlook.connected ? "Reconnect" : "Connect Outlook"}
                  </a>
                )}
              </div>
              {outlookUsable(venue) && venue.outlook && (
                <CalendarControls
                  endpoint="/api/integrations/microsoft"
                  idPrefix="outlook"
                  service="Outlook"
                  locationId={location.id}
                  calendars={outlookCalendars}
                  calendarId={venue.outlook.calendarId}
                  staff={people}
                  staffCalendars={venue.outlook.staffCalendars ?? {}}
                  mapsPeople={mapsPeople}
                  canEditPeople={canEditPeople}
                />
              )}
            </>
          ) : (
            <p style={{ fontSize: 12.5, color: "var(--warn)", marginTop: 14 }}>
              Outlook isn&apos;t available on this account yet. Until it is, Belline takes booking requests and your team confirms them.
              {isBellineStaff(user) && (
                <span className="muted"> (Ours to fix: the booking.outlook flag is off. See the ops flags.)</span>
              )}
            </p>
          )}
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">Calendly</div>
        <div style={{ padding: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
            <span
              className="pill"
              style={
                calendly.connected && calendly.healthy
                  ? { background: "var(--ok-soft)", color: "var(--ok)", borderColor: "var(--ok)" }
                  : calendly.connected
                    ? { background: "var(--bad-soft)", color: "var(--bad)", borderColor: "var(--bad)" }
                    : undefined
              }
            >
              {calendly.connected ? (calendly.healthy ? "Connected" : "Needs attention") : "Not connected"}
            </span>
            <span className="muted" style={{ fontSize: 12.5 }}>
              {calendly.detail}
            </span>
          </div>

          {calendlyOn && !calendly.connected && venue.calendlyConnectAbandonedAt && (
            <div role="status" className="panel" style={{ padding: "12px 14px", margin: "0 0 12px", borderColor: "var(--warn)", fontSize: 13.5, lineHeight: 1.55 }}>
              {CALENDLY_ABANDONED_TEXT}
            </div>
          )}
          {calendly.expired && (
            <div role="alert" className="panel" style={{ padding: "12px 14px", margin: "0 0 12px", borderColor: "var(--bad)", background: "var(--bad-soft)", fontSize: 13.5 }}>
              {calendly.detail}
            </div>
          )}

          {calendlyOn ? (
            <>
              <p className="muted" style={{ fontSize: 13, lineHeight: 1.6, maxWidth: "68ch" }}>
                Calendly is not a calendar Belline writes into — it is your booking page, and it stays in charge. Belline
                asks Calendly which times are open for the event type a customer wants, offers those, and books the
                customer in as an invitee. Calendly&apos;s event type decides how long the appointment is, Calendly sends
                the confirmation, and a cancellation made on either side reaches the other.
              </p>

              {/*
                The honest limits, at connect time.

                Not a footnote: a customer's own Calendly decides what the
                product can promise, and anything blocking here also stops
                Calendly being chosen as the destination (onboarding/journey.ts
                refuses it on the same answer). So the owner reads this before
                they rely on it, rather than meeting it on a call weeks later.
              */}
              {venue.calendly && calendlyLimitList.length > 0 && (
                <div
                  className="panel"
                  style={{
                    padding: "12px 14px",
                    margin: "0 0 12px",
                    borderColor: calendlyBlocked ? "var(--bad)" : "var(--warn)",
                    ...(calendlyBlocked ? { background: "var(--bad-soft)" } : {}),
                  }}
                >
                  <p style={{ fontSize: 13.5, fontWeight: 600, margin: "0 0 8px" }}>
                    {calendlyBlocked ? "Before Belline can book into this Calendly" : "What Belline can and cannot do through your Calendly"}
                  </p>
                  <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6 }}>
                    {calendlyLimitList.map((limit, i) => (
                      <li key={i} style={{ fontSize: 13, lineHeight: 1.55, color: limit.severity === "blocking" ? "var(--bad)" : undefined }}>
                        {limit.text}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
                {venue.google || venue.outlook ? (
                  <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
                    {venue.google ? "Google Calendar" : "Outlook"} is connected to this venue. Belline books into one place
                    per venue: disconnect it first to use Calendly.
                  </p>
                ) : (
                  <a className="btn btn-accent" href={`/api/integrations/calendly?locationId=${location.id}`}>
                    {calendly.connected ? "Reconnect" : "Connect Calendly"}
                  </a>
                )}
              </div>
              {venue.calendly && (venue.calendly.eventTypes ?? []).length > 0 && (
                <CalendlyControls
                  locationId={location.id}
                  eventTypes={(venue.calendly.eventTypes ?? []).filter((t) => t.active)}
                  services={(venue.salon?.services ?? []).map((s) => ({ id: s.id, name: s.name, durationMin: s.durationMin }))}
                  serviceEventTypes={venue.calendly.serviceEventTypes ?? {}}
                  defaultEventType={venue.calendly.defaultEventType}
                />
              )}
            </>
          ) : (
            <p style={{ fontSize: 12.5, color: "var(--warn)", marginTop: 14 }}>
              Calendly isn&apos;t available on this account yet. Until it is, Belline takes booking requests and your team
              confirms them.
              {isBellineStaff(user) && (
                <span className="muted"> (Ours to fix: the booking.calendly flag is off. See the ops flags.)</span>
              )}
            </p>
          )}
        </div>
      </div>

      {/* Without a usable calendar the list has nothing to point at: say when it arrives. */}
      {mapsPeople && !anyUsable && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <div className="panel-head">Who uses which calendar</div>
          <div style={{ padding: 18 }}>
            <p className="muted" style={{ fontSize: 13, lineHeight: 1.6, maxWidth: "68ch", margin: 0 }}>
              If your team keep their own calendars, you can say who uses which once Google Calendar or Outlook is
              connected: Belline then checks each person&apos;s calendar for busy times and adds their bookings to it.
            </p>
          </div>
        </div>
      )}

      <div className="panel" style={{ marginBottom: 16 }}>
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
              <div key={system.name} style={{ display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
                <span style={{ fontWeight: 600, fontSize: 13.5, minWidth: 110 }}>{system.name}</span>
                <span className="muted" style={{ fontSize: 12.5 }}>
                  {system.note}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {afterBooking && (
        <>
          <h2 style={{ fontSize: 15, margin: "26px 0 12px" }}>After a booking</h2>

          {/* The text the day before. Only where Belline makes bookings to remind. */}
          {!takesRequestsOnly(venue) && (
            <div className="panel" style={{ marginBottom: 16 }}>
              <div className="panel-head">Reminder texts</div>
              <div style={{ padding: 18 }}>
                <p className="muted" style={{ fontSize: 13, lineHeight: 1.6, maxWidth: "68ch", margin: 0 }}>
                  {smsEnabled()
                    ? `Every booking gets a text ${reminderHours(venue)} hours before, with the time, the reference and your number to change it. A booking made inside that window is not reminded — its confirmation already was.`
                    : "Texts are not switched on for Belline yet, so no reminders are going out. There is nothing to do on your side: they start the day texts are switched on, with the setting below."}
                </p>
                <RemindersForm locationId={venue.id} enabled={remindersEnabled(venue)} hours={reminderHours(venue)} />
              </div>
            </div>
          )}

          {/* Deposits, paid into the venue's own Stripe account. */}
          <div className="panel" style={{ marginBottom: 16 }}>
            <div className="panel-head">Deposits</div>
            <div style={{ padding: 18 }}>
              <p className="muted" style={{ fontSize: 13, lineHeight: 1.6, maxWidth: "68ch", margin: 0 }}>
                {takesRequestsOnly(venue)
                  ? "Your deposit rule applies to bookings Belline makes. Belline takes booking requests at the moment, so no deposit is recorded or asked for: your team arranges it when they confirm."
                  : !venue.policy?.deposit
                  ? "No deposit rule is set. Add one under How it works — who pays, how much, on which days — and Belline tells callers about it when they book."
                  : !stripeConfigured()
                    ? "Belline tells callers about your deposit when they book, and the booking is marked as owing it. Card payments are not switched on yet, so your team sends the link and marks it paid in Bookings."
                    : depositsReady(paymentsVenue)
                      ? "Connected. When a booking needs a deposit, the guest is texted a Stripe link straight away, and the money goes to your own Stripe account. Paid deposits are marked in Bookings on their own."
                      : "Connect your own Stripe account and guests are texted a link to pay the deposit the moment they book. The money goes to your account, not ours — Stripe checks who you are and where to pay out."}
              </p>
              {!takesRequestsOnly(venue) && venue.policy?.deposit && stripeConfigured() && !depositsReady(paymentsVenue) && (
                <a className="btn btn-accent" href={`/api/payments/connect?locationId=${venue.id}`} style={{ display: "inline-block", marginTop: 14 }}>
                  {paymentsVenue.payments?.stripeAccountId ? "Finish setting up Stripe" : "Set up card payments with Stripe"}
                </a>
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}

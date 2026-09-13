import Link from "next/link";
import { requireUser, resolveLocation } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import { seedIfEmpty } from "@/lib/seed";
import { connectionState, googleConfigured } from "@/lib/integrations/google";
import { venueWhatsApp, whatsappConfigured } from "@/lib/whatsapp";
import { provisioningReady } from "@/lib/whatsapp-provision";
import { LocationTabs, PageHeader } from "@/components/LocationTabs";
import ConnectWhatsApp from "./ConnectWhatsApp";

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
  searchParams: Promise<{ loc?: string; connected?: string; error?: string }>;
}) {
  seedIfEmpty();
  const user = await requireUser();
  const { loc, connected, error } = await searchParams;
  const location = await resolveLocation(user, loc);
  if (!location) return <p className="muted">No venues are assigned to your account yet.</p>;

  const google = connectionState(location);
  const whatsapp = await venueWhatsApp(location);

  return (
    <>
      <PageHeader
        title="Integrations"
        subtitle="Belline decides availability. A connected calendar is where the team already looks, so bookings are mirrored into it."
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
          {error}
        </div>
      )}

      {/*
        WhatsApp, the second-number way: the venue keeps its own WhatsApp
        untouched and Belle answers a number we register for it. Connected by
        us, shown here, and honest when it is not.
      */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">WhatsApp</div>
        <div style={{ padding: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
            <span
              className="pill"
              style={
                whatsapp
                  ? { background: "var(--ok-soft)", color: "var(--ok)", borderColor: "var(--ok)" }
                  : undefined
              }
            >
              {whatsapp ? "Connected" : "Not connected"}
            </span>
            {whatsapp && (
              <span className="mono" style={{ fontSize: 13.5 }}>
                {whatsapp.phoneE164}
              </span>
            )}
          </div>
          {whatsapp ? (
            <p className="muted" style={{ fontSize: 13, lineHeight: 1.6, maxWidth: "68ch", margin: 0 }}>
              Belline answers this number on WhatsApp — questions, bookings, changes — and every
              thread is in your inbox. Put it on your website, your Google profile and your
              Instagram as &ldquo;WhatsApp us&rdquo;. Your own WhatsApp is untouched.
            </p>
          ) : whatsappConfigured() && provisioningReady() && !location.demo?.enabled ? (
            <>
              <p className="muted" style={{ fontSize: 13, lineHeight: 1.6, maxWidth: "68ch", margin: 0 }}>
                Belline can answer a WhatsApp number for {location.name} — a second number, so your
                own WhatsApp stays exactly as it is. Type the number, type the code Meta texts to
                it, done: about a minute, no Meta account, nothing to install.
              </p>
              <ConnectWhatsApp
                locationId={location.id}
                venueName={location.name}
                pending={
                  location.whatsappPending
                    ? { number: location.whatsappPending.number, displayName: location.whatsappPending.displayName }
                    : null
                }
              />
            </>
          ) : (
            <p className="muted" style={{ fontSize: 13, lineHeight: 1.6, maxWidth: "68ch", margin: 0 }}>
              Belline can answer a WhatsApp number for {location.name} — a second number, so your
              own WhatsApp stays exactly as it is. We register it and connect it for you; there is
              nothing to install. <a href="mailto:hello@belline.ai?subject=WhatsApp%20for%20my%20venue">Email us</a> and
              it is usually live the same day.
            </p>
          )}
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

          <p className="muted" style={{ fontSize: 13, lineHeight: 1.6, maxWidth: "68ch" }}>
            Bookings are written into the venue&apos;s calendar as they happen — one way.
            Belline stays in charge of availability, because it knows things a calendar
            cannot: which practitioner is qualified, how many covers the kitchen can take at
            eight, that the chair is held for ten minutes after the guest leaves. An event
            dragged about in Google does not change the booking, and the event text says so.
          </p>

          {googleConfigured() ? (
            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <a className="btn btn-accent" href={`/api/integrations/google?locationId=${location.id}`}>
                {google.connected ? "Reconnect" : "Connect Google Calendar"}
              </a>
              {google.connected && (
                <Link className="btn" href={`/calendar?loc=${location.id}`}>
                  See the diary
                </Link>
              )}
            </div>
          ) : (
            <p style={{ fontSize: 12.5, color: "var(--warn)", marginTop: 14 }}>
              Google Calendar isn&apos;t available on this account yet.
              {isBellineStaff(user) && (
                <span className="muted"> (Ours to fix: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.)</span>
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

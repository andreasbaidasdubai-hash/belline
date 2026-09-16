import type { Metadata } from "next";
import { verifyBookingToken } from "@/lib/auth";
import { getBooking, getLocation } from "@/lib/store";
import { manageable, whatWasBooked, withWhom } from "@/lib/booking/manage";
import { lateCancelNotice } from "@/lib/booking/policy";
import { dateToSpoken, minutesToSpoken } from "@/lib/time";
import ManageBooking from "./ManageBooking";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your booking",
  robots: { index: false, follow: false },
};

/** The page behind "Change or cancel" in a guest's confirmation. */
export default async function BookingPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const bookingId = verifyBookingToken(token);
  const booking = bookingId ? getBooking(bookingId) : undefined;
  const location = booking ? getLocation(booking.locationId) : undefined;

  const shell = (children: React.ReactNode) => (
    <main style={{ minHeight: "100vh", background: "var(--bl-ground)", color: "var(--bl-ink-900)", padding: "48px 20px" }}>
      <div style={{ maxWidth: 520, margin: "0 auto" }}>{children}</div>
    </main>
  );

  if (!booking || !location) {
    return shell(
      <>
        <h1 style={{ fontFamily: "var(--bl-font-display)", fontWeight: 700, fontSize: 32 }}>This link does not work.</h1>
        <p style={{ color: "var(--bl-text-2)", fontSize: 16 }}>Check you opened the whole link from your confirmation, or call the venue.</p>
      </>,
    );
  }

  const state = manageable(location, booking);
  const who = withWhom(location, booking);
  const rows: [string, string][] = [
    ["What", whatWasBooked(location, booking)],
    ...(who ? ([["With", who]] as [string, string][]) : []),
    ["When", `${dateToSpoken(booking.date, location.timezone)} at ${minutesToSpoken(booking.startMin)}`],
    ["Where", location.address || location.name],
    ["Reference", booking.ref],
  ];

  return shell(
    <>
      <p style={{ fontSize: 11.5, letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--bl-indigo)", margin: 0 }}>
        {location.name}
      </p>
      <h1 style={{ fontFamily: "var(--bl-font-display)", fontWeight: 700, fontSize: 34, lineHeight: 1.1, margin: "12px 0 22px" }}>
        {booking.status === "cancelled" ? "This booking is cancelled." : "Your booking"}
      </h1>

      <dl style={{ display: "grid", gridTemplateColumns: "96px 1fr", rowGap: 10, margin: 0, fontSize: 15.5 }}>
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: "contents" }}>
            <dt style={{ color: "var(--bl-muted)" }}>{k}</dt>
            <dd style={{ margin: 0 }}>{v}</dd>
          </div>
        ))}
      </dl>

      {booking.deposit?.status === "required" && booking.status === "confirmed" && (
        <p style={{ marginTop: 18, fontSize: 14.5, color: "var(--bl-text-2)" }}>
          A {booking.deposit.currency} {booking.deposit.amount} deposit is due.{" "}
          {booking.deposit.link && <a href={booking.deposit.link}>Pay it now</a>}
        </p>
      )}

      {state.ok ? (
        <ManageBooking
          token={token}
          calendarHref={`/b/${token}/calendar.ics`}
          policy={lateCancelNotice(location)}
          phone={location.businessPhone}
          venueName={location.name}
        />
      ) : (
        <p style={{ marginTop: 24, color: "var(--bl-text-2)", fontSize: 15 }}>
          {state.why} {location.businessPhone ? `For anything else, call ${location.name} on ${location.businessPhone}.` : ""}
        </p>
      )}
    </>,
  );
}

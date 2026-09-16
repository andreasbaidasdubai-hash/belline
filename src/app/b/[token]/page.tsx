import type { Metadata } from "next";
import { verifyBookingToken } from "@/lib/auth";
import { getBooking, getLocation } from "@/lib/store";
import { bookingWhen, manageable, whatWasBooked, withWhom } from "@/lib/booking/manage";
import { lateCancelNotice } from "@/lib/booking/policy";
import { answersIn, inHouseSpelling } from "@/lib/language";
import { MANAGE_KEYS, copy, copyTable, type CopyKey } from "@/lib/customer-copy";
import ManageBooking from "./ManageBooking";

export const dynamic = "force-dynamic";

/** In the guest's language where the link names a venue; English where it names nothing. */
export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params;
  const bookingId = verifyBookingToken(token);
  const booking = bookingId ? getBooking(bookingId) : undefined;
  const location = booking ? getLocation(booking.locationId) : undefined;
  return {
    title: copy(location ? answersIn(location) : "en", "manage.page_title"),
    robots: { index: false, follow: false },
  };
}

function spelled<K extends string>(table: Record<K, string>, spell: (text: string) => string): Record<K, string> {
  return Object.fromEntries(Object.entries<string>(table).map(([k, v]) => [k, spell(v)])) as Record<K, string>;
}

/** The page behind "Change or cancel" in a guest's confirmation. */
export default async function BookingPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const bookingId = verifyBookingToken(token);
  const booking = bookingId ? getBooking(bookingId) : undefined;
  const location = booking ? getLocation(booking.locationId) : undefined;

  const shell = (children: React.ReactNode, lang = "en") => (
    <main lang={lang === "en" ? undefined : lang} style={{ minHeight: "100vh", background: "var(--bl-ground)", color: "var(--bl-ink-900)", padding: "48px 20px" }}>
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

  const language = answersIn(location);
  const t = (key: CopyKey, vars?: Record<string, string | number>) => inHouseSpelling(location, copy(language, key, vars));
  const state = manageable(location, booking, Date.now(), language);
  const who = withWhom(location, booking);
  const rows: [string, string][] = [
    [t("booking.label_what"), whatWasBooked(location, booking, language)],
    ...(who ? ([[t("booking.label_with"), who]] as [string, string][]) : []),
    [t("booking.label_when"), bookingWhen(location, booking, language)],
    [t("booking.label_where"), location.address || location.name],
    [t("booking.label_reference"), booking.ref],
  ];

  return shell(
    <>
      <p style={{ fontSize: 11.5, letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--bl-indigo)", margin: 0 }}>
        {location.name}
      </p>
      <h1 style={{ fontFamily: "var(--bl-font-display)", fontWeight: 700, fontSize: 34, lineHeight: 1.1, margin: "12px 0 22px" }}>
        {booking.status === "cancelled" ? t("manage.is_cancelled") : t("manage.heading")}
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
          {t("manage.deposit_due", { currency: booking.deposit.currency, amount: booking.deposit.amount })}{" "}
          {booking.deposit.link && <a href={booking.deposit.link}>{t("manage.pay_now")}</a>}
        </p>
      )}

      {state.ok ? (
        <ManageBooking
          token={token}
          calendarHref={`/b/${token}/calendar.ics`}
          policy={lateCancelNotice(location, language)}
          phone={location.businessPhone}
          venueName={location.name}
          language={language}
          copy={spelled(copyTable(language, MANAGE_KEYS), (text) => inHouseSpelling(location, text))}
        />
      ) : (
        <p style={{ marginTop: 24, color: "var(--bl-text-2)", fontSize: 15 }}>
          {state.why} {location.businessPhone ? t("manage.anything_else", { name: location.name, phone: location.businessPhone }) : ""}
        </p>
      )}
    </>,
    language,
  );
}

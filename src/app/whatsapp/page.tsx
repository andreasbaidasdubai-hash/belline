import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connectedWhatsAppLink } from "@/lib/embed";
import { siteOrigin } from "@/lib/origin";
import { seedIfEmpty } from "@/lib/seed";
import { BELLINE_LOCATION_ID } from "@/lib/seed-belline";
import { getLocation } from "@/lib/store";
import { venueWhatsApp } from "@/lib/whatsapp";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "WhatsApp Belle",
  robots: { index: false, follow: false },
};

/**
 * Where the "WhatsApp Belle" button goes.
 *
 * A static website cannot know whether a number has been connected since it
 * was built. This page can, so the button on the site points here, and here
 * decides: straight to WhatsApp when Belline's own number is connected and
 * active — the same test the widget config uses, so the icon and this page
 * never disagree — and otherwise a page that explains what WhatsApp answering
 * is and offers the two things that work right now: chatting with Belle on the
 * website, or getting started. It never sends somebody to a number nobody is
 * answering, and it is never a dead end.
 *
 * Production has the number connected. Staging and previews do not, which is
 * why they show the page.
 */
export default async function WhatsAppPage() {
  seedIfEmpty();
  const venue = getLocation(BELLINE_LOCATION_ID);
  const account = venue ? await venueWhatsApp(venue).catch(() => null) : null;
  const link = connectedWhatsAppLink(account);
  if (link) {
    redirect(`${link}?text=${encodeURIComponent("Hi Belle")}`);
  }

  const site = siteOrigin();

  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "grid",
        placeItems: "center",
        padding: 24,
        background: "var(--bl-ground)",
        color: "var(--bl-ink-900)",
        fontFamily: "var(--bl-font-text)",
      }}
    >
      <div style={{ maxWidth: 480 }}>
        <p
          style={{
            margin: 0,
            fontSize: 11.5,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: "var(--bl-indigo)",
          }}
        >
          WhatsApp Belle
        </p>
        <h1
          style={{
            fontFamily: "var(--bl-font-display)",
            fontWeight: 700,
            fontSize: 34,
            lineHeight: 1.1,
            letterSpacing: "-0.02em",
            margin: "12px 0 16px",
          }}
        >
          Belle&rsquo;s WhatsApp isn&rsquo;t connected here.
        </h1>
        <p style={{ fontSize: 16, lineHeight: 1.55, margin: 0, color: "var(--bl-text-2)" }}>
          For businesses, Belline answers WhatsApp on a second number you register with it: we set
          it up with you, and your own WhatsApp stays as it is. It replies from your information
          and passes requests to your team.
        </p>
        <p style={{ fontSize: 16, lineHeight: 1.55, margin: "12px 0 0", color: "var(--bl-text-2)" }}>
          To see how Belle answers, chat with her on the website. It&rsquo;s the same receptionist.
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 24 }}>
          <a
            href={`${site}/?chat=1`}
            style={{
              padding: "13px 22px",
              borderRadius: 999,
              background: "var(--bl-ink-900)",
              color: "var(--bl-ground)",
              textDecoration: "none",
              fontWeight: 500,
            }}
          >
            Chat with Belle on the website
          </a>
          <a
            href="/checkout"
            style={{
              padding: "13px 22px",
              borderRadius: 999,
              border: "1px solid rgba(17,17,17,.22)",
              color: "var(--bl-ink-900)",
              textDecoration: "none",
              fontWeight: 500,
            }}
          >
            Get started
          </a>
        </div>
        <p style={{ fontSize: 13, color: "var(--bl-muted)", marginTop: 22 }}>
          Or <a href="/call?start=1" style={{ color: "inherit" }}>talk to Belle</a> in your browser.
        </p>
      </div>
    </main>
  );
}

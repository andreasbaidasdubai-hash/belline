import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { whatsappConfigured, whatsappLink } from "@/lib/whatsapp";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "WhatsApp Belle",
  robots: { index: false, follow: false },
};

/**
 * Where the "WhatsApp Belle" button goes.
 *
 * A static website cannot know whether a number has been connected since it
 * was built. This page can, so the button on belline.ai points here, and
 * here decides: straight to WhatsApp when the number is live, and a plain
 * page that says it is not — with the two ways that *do* work — when it is
 * not. The one thing it never does is send somebody to a number nobody is
 * answering.
 */
export default function WhatsAppPage() {
  if (whatsappConfigured()) {
    redirect(whatsappLink("Hi Belle")!);
  }

  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "grid",
        placeItems: "center",
        padding: 24,
        background: "#FBF9F5",
        color: "#14110D",
        fontFamily: '"Instrument Sans", ui-sans-serif, system-ui, sans-serif',
      }}
    >
      <div style={{ maxWidth: 460 }}>
        <p
          style={{
            margin: 0,
            fontSize: 11.5,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: "#8A672E",
          }}
        >
          WhatsApp Belle
        </p>
        <h1
          style={{
            fontFamily: 'Fraunces, Georgia, serif',
            fontWeight: 400,
            fontSize: 34,
            lineHeight: 1.1,
            letterSpacing: "-0.02em",
            margin: "12px 0 16px",
          }}
        >
          Not on WhatsApp yet.
        </h1>
        <p style={{ fontSize: 16, lineHeight: 1.55, margin: 0, color: "#4A443C" }}>
          The WhatsApp line is built and runs on the same receptionist as everything else, but
          Meta&rsquo;s business verification has to clear before a number can answer. This
          page will take you straight to her the day it does. Until then, two ways that work
          right now:
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 24 }}>
          <a
            href="/call?start=1"
            style={{
              padding: "13px 22px",
              borderRadius: 999,
              background: "#14110D",
              color: "#FBF9F5",
              textDecoration: "none",
              fontWeight: 500,
            }}
          >
            Speak to Belle
          </a>
          <a
            href="https://belline.ai/#channels"
            style={{
              padding: "13px 22px",
              borderRadius: 999,
              border: "1px solid rgba(20,17,13,.22)",
              color: "#14110D",
              textDecoration: "none",
              fontWeight: 500,
            }}
          >
            Write with Belle on belline.ai
          </a>
        </div>
        <p style={{ fontSize: 13, color: "#746C63", marginTop: 22 }}>
          Or ring +1 571 778 5920 — an international call from the UAE.
        </p>
      </div>
    </main>
  );
}

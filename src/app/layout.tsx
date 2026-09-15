import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Belline — AI reception",
  description:
    "AI voice reception for restaurants, salons and clinics: answers the phone, checks real availability, books, changes and cancels.",
  icons: { icon: "/icon.svg", apple: "/icon.svg" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // No maximum scale: blocking pinch-zoom fails people who need larger text.
  // iOS zooming into a focused field is prevented with 16px inputs on touch
  // screens instead (globals.css).
  themeColor: "#F4F0E8",
};

/**
 * Only the document shell lives here. The signed-in chrome — sidebar,
 * navigation, the user block — is in `(app)/layout.tsx`, which is also where
 * the session is checked, so the login screen renders without any of it.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400..600&family=Instrument+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}

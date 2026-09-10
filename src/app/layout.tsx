import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Belline — AI voice receptionist",
  description:
    "Proprietary AI voice agent for restaurants and salons: answers the phone, checks real availability, books, changes and cancels.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // The console has a fixed input row at the bottom; letting the page zoom
  // out on a phone would push it off screen.
  maximumScale: 1,
  themeColor: "#FBFAF8",
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
          href="https://fonts.googleapis.com/css2?family=Manrope:wght@300;400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}

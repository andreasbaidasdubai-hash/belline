/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The voice bridge runs in the custom server (server.mjs), not in a route
  // handler, so nothing here needs edge runtime.
  serverExternalPackages: ["ws"],

  /**
   * Addresses the dashboard retired on 2026-09-17, and where each one lives now.
   *
   * The menu was rebuilt around what an owner does (Home, Inbox, Your business,
   * Channels, Calendars, Settings), and several pages became tabs of those. An
   * old bookmark, an email already sent, a link in a help article or a fix URL
   * on an old exception must still land somewhere useful, never a 404. The
   * query string is carried across, so ?loc= and ?from=setup survive.
   *
   * Temporary (307), not permanent: a browser caches a 308 for good, and the
   * next time a page moves the cached answer would win.
   */
  async redirects() {
    return [
      // "Everything else" held what the menu had not decided about. Every page
      // in it now has a place, so the page itself is gone.
      { source: "/advanced", destination: "/", permanent: false },
      // What the reports said worth saying is on Home now.
      { source: "/reports", destination: "/", permanent: false },
      { source: "/test", destination: "/channels", permanent: false },
      { source: "/website", destination: "/channels/website", permanent: false },
      { source: "/golive", destination: "/channels/phone", permanent: false },
      { source: "/integrations", destination: "/calendars", permanent: false },
      { source: "/settings", destination: "/locations", permanent: false },
      // The setup step "Phone and website" became two steps.
      { source: "/setup/channels", destination: "/setup/website", permanent: false },

      // The staff console was rebuilt on 2026-09-17 around Today, Leads,
      // Customers, Issues, Revenue and Settings. Old bookmarks land on the
      // page that does the same job now.
      { source: "/sales/clients", destination: "/sales/customers", permanent: false },
      { source: "/sales/enquiries", destination: "/sales/leads?source=enquiry", permanent: false },
      { source: "/sales/approvals", destination: "/sales/leads?view=drafts", permanent: false },
      { source: "/sales/exceptions", destination: "/sales/issues", permanent: false },
      { source: "/sales/abuse", destination: "/sales/customers?view=flagged", permanent: false },
      { source: "/sales/activity", destination: "/sales/settings/activity", permanent: false },
      { source: "/sales/video", destination: "/sales/settings/video", permanent: false },
      { source: "/sales/agents/:id", destination: "/sales/settings/agents/:id", permanent: false },
      // Staff tools that sat in the customer dashboard. Exactly /demo: the
      // public demo pages under /demo/<slug> are untouched.
      { source: "/demo", destination: "/sales/settings/demo-lines", permanent: false },
      { source: "/prospects", destination: "/sales/leads?build=1", permanent: false },
    ];
  },

  async headers() {
    return [
      {
        /**
         * Only /call may be framed, and only by our own marketing site.
         *
         * The bell on belline.ai opens this in a panel, which means the app
         * has to permit being embedded — but permitting it everywhere would
         * hand an attacker the dashboard in an invisible iframe, which is
         * what clickjacking is. So the allowance is one path wide.
         */
        source: "/call",
        headers: [
          {
            key: "Content-Security-Policy",
            value:
              "frame-ancestors 'self' https://belline.ai https://www.belline.ai",
          },
        ],
      },
      {
        /**
         * Everything else: not framable at all.
         *
         * frame-ancestors is the modern control and beats X-Frame-Options
         * where both are understood, but the older header is still what some
         * corporate proxies enforce, so both are sent.
         */
        source: "/:path((?!call$).*)",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

/*
 * A note for whoever builds this on a Windows machine next.
 *
 * This checkout lives inside OneDrive, which turns synced files into cloud
 * placeholders — reparse points that Node's `readlink` rejects with EINVAL.
 * Next writes thousands of small files into .next and reads them straight
 * back, so a sync pass landing mid-build fails it on a file that plainly
 * exists: "Cannot find module for page: /billing", ENOENT, moments after the
 * same build said "Compiled successfully". It fails on a different page each
 * time, which is the tell.
 *
 * Two obvious fixes do not work, so do not spend the afternoon on them again:
 *
 *   `distDir` outside the tree breaks the tsconfig path that resolves
 *   .next/types, and type-checking fails instead.
 *
 *   A junction from .next to somewhere outside OneDrive breaks module
 *   resolution: Node resolves from the *real* path, walks up from
 *   %LOCALAPPDATA%\Temp looking for node_modules, and cannot find
 *   react/jsx-runtime.
 *
 * What actually fixes it is excluding the folder from syncing, in the OneDrive
 * settings, or keeping the checkout outside OneDrive altogether. Until then:
 * re-run the build, it passes roughly every other attempt.
 *
 * Railway builds in a container with no OneDrive, so production never sees
 * any of this.
 */

export default nextConfig;

/**
 * The old location-landing-page URLs, and where they went.
 *
 * The first three landing pages shipped as `/ai-receptionist/<trade>/<city>`,
 * with city hubs at `/ai-receptionist/in/<city>`. The September 2026 keyword
 * research (docs/seo/uae-keywords.md) changed the shape to
 * `/{framing}/{trade}/{country}/{city}`, for two reasons that are both about
 * the next country rather than this one: city slugs are not globally unique
 * (London Ontario, Newcastle, Springfield), and the framing was baked into the
 * root, so there was nowhere to put a WhatsApp-led page but a second site.
 *
 * The cost of that is this file: every URL that was ever published has to keep
 * resolving, permanently. It is deliberately a hand-written list of literals
 * rather than something derived — a derived redirect stops existing the day
 * somebody deletes the page it was derived from, which is exactly the day the
 * redirect starts mattering.
 *
 * It is read in three places, from this one table:
 *
 *   src/lib/marketing.ts   the app's own server, which serves the website
 *   scripts/build-site.ts  writes site/_redirects for Netlify
 *   vercel.json            checked against this list by npm run check:seo
 *
 * In `src/` rather than `scripts/` because the server is the one that has to
 * answer a request at two in the morning, and a runtime file should not have
 * to import a build script to do it.
 */

export interface SeoRedirect {
  from: string;
  to: string;
}

/** 301, permanently. Every one of these was a published, indexable URL. */
export const SEO_REDIRECTS: readonly SeoRedirect[] = [
  // The three landing pages of the first pass.
  { from: "/ai-receptionist/restaurants/dubai", to: "/ai-receptionist/restaurants/ae/dubai" },
  { from: "/ai-receptionist/hair-salons/sharjah", to: "/ai-receptionist/hair-salons/ae/sharjah" },
  { from: "/ai-receptionist/dental-clinics/london", to: "/ai-receptionist/dental-clinics/gb/london" },
  // And the city hubs above them, which were published in the same build.
  { from: "/ai-receptionist/in/dubai", to: "/ai-receptionist/in/ae/dubai" },
  { from: "/ai-receptionist/in/sharjah", to: "/ai-receptionist/in/ae/sharjah" },
  { from: "/ai-receptionist/in/london", to: "/ai-receptionist/in/gb/london" },
];

/** The destination for a path, or null when this is not an old URL. */
export function seoRedirectFor(pathname: string): string | null {
  const clean = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return SEO_REDIRECTS.find((r) => r.from === clean)?.to ?? null;
}

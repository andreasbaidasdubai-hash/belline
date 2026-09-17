import type { Business, Location } from "../types";
import { normaliseOwnerPhone } from "../phone";
import { DISPOSABLE_DOMAINS } from "./disposable-domains";

/**
 * What makes two accounts the same business, for one-trial-per-business.
 *
 * Three facts a business cannot cheaply change between signups: its website's
 * domain, its phone number and the card it pays with. Each is normalised so a
 * trivial variation ("www.", "https://", a trailing slash, spaces in a phone
 * number) is not a new business.
 *
 * Pure: no store, no flags. abuse/review.ts compares the keys.
 */

/**
 * Hosts shared by thousands of unrelated businesses. A link-in-bio page or an
 * Instagram profile says nothing about which business it is at the domain
 * level, so these are never a key.
 */
export const SHARED_HOSTS: readonly string[] = [
  "instagram.com",
  "facebook.com",
  "fb.com",
  "fb.me",
  "linktr.ee",
  "wa.me",
  "whatsapp.com",
  "tiktok.com",
  "x.com",
  "twitter.com",
  "youtube.com",
  "youtu.be",
  "linkedin.com",
  "snapchat.com",
  "pinterest.com",
  "t.me",
  "google.com",
  "goo.gl",
  "g.page",
  "g.co",
  "bit.ly",
  "linkin.bio",
  "lnk.bio",
  "taplink.cc",
  "beacons.ai",
  "bio.link",
  "calendly.com",
  "fresha.com",
  "booksy.com",
  "treatwell.com",
  "vagaro.com",
  "setmore.com",
  "square.site",
  "opentable.com",
  "sevenrooms.com",
  "tripadvisor.com",
  "yelp.com",
  "zomato.com",
  "talabat.com",
  "deliveroo.ae",
  "careem.com",
];

/**
 * Site builders that give each customer their own subdomain. For these the
 * whole host is the key (`marina-salon.wixsite.com`), never the platform.
 */
const PER_CUSTOMER_SUFFIXES: readonly string[] = [
  "wixsite.com",
  "business.site",
  "square.site",
  "myshopify.com",
  "webflow.io",
  "github.io",
  "vercel.app",
  "netlify.app",
  "carrd.co",
  "godaddysites.com",
  "squarespace.com",
  "wordpress.com",
  "blogspot.com",
  "framer.website",
  "notion.site",
];

/** Second-level labels under a two-letter country code: `salon.co.uk`, `clinic.com.au`. */
const SECOND_LEVEL = new Set(["co", "com", "net", "org", "gov", "ac", "edu", "ltd", "plc", "me", "sch"]);

const endsWith = (host: string, suffix: string) => host === suffix || host.endsWith(`.${suffix}`);

/**
 * The business's own domain, from whatever was typed: a URL, a bare host, a
 * link with a path. `null` for anything that is not a key: empty, not a
 * domain, an IP address, localhost, or a host shared by unrelated businesses.
 *
 *   https://www.Marina-Salon.ae/book  → marina-salon.ae
 *   book.marinasalon.com              → marinasalon.com
 *   marina.co.uk                      → marina.co.uk
 *   instagram.com/marinasalon         → null
 *   marina.wixsite.com/home           → marina.wixsite.com
 */
export function normaliseDomain(raw: string | undefined | null): string | null {
  const text = String(raw ?? "").trim().toLowerCase();
  if (!text || /\s/.test(text)) return null;
  let host: string;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(text) ? text : `https://${text}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/\.+$/, "").replace(/^www\d*\./, "");
  if (!host.includes(".")) return null;
  // IPv4, IPv6 and local names say nothing about a business.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[") || host.endsWith(".localhost") || host.endsWith(".local")) {
    return null;
  }
  if (!/^[a-z0-9.-]+$/.test(host)) return null;

  const platform = PER_CUSTOMER_SUFFIXES.find((s) => host !== s && host.endsWith(`.${s}`));
  if (platform) {
    const labels = host.slice(0, -platform.length - 1).split(".");
    return `${labels[labels.length - 1]}.${platform}`;
  }
  if (SHARED_HOSTS.some((s) => endsWith(host, s))) return null;

  // The registrable domain, without a public-suffix list: the last two labels,
  // or three under a country's second level (co.uk, com.au).
  const labels = host.split(".");
  const tld = labels[labels.length - 1];
  const sld = labels[labels.length - 2];
  const keep = labels.length >= 3 && tld.length === 2 && SECOND_LEVEL.has(sld) ? 3 : 2;
  return labels.slice(-keep).join(".");
}

/** A phone number as E.164, or null when it cannot be read as one. */
export function normalisePhone(raw: string | undefined | null): string | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const out = normaliseOwnerPhone(text.replace(/[\s()\-.]/g, ""), undefined);
  return out.ok ? out.e164 : null;
}

/** The email's domain is a throwaway mailbox provider. Parent domains count. */
export function isDisposableEmail(email: string, list: readonly string[] = DISPOSABLE_DOMAINS): boolean {
  const domain = String(email ?? "").trim().toLowerCase().split("@")[1]?.replace(/\.+$/, "");
  if (!domain) return false;
  return list.some((d) => endsWith(domain, d));
}

export interface BusinessKeys {
  domains: string[];
  phones: string[];
  cards: string[];
}

/**
 * Every key a venue carries: the websites it was set up from or put the widget
 * on, its business website, its own phone and its business's, and the
 * fingerprint of the card saved at Go live. `extra` adds what is about to be
 * saved, so a refusal can come before the write.
 */
export function keysOf(
  location: Pick<Location, "businessPhone" | "onboarding" | "stripe" | "embed">,
  business?: Pick<Business, "website" | "phone">,
  extra: { website?: string; phone?: string } = {},
): BusinessKeys {
  const domains = [
    extra.website,
    business?.website,
    ...(location.onboarding?.channels.web?.domains ?? []),
    ...(location.embed?.allowedOrigins ?? []),
  ]
    .map(normaliseDomain)
    .filter((d): d is string => Boolean(d));
  const phones = [extra.phone, location.businessPhone, business?.phone]
    .map(normalisePhone)
    .filter((p): p is string => Boolean(p));
  const cards = location.stripe?.cardFingerprint ? [location.stripe.cardFingerprint] : [];
  return { domains: [...new Set(domains)], phones: [...new Set(phones)], cards };
}

import { assertPublicUrl } from "../../prospect";

/**
 * Finding a company's published email address.
 *
 * Google Places returns a phone and a website and never an email, so without
 * this stage the outbound funnel has nobody to write to. No model is involved:
 * the address is printed on their contact page, and a regex reads it for a
 * thousandth of the cost of asking a model to.
 *
 * Only *published* addresses — the ones a business puts on its own site
 * inviting contact. Nothing here guesses `firstname@domain`, which is how
 * outbound tools generate bounces and, in the Gulf and Switzerland, a
 * data-protection problem. See COMPLIANCE.md §1.
 */

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/**
 * Addresses that appear on websites and belong to nobody useful: analytics
 * vendors, template boilerplate, image filenames that happen to contain an @.
 */
const JUNK = [
  /@(?:sentry|wixpress|squarespace|shopify|godaddy|wordpress|elementor|googlemail)\./i,
  /@(?:example|domain|yourdomain|email|test|sample)\./i,
  /@(?:sentry\.io|2x\.png|3x\.png)/i,
  /^(?:no-?reply|do-?not-?reply|postmaster|abuse|webmaster|hostmaster)@/i,
  /\.(?:png|jpe?g|gif|svg|webp|css|js)$/i,
  /^[0-9a-f]{16,}@/i,
];

/**
 * Preferred inboxes, best first.
 *
 * A reception or booking inbox is read by the person whose phone problem this
 * is. `info@` is read by everyone and nobody. An address at a free mail
 * provider is usually the owner's own and is often the best of the lot for a
 * small practice.
 */
const PREFERRED = [
  /^(?:reception|frontdesk|front\.desk|desk)@/i,
  /^(?:appointments?|booking|bookings|reservations?)@/i,
  /^(?:contact|hello|hi|enquir|inquir)/i,
  /^(?:info|mail|admin|office)@/i,
];

export interface FoundEmail {
  email: string;
  /** 0–1. Published on their own domain and role-shaped scores highest. */
  confidence: number;
  /** Where it was read from. */
  sourceUrl: string;
}

/**
 * Every plausible address in a page, ranked.
 *
 * Pure and exported, because the ranking is the part worth testing: picking
 * the wrong address means writing to a marketing agency's inbox instead of the
 * practice, and nothing downstream can tell.
 */
export function extractEmails(html: string, siteDomain: string | null, sourceUrl: string): FoundEmail[] {
  const seen = new Map<string, FoundEmail>();

  // `mailto:` first and separately: an address a business links is one it
  // intends to be written to, which is a stronger signal than one that merely
  // appears in the page text.
  const linked = new Set<string>();
  for (const match of html.matchAll(/mailto:([^"'?>\s]+)/gi)) {
    linked.add(decodeURIComponent(match[1]).trim().toLowerCase());
  }

  const candidates = new Set<string>([
    ...linked,
    ...[...html.matchAll(EMAIL_RE)].map((m) => m[0].trim().toLowerCase()),
  ]);

  for (const raw of candidates) {
    const email = raw.replace(/[.,;:)\]]+$/, "");
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) continue;
    if (JUNK.some((p) => p.test(email))) continue;
    if (seen.has(email)) continue;

    const domain = email.split("@")[1];
    const onSite = Boolean(siteDomain) && domain.endsWith(siteDomain!.replace(/^www\./, ""));

    let confidence = 0.35;
    if (onSite) confidence += 0.3;
    if (linked.has(email)) confidence += 0.15;

    const rank = PREFERRED.findIndex((p) => p.test(email));
    if (rank !== -1) confidence += 0.2 - rank * 0.03;

    // An address at a free provider is common for a small practice and is
    // often the owner's own — worth having, but it is not proof the site
    // belongs to them, so it does not get the on-domain bonus.
    if (/@(?:gmail|hotmail|outlook|yahoo|icloud)\./i.test(email)) confidence -= 0.1;

    seen.set(email, {
      email,
      confidence: Math.max(0.1, Math.min(1, Math.round(confidence * 100) / 100)),
      sourceUrl,
    });
  }

  return [...seen.values()].sort((a, b) => b.confidence - a.confidence);
}

/** Contact-ish pages, which is where an address almost always lives. */
const CONTACT_PATHS = ["/contact", "/contact-us", "/contactus", "/about", "/about-us", "/book"];

/**
 * Fetch a company's site and read its published address.
 *
 * Home page first, then a small number of contact-shaped paths — and it stops
 * the moment it finds something confident, because the home page footer
 * usually has it and the rest is wasted requests against someone's server.
 */
export async function findCompanyEmail(
  website: string,
  siteDomain: string | null,
): Promise<FoundEmail | null> {
  let base: URL;
  try {
    base = await assertPublicUrl(website);
  } catch {
    return null;
  }

  const tried = new Set<string>();
  const urls = [base.href, ...CONTACT_PATHS.map((p) => new URL(p, base).href)];
  let best: FoundEmail | null = null;

  for (const url of urls) {
    if (tried.has(url)) continue;
    tried.add(url);

    let html: string;
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "BellineResearchBot/1.0 (+https://belline.ai)",
          Accept: "text/html,application/xhtml+xml",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) continue;
      html = (await response.text()).slice(0, 400_000);
    } catch {
      continue;
    }

    const found = extractEmails(html, siteDomain, url);
    if (found.length === 0) continue;

    if (!best || found[0].confidence > best.confidence) best = found[0];
    // Good enough to stop: on their own domain and a role inbox.
    if (best.confidence >= 0.8) break;
  }

  return best;
}

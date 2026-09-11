import { assertPublicUrl, readSite } from "../../prospect";

/**
 * Reading a prospect's website.
 *
 * Built on `src/lib/prospect.ts`, which already does the two hard parts: a
 * DNS-resolving SSRF guard that refuses anything pointing inside our own
 * network, and HTML-to-text with an honest User-Agent and useful handling of
 * the 403s that bot-blockers return. This adds the part the personalised-demo
 * flow never needed — following a few links, because a clinic's home page
 * rarely says how many dentists work there or when it closes.
 *
 * Deliberately shallow. Six pages, one origin, sixty seconds. A crawler that
 * wanders is a crawler that gets us blocked, and the marginal page adds far
 * less than the first four.
 */

const MAX_PAGES = 6;
const BUDGET_MS = 60_000;

/**
 * The pages that actually carry buying signals, best first.
 *
 * Ordered by what the research agent needs: what they do, who does it, when
 * they are open, how you book. Matched against both the URL and the link text,
 * because a Dubai clinic is as likely to label it "Our Doctors" as "/team".
 */
const WANTED: { key: string; patterns: RegExp[] }[] = [
  { key: "services", patterns: [/服务|services?|treatments?|procedures?|price|pricing|fees/i] },
  { key: "team", patterns: [/team|doctors?|dentists?|staff|practitioners?|our-people|about-us|about/i] },
  { key: "contact", patterns: [/contact|location|find-us|branches?|clinics?|visit/i] },
  { key: "booking", patterns: [/book|appointment|reservation|schedule|enquir|request/i] },
  { key: "hours", patterns: [/hours?|opening|timing|schedule/i] },
];

export interface CrawledPage {
  url: string;
  text: string;
  /** Which of the WANTED buckets this page was fetched for. */
  role: string;
}

export interface CrawlResult {
  pages: CrawledPage[];
  /** Every URL actually fetched — the evidence whitelist. */
  fetched: string[];
  /** Set when the site could not be read at all. */
  failure?: string;
}

/**
 * Candidate links from a page, ranked.
 *
 * Pure and exported because the ranking is the interesting part and a bad
 * ranking wastes five of the six fetches on a privacy policy.
 */
export function pickLinks(html: string, base: URL, limit: number): { url: string; role: string }[] {
  const origin = base.origin;
  const seen = new Set<string>([normalise(base.href)]);
  const found: { url: string; role: string; rank: number }[] = [];

  // Deliberately a regex rather than a DOM parse: this runs over untrusted
  // HTML from thousands of sites and needs no dependency to do it.
  const anchor = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi;

  for (const match of html.matchAll(anchor)) {
    const [, href, inner] = match;
    if (/^(mailto:|tel:|javascript:|data:)/i.test(href)) continue;

    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      continue;
    }

    // Same origin only. A clinic's Instagram is not its website, and following
    // off-site links is how a crawler turns into a liability.
    if (url.origin !== origin) continue;
    if (/\.(pdf|jpe?g|png|gif|svg|webp|mp4|zip|docx?)$/i.test(url.pathname)) continue;

    const key = normalise(url.href);
    if (seen.has(key)) continue;

    const text = inner.replace(/<[^>]+>/g, " ").trim();
    const haystack = `${url.pathname} ${text}`;

    const index = WANTED.findIndex((w) => w.patterns.some((p) => p.test(haystack)));
    if (index === -1) continue;

    seen.add(key);
    found.push({ url: url.href, role: WANTED[index].key, rank: index });
  }

  // One page per role before a second of any role — breadth beats depth when
  // the budget is six fetches and each role answers a different question.
  found.sort((a, b) => a.rank - b.rank);
  const perRole = new Set<string>();
  const primary = found.filter((f) => !perRole.has(f.role) && perRole.add(f.role));
  return [...primary, ...found.filter((f) => !primary.includes(f))].slice(0, limit);
}

function normalise(href: string): string {
  return href.replace(/\/+$/, "").replace(/^https?:\/\//, "").toLowerCase();
}

/**
 * Read a company's site: home page, then up to five signal-bearing pages.
 *
 * Never throws for an unreadable site. A clinic behind Cloudflare is a normal
 * outcome, and the research agent is expected to say "the site could not be
 * read" rather than the pipeline losing the lead — so the failure is data.
 */
export async function crawlSite(website: string): Promise<CrawlResult> {
  const started = Date.now();
  const pages: CrawledPage[] = [];
  const fetched: string[] = [];

  let home: { url: URL; text: string; html: string };
  try {
    const url = await assertPublicUrl(website);
    const read = await readSite(url.href);
    home = { url: read.url, text: read.text, html: "" };
    pages.push({ url: read.url.href, text: read.text, role: "home" });
    fetched.push(read.url.href);
  } catch (err) {
    return { pages: [], fetched: [], failure: (err as Error).message };
  }

  // `readSite` returns text, not markup, so the links have already been
  // stripped. Fetch the home page once more for its HTML — one extra request
  // against a site we have just proven is reachable and public.
  let html = "";
  try {
    const response = await fetch(home.url, {
      headers: {
        "User-Agent": "BellineResearchBot/1.0 (+https://belline.ai)",
        Accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (response.ok) html = (await response.text()).slice(0, 400_000);
  } catch {
    // Home text is already captured; links are a bonus, not a requirement.
  }

  for (const link of pickLinks(html, home.url, MAX_PAGES - 1)) {
    if (pages.length >= MAX_PAGES) break;
    if (Date.now() - started > BUDGET_MS) break;

    try {
      const read = await readSite(link.url);
      pages.push({ url: read.url.href, text: read.text, role: link.role });
      fetched.push(read.url.href);
    } catch {
      // One unreadable sub-page is not a failed crawl.
    }
  }

  return { pages, fetched };
}

/**
 * The pages as one prompt-sized document.
 *
 * Capped, because a restaurant with a 40,000-word menu page would otherwise
 * set the token cost of every research call. The home page is never truncated
 * away — it is the one that names the business.
 */
export function asDocument(result: CrawlResult, maxChars = 45_000): string {
  const perPage = Math.floor(maxChars / Math.max(1, result.pages.length));
  return result.pages
    .map((p) => `--- ${p.role.toUpperCase()} · ${p.url}\n${p.text.slice(0, perPage)}`)
    .join("\n\n");
}

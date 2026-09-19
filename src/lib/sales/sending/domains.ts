/**
 * The domains we send cold mail from. The list, once.
 *
 * Everything else about a sending domain is per-deployment and lives in the
 * database — its provider, its mailboxes, its warm-up date, whether it is
 * paused (`store.ts`). What does *not* vary by deployment is which domains we
 * bought, and that fact has three readers who must never disagree:
 *
 *  - the engine, which says out loud when a domain we own has not been added
 *    to this deployment yet, instead of quietly sending from three of four;
 *  - `scripts/build-site.ts`, which builds one small public page per domain,
 *    because a sending domain that resolves to nothing is a spam signal and a
 *    recipient who types it into a browser is owed something credible;
 *  - `src/lib/marketing.ts`, which serves that page when a request arrives
 *    addressed to one of them.
 *
 * A second copy of these four strings would drift, and the direction it would
 * drift in is the one where we start sending from a domain whose page does not
 * exist — which is the exact failure the pages were built to prevent.
 *
 * belline.ai is deliberately absent and must stay absent. It carries the
 * product's transactional mail: verification codes, password resets, booking
 * confirmations. One spam complaint against a cold campaign sent from it and a
 * customer stops receiving their booking confirmations. `provider.ts` refuses
 * the provider that carries it; this list refuses the domain.
 */

export interface SendingDomainInfo {
  /** The registrable domain, lower case, no scheme and no trailing dot. */
  readonly domain: string;
  /**
   * Where this page's visitor is sent for the real thing. Always belline.ai:
   * these domains carry mail, not the product.
   */
  readonly site: "https://belline.ai";
}

/**
 * The four we own, in the order they were registered.
 *
 * All four have SES DKIM, SPF, DMARC and MX in place. Adding a fifth is an
 * edit here plus `npm run domain:setup`; the page, the serving and the check
 * follow from this list without further work.
 */
export const SENDING_DOMAINS: readonly SendingDomainInfo[] = [
  { domain: "trybelline.com", site: "https://belline.ai" },
  { domain: "getbelline.com", site: "https://belline.ai" },
  { domain: "bellineai.com", site: "https://belline.ai" },
  { domain: "hellobelline.com", site: "https://belline.ai" },
];

/** Just the names, for the places that only need strings. */
export const SENDING_DOMAIN_NAMES: readonly string[] = SENDING_DOMAINS.map((d) => d.domain);

/**
 * The domain a `Host:` header names, if it is one of ours.
 *
 * The port is dropped, the case is folded, and `www.` is accepted — a
 * recipient who types the domain into a browser may well be handed the `www`
 * by their own autocomplete, and a blank page there defeats the point.
 * Returns null for anything else, including belline.ai.
 */
export function sendingDomainFor(host: string | undefined): SendingDomainInfo | null {
  if (!host) return null;
  let name = host.split(":")[0].trim().toLowerCase().replace(/\.$/, "");
  if (name.startsWith("www.")) name = name.slice(4);
  return SENDING_DOMAINS.find((d) => d.domain === name) ?? null;
}

/** Is this one of ours? */
export function isSendingDomain(host: string | undefined): boolean {
  return sendingDomainFor(host) !== null;
}

/**
 * Where the built page for a domain lives inside `site/`.
 *
 * A directory per domain rather than one page that reads its own hostname at
 * runtime: the pages are static files served by a static file server, and a
 * page that has to guess which domain it is on is a page that can be wrong.
 */
export function senderPageDir(domain: string): string {
  return `sender/${domain}`;
}

export function senderPageFile(domain: string): string {
  return `${senderPageDir(domain)}/index.html`;
}

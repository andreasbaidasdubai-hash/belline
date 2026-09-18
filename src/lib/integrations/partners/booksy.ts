import { closedConnector } from "./closed";
import { PARTNERS } from "./registry";

/**
 * Booksy. There is an API, and it will not be shown to us.
 *
 * Fresha's neighbour on this list, and the distinction between them is the
 * whole value of this file. Fresha publishes no API at all, so the ask is
 * "would you build one". Booksy's own documentation host — `docs.booksy.com`,
 * and its sibling `alpha.docs.booksy.net` — resolves and answers **401
 * Unauthorized**. A gated, Booksy-owned reference exists. So the ask is
 * concrete and much smaller: provision a documentation account.
 *
 * Everything else is absent. `developers.booksy.com` and `api.booksy.com`
 * resolve only to redirect to the consumer marketplace; `booksy.com/en-us/partners`
 * is a 404; and nothing on booksy.com, biz.booksy.com or the help centre
 * mentions an API, a developer programme, an application form or a developer
 * contact address. Every Booksy integration that exists — Reserve with Google,
 * Google AI Mode, Instagram, Facebook, Yelp — is one Booksy built itself and
 * announces as its own work, and there is no third-party app marketplace to
 * publish into. That pattern suggests access is given to partners Booksy
 * chose, not to applicants.
 *
 * **The trap, recorded so nobody re-finds it cold and trusts it.** Precisely
 * because the real reference is behind a 401, third-party API directories
 * publish confident reconstructions of it: a `https://<country>.booksy.com/public-api/`
 * base URL, ninety-odd endpoints, an RS256 partner-keypair JWT exchanged for a
 * five-minute access token, and exact rate limits. None of it is Booksy's.
 * Their authors could not open that page either. It is the most plausible-looking
 * thing a future implementer could build against by mistake, and `check:booksy`
 * fails if any of it appears in this repository.
 *
 * **What the founder would have to do:** approach Booksy commercially and ask
 * to be provisioned a documentation account. There is no form and no email
 * published for it, so it goes through their general contact or support
 * channels and may not be answered. Until it is, a salon on Booksy is one where
 * Belline takes the request and the team confirms.
 */
export const booksyConnector = closedConnector(PARTNERS.booksy);

import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { applySiteFlags, swissSpelling } from "./site-flags";
import { sendingDomainFor, senderPageFile } from "./sales/sending/domains";
import { applyIntegrations } from "../../scripts/site-integrations";

/**
 * Serving the marketing site from the app's own process.
 *
 * These are two products on one origin only by accident of hosting: the
 * dashboard is a Next application that needs a live process, and the
 * marketing site is eight static files. They were split across two hosts,
 * which was fine until the static host's build allowance ran out and every
 * push was accepted by git and then silently ignored — the site stayed up,
 * frozen, for hours, with no failure anywhere to notice.
 *
 * So the process that is already running serves both, chosen by hostname:
 * `app.` is the product, anything else is the website. One deploy, one bill,
 * one thing to check when something is stale.
 *
 * Static files only. Nothing here touches the store, the agent or a session —
 * a request that reaches this function never reaches the application at all.
 */

const ROOT = "site";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  // robots.txt, llms.txt and the sitemap. Without these they were served as
  // application/octet-stream under `nosniff`, which is a download rather than
  // something to read — and llms.txt exists to be read.
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".woff2": "font/woff2",
};

/** Immutable content gets a year; pages must not, or a fix cannot reach anyone. */
function cacheFor(ext: string): string {
  if (ext === ".html") return "public, max-age=0, must-revalidate";
  if (ext === ".mp3" || ext === ".jpg" || ext === ".jpeg" || ext === ".png" || ext === ".webp") {
    // Content-addressed clips and versioned imagery.
    return "public, max-age=31536000, immutable";
  }
  return "public, max-age=3600";
}

/**
 * A built page as this server's flags say it: the integrations strip's tags
 * (scripts/site-integrations.ts) and the hand-written flag copy
 * (site-flags.ts). The same functions the build ran, again, because the image
 * was built without the service's variables and would otherwise say "Coming
 * soon" whatever the flag is. `index.html` at the root is the landing page.
 */
export function pageWithFlags(relPath: string, bytes: Buffer, env: Record<string, string | undefined> = process.env): Buffer {
  const name = relPath.split(path.sep).join("/");
  const german = germanSourceOf(name);
  const source = german?.source ?? (name === "index.html" ? "landing.html" : name);
  const spelling = german?.swiss ? swissSpelling : undefined;
  const html = bytes.toString("utf8");
  let out = applySiteFlags(source, html, env, spelling);
  if ((source === "landing.html" || source === "landing.de.html") && out.includes("<!-- integrations:start") && out.includes("<!-- integrations:end -->")) {
    out = applyIntegrations(out, env, source === "landing.de.html" ? "de" : "en");
  }
  out = pointAtThisApp(out, env);
  return out === html ? bytes : Buffer.from(out, "utf8");
}

const PRODUCTION_APP = "https://app.belline.ai";

/**
 * Links to the product point at the product this server is.
 *
 * The pages are built with `https://app.belline.ai` in every "Get started",
 * "Sign in" and chat link. Served by staging, they sent people — and the
 * site's own chat and video, which read their app origin from those links —
 * to production, so a staging test signed up on production and a feature
 * switched on for staging never appeared. Only a server whose own origin is
 * not a belline.ai host rewrites them; production pages are left as built.
 */
export function pointAtThisApp(html: string, env: Record<string, string | undefined> = process.env): string {
  const own = (env.PUBLIC_APP_URL || env.PUBLIC_ORIGIN || "").replace(/\/+$/, "");
  if (!own) return html;
  let host: string;
  try {
    const url = new URL(own);
    if (url.protocol !== "https:" && url.hostname !== "localhost") return html;
    host = url.hostname.toLowerCase();
  } catch {
    return html;
  }
  if (host === "belline.ai" || host.endsWith(".belline.ai")) return html;
  return html.split(PRODUCTION_APP).join(own);
}

/** The only hostnames a search engine should ever index. */
const PRODUCTION_HOSTS = new Set(["belline.ai", "www.belline.ai", "app.belline.ai"]);

function isBellineHost(host: string): boolean {
  return host === "belline.ai" || host.endsWith(".belline.ai");
}

/**
 * Whether a response to this request may be indexed.
 *
 * Staging and every preview host serve the same pages as production, and a
 * search engine that finds them files a second copy of the site under a
 * railway.app address — with sign-up links that create accounts on staging.
 * So only a request addressed to one of production's own hostnames, served by
 * a process whose own origin is production's, is indexable. The same
 * own-origin test `pointAtThisApp` uses: a staging server reached with a
 * forged `Host: belline.ai` is still staging.
 */
export function indexableRequest(host: string | undefined, env: Record<string, string | undefined> = process.env): boolean {
  const name = (host ?? "").split(":")[0].trim().toLowerCase();
  if (!PRODUCTION_HOSTS.has(name)) return false;
  const own = (env.PUBLIC_APP_URL || env.PUBLIC_ORIGIN || "").replace(/\/+$/, "");
  if (!own) return true;
  try {
    return isBellineHost(new URL(own).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export const NOINDEX_HEADER = "noindex, nofollow";
export const NOINDEX_ROBOTS_TXT = "User-agent: *\nDisallow: /\n";

/**
 * Keep a non-production host out of search, for every response the process
 * sends: the marketing files, Next's pages, the API. Called first thing in
 * server.ts. Returns true when it answered the request itself — `robots.txt`
 * on such a host says "Disallow: /" whichever of the two would have served it.
 * On production it does nothing at all.
 */
export function applyIndexing(req: IncomingMessage, res: ServerResponse, env: Record<string, string | undefined> = process.env): boolean {
  if (indexableRequest(req.headers.host, env)) return false;
  res.setHeader("X-Robots-Tag", NOINDEX_HEADER);
  const pathname = (req.url ?? "/").split("?")[0];
  if (pathname === "/robots.txt" && (req.method === "GET" || req.method === "HEAD")) {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=300" });
    res.end(req.method === "HEAD" ? undefined : NOINDEX_ROBOTS_TXT);
    return true;
  }
  return false;
}

/**
 * The German pages the build writes (scripts/site-locale.ts): /de-de, /de-at
 * and /de-ch, each with its landing page and two legal pages, rendered from
 * one German source each. Switzerland's are spelled with "ss".
 */
function germanSourceOf(name: string): { source: string; swiss: boolean } | null {
  const match = /^de-(de|at|ch)\/(index|datenschutz|nutzungsbedingungen)\.html$/.exec(name);
  if (!match) return null;
  const source = { index: "landing.de.html", datenschutz: "privacy.de.html", nutzungsbedingungen: "terms.de.html" }[match[2] as "index"];
  return { source, swiss: match[1] === "ch" };
}

export function marketingSiteExists(): boolean {
  return fs.existsSync(path.join(ROOT, "index.html"));
}

/**
 * True when this request is for the website rather than the product.
 *
 * Anything on `app.` is the dashboard. Everything else — the apex, `www`, and
 * a bare Railway hostname while DNS is still moving — is the website.
 */
export function isMarketingHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.split(":")[0].toLowerCase();
  return !name.startsWith("app.") && name !== "localhost" && !name.startsWith("127.");
}

/**
 * The root page for a request addressed to a cold-sending domain.
 *
 * We send outreach from four lookalike domains, and a recipient who wants to
 * know whether the mail is real types the domain into a browser. Serving them
 * belline.ai's landing page there would be a sales pitch in answer to "is this
 * a scam", and serving nothing at all is the spam signal the pages exist to
 * remove. So `/` on trybelline.com is trybelline.com's own page — built by
 * scripts/build-site.ts from the one list in sales/sending/domains.ts.
 *
 * One deploy, four hostnames, chosen here: the same trick that already picks
 * the website over the dashboard, one level down. Every other path on these
 * hosts is left exactly as it was, deliberately — the privacy notice and the
 * `/u` stop page have to resolve on the domain the mail came from, and
 * `applyIndexing` already keeps every one of these hostnames out of search,
 * since none of them is in PRODUCTION_HOSTS.
 *
 * Returns null on any other host, and null when the page has not been built,
 * so the caller falls back to the landing page rather than 404ing.
 */
function senderRoot(host: string | undefined, root: string): string | null {
  const domain = sendingDomainFor(host);
  if (!domain) return null;
  const file = path.resolve(root, senderPageFile(domain.domain));
  return file.startsWith(root) && fs.existsSync(file) ? file : null;
}

/** Does this request carry a dashboard session cookie? Name only — never the value. */
function signedIn(cookie: string | undefined): boolean {
  return cookie ? /(?:^|;\s*)belline_session=[^;\s]/.test(cookie) : false;
}

/**
 * Serve a marketing file, or return false and let Next have the request.
 *
 * Returning false rather than 404ing matters: it keeps `/api/twilio/voice`
 * and the websocket endpoints reachable on every hostname, so a webhook
 * configured against the wrong one still works.
 */
export function serveMarketing(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;

  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = decodeURIComponent(url.pathname);

  // The product's own routes stay on every hostname.
  if (pathname.startsWith("/api/") || pathname.startsWith("/ws/") || pathname.startsWith("/_next/")) {
    return false;
  }

  // A signed-in owner asking for `/` wants their dashboard, not the landing
  // page. In production the two live on separate hostnames and never meet;
  // on a deployment that serves both from one host (staging, a preview) the
  // landing page would otherwise shadow the dashboard and sign-in would look
  // like it did nothing. The cookie is per-host, so belline.ai can't carry
  // one: this changes nothing there.
  if (pathname === "/" && signedIn(req.headers.cookie)) return false;

  const root = path.resolve(ROOT);
  // `/dental` is a directory with an index; `/` is the landing page — unless
  // the request is addressed to one of the cold-sending domains, where `/` is
  // that domain's own small page (see `senderRoot`).
  const candidates =
    pathname === "/"
      ? [senderRoot(req.headers.host, root) ?? path.join(root, "index.html")]
      : [
          path.resolve(root, `.${pathname}`),
          path.resolve(root, `.${pathname}`, "index.html"),
          path.resolve(root, `.${pathname}.html`),
        ];

  for (const candidate of candidates) {
    // Resolve inside the root or refuse: a static server that will serve
    // `../../.env` is a habit worth not forming, even behind a hostname check.
    if (!candidate.startsWith(root)) continue;
    if (!fs.existsSync(candidate) || fs.statSync(candidate).isDirectory()) continue;

    const ext = path.extname(candidate).toLowerCase();
    res.writeHead(200, {
      "Content-Type": TYPES[ext] ?? "application/octet-stream",
      "Cache-Control": cacheFor(ext),
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      ...(indexableRequest(req.headers.host) ? {} : { "X-Robots-Tag": NOINDEX_HEADER }),
    });
    if (req.method === "HEAD") {
      res.end();
    } else {
      const bytes = fs.readFileSync(candidate);
      res.end(ext === ".html" ? pageWithFlags(path.relative(root, candidate), bytes) : bytes);
    }
    return true;
  }

  return false;
}

import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

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

  const root = path.resolve(ROOT);
  // `/dental` is a directory with an index; `/` is the landing page.
  const candidates =
    pathname === "/"
      ? [path.join(root, "index.html")]
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
    });
    if (req.method === "HEAD") {
      res.end();
    } else {
      res.end(fs.readFileSync(candidate));
    }
    return true;
  }

  return false;
}

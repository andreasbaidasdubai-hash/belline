/**
 * The one page shape both stop-routes answer with.
 *
 * `/u/<token>` has already done the thing and says so; `/u` cannot, because
 * nobody told it who is asking, and says that instead. Two different messages,
 * one piece of markup — a second stylesheet here would be two pages that drift
 * until the honest one looks like the afterthought.
 *
 * Deliberately not the marketing stylesheet. This page is reached by somebody
 * who wants us to go away, and serving them a branded page with a nav bar and
 * a "Get started" button is the last thing they need to see.
 */

function esc(value: string): string {
  return value.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

export interface StopPage {
  heading: string;
  /** Already-escaped HTML: these bodies carry links, and the callers write them. */
  body: string;
  lang?: string;
}

export function stopPage({ heading, body, lang = "en" }: StopPage): string {
  return `<!doctype html>
<html lang="${esc(lang)}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(heading)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         margin: 0; display: grid; place-items: center; min-height: 100vh; padding: 24px;
         background: #fbfaf8; color: #1a1a1a; }
  @media (prefers-color-scheme: dark) { body { background: #131312; color: #f2f1ef; } }
  main { max-width: 34rem; }
  h1 { font-size: 1.35rem; margin: 0 0 .5rem; font-weight: 600; }
  p { margin: 0 0 .9rem; opacity: .85; }
  p:last-child { margin-bottom: 0; }
  a { color: inherit; }
</style></head>
<body><main><h1>${esc(heading)}</h1>${body}</main></body></html>`;
}

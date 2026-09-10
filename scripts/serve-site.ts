/**
 * Serve the built marketing site over HTTP.
 *
 * The visual and accessibility suites need a real origin, not `file://` —
 * under a file URL the CSP, relative asset paths and `fetch` all behave
 * differently from production, which is exactly where a visual audit would
 * lie to you.
 *
 *   npm run serve:site -- 4321
 */

import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = "site";
const port = Number(process.argv[2] ?? 4321);

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? "/").split("?")[0]);
  // Resolve inside ROOT or refuse: a test server that will serve `../../.env`
  // is a habit worth not forming, even locally.
  const root = path.resolve(ROOT);
  const target = path.resolve(root, `.${url}`.replace(/\/$/, "/index.html"));
  const file = target.startsWith(root)
    ? fs.existsSync(target) && fs.statSync(target).isDirectory()
      ? path.join(target, "index.html")
      : target
    : null;

  if (!file || !fs.existsSync(file)) {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
    return;
  }

  res.writeHead(200, {
    "Content-Type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    "Cache-Control": "no-store",
  });
  res.end(fs.readFileSync(file));
}).listen(port, () => {
  console.log(`  ${ROOT}/  →  http://localhost:${port}`);
});

import { isConfigured, close } from "../src/lib/sales/db/client";
import { runForever } from "../src/lib/sales/queue/worker";

/**
 * `npm run worker`
 *
 * The background process behind every pipeline stage. Runs beside the voice
 * server rather than inside it: a research crawl that pins the event loop for
 * a second is invisible in a batch job and audible on a phone call.
 */

if (!isConfigured()) {
  console.error("\n  DATABASE_URL is not set. Run: npm run sales:db -- status\n");
  process.exit(1);
}

try {
  await runForever();
} finally {
  await close();
}

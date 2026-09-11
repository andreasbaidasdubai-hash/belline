/**
 * Apply schema migrations.
 *
 *   npm run migrate
 *
 * Both sets: the sales engine's and reception's. Safe to run repeatedly — an
 * applied migration is skipped, and an *edited* applied migration is a hard
 * failure with the file named rather than a schema that has quietly drifted
 * between a laptop and production.
 */

import { isConfigured } from "../src/lib/db/client";
import { migrate as migrateSales } from "../src/lib/sales/db/migrate";
import { migrateReception } from "../src/lib/reception/migrate";

if (!isConfigured()) {
  console.error(
    "\n  DATABASE_URL is not set.\n" +
      "  Voice works without it; the sales engine and WhatsApp reception do not.\n",
  );
  process.exit(1);
}

console.log("\n  reception");
const reception = await migrateReception({ verbose: true });
if (!reception.length) console.log("   already up to date");

console.log("\n  sales");
const sales = await migrateSales({ verbose: true });
if (!sales.length) console.log("   already up to date");

console.log(`\n  ${reception.length + sales.length} applied.\n`);
process.exit(0);

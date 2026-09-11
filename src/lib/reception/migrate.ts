import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../db/migrate";

/**
 * Reception's migrations.
 *
 * Its own ledger, separate from the sales engine's. One ledger shared between
 * two directories would let a name collision — two `001_` files — silently
 * skip somebody's migration, which is the kind of bug that is invisible until
 * a column is missing in production.
 */
const DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "db",
  "migrations",
);

export function migrateReception(opts: { verbose?: boolean } = {}): Promise<string[]> {
  return runMigrations({ dir: DIR, ledger: "reception_migration", verbose: opts.verbose });
}

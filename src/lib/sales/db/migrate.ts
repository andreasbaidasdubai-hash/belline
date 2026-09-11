import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../../db/migrate";

/**
 * The sales engine's migrations.
 *
 * The runner moved to `src/lib/db/migrate.ts` when reception needed one too.
 * The ledger table stays `sales_migration` — renaming it would make every
 * migration this database has already applied look unapplied, and re-running
 * them is not something a schema survives.
 */
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

export function migrate(opts: { verbose?: boolean } = {}): Promise<string[]> {
  return runMigrations({ dir: DIR, ledger: "sales_migration", verbose: opts.verbose });
}

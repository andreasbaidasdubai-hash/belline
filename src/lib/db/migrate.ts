import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pool, isConfigured } from "./client";

/**
 * Migrations.
 *
 * Numbered `.sql` files, applied in order, each inside its own transaction and
 * recorded with a checksum. No framework: the runner is sixty lines, and a
 * migration tool that needs its own documentation is a poor trade for a
 * codebase with four runtime dependencies.
 *
 * The checksum matters more than it looks. Editing an already-applied
 * migration is the single most common way a schema drifts between a laptop and
 * production — one database has the edit and the other does not, and nothing
 * says so. Here it is a hard failure with the file named.
 *
 * Two callers, two ledgers. The sales engine keeps `sales_migration` so
 * nothing it has already applied is re-run, and reception gets its own. One
 * ledger shared between two directories would mean a name collision silently
 * skipping somebody's migration.
 */

interface Applied {
  name: string;
  checksum: string;
}

function checksum(sql: string): string {
  // Normalise line endings first — this tree lives on Windows inside OneDrive,
  // and a CRLF round-trip would otherwise look like an edited migration.
  return crypto.createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex").slice(0, 16);
}

export interface MigrateOptions {
  /** Absolute path to a directory of numbered `.sql` files. */
  dir: string;
  /** The table this set records itself in. */
  ledger: string;
  verbose?: boolean;
}

export async function runMigrations(opts: MigrateOptions): Promise<string[]> {
  if (!isConfigured()) {
    throw new Error("DATABASE_URL is not set — nothing to migrate.");
  }
  // The ledger name is interpolated into DDL, so it is not allowed to be
  // anything but an identifier. It is ours rather than a user's, and a file
  // that only validates when somebody remembers to is a file that eventually
  // forgets.
  if (!/^[a-z_][a-z0-9_]*$/.test(opts.ledger)) {
    throw new Error(`Not a valid ledger table name: ${opts.ledger}`);
  }

  const db = pool();

  await db.query(`
    create table if not exists ${opts.ledger} (
      name        text primary key,
      checksum    text not null,
      applied_at  timestamptz not null default now()
    )
  `);

  const applied = new Map(
    (await db.query<Applied>(`select name, checksum from ${opts.ledger}`)).rows.map((r) => [
      r.name,
      r.checksum,
    ]),
  );

  const files = fs
    .readdirSync(opts.dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const ran: string[] = [];

  for (const name of files) {
    const sql = fs.readFileSync(path.join(opts.dir, name), "utf8");
    const sum = checksum(sql);
    const previous = applied.get(name);

    if (previous) {
      if (previous !== sum) {
        throw new Error(
          `Migration ${name} has changed since it was applied (${previous} → ${sum}). ` +
            `Add a new migration instead of editing an applied one.`,
        );
      }
      continue;
    }

    const client = await db.connect();
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query(`insert into ${opts.ledger} (name, checksum) values ($1, $2)`, [
        name,
        sum,
      ]);
      await client.query("commit");
      ran.push(name);
      if (opts.verbose) console.log(`   applied ${name}`);
    } catch (err) {
      await client.query("rollback").catch(() => {});
      throw new Error(`Migration ${name} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }

  return ran;
}

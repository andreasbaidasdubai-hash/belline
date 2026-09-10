import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { pool, isConfigured } from "./client";

/**
 * Migrations.
 *
 * Numbered `.sql` files, applied in order, each inside its own transaction and
 * recorded with a checksum. No framework: the runner is forty lines, and a
 * migration tool that needs its own documentation is a poor trade for a
 * codebase with four runtime dependencies.
 *
 * The checksum matters more than it looks. Editing an already-applied
 * migration is the single most common way a schema drifts between a laptop and
 * production — one database has the edit and the other does not, and nothing
 * says so. Here it is a hard failure with the file named.
 */

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

interface Applied {
  name: string;
  checksum: string;
}

function checksum(sql: string): string {
  // Normalise line endings first — this tree lives on Windows inside OneDrive,
  // and a CRLF round-trip would otherwise look like an edited migration.
  return crypto.createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex").slice(0, 16);
}

export async function migrate(opts: { verbose?: boolean } = {}): Promise<string[]> {
  if (!isConfigured()) {
    throw new Error("DATABASE_URL is not set — nothing to migrate.");
  }
  const db = pool();

  await db.query(`
    create table if not exists sales_migration (
      name        text primary key,
      checksum    text not null,
      applied_at  timestamptz not null default now()
    )
  `);

  const applied = new Map(
    (await db.query<Applied>("select name, checksum from sales_migration")).rows.map((r) => [
      r.name,
      r.checksum,
    ]),
  );

  const files = fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const ran: string[] = [];

  for (const name of files) {
    const sql = fs.readFileSync(path.join(DIR, name), "utf8");
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
      await client.query("insert into sales_migration (name, checksum) values ($1, $2)", [
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

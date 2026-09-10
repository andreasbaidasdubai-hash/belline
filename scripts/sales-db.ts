import { close, isConfigured, query } from "../src/lib/sales/db/client";
import { migrate } from "../src/lib/sales/db/migrate";
import { seed } from "../src/lib/sales/db/seed";

/**
 * `npm run sales:db -- migrate | seed | status | reset`
 *
 * One script rather than four, because they share the "is Postgres even
 * configured" preamble and the failure advice, and because the sequence you
 * actually run is `migrate` then `seed` on a machine that has never had either.
 */

const command = process.argv[2] ?? "status";

if (!isConfigured()) {
  console.error(`
  DATABASE_URL is not set.

  The sales engine needs Postgres; the voice product does not and is unaffected.
  Add to .env:

    DATABASE_URL=postgres://user:pass@host:5432/belline

  Railway: create a Postgres service, copy DATABASE_URL from its Variables tab.
  Local:   docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=belline postgres:16
           DATABASE_URL=postgres://postgres:belline@localhost:5432/postgres
`);
  process.exit(1);
}

try {
  switch (command) {
    case "migrate": {
      const ran = await migrate({ verbose: true });
      console.log(
        ran.length ? `\n  ${ran.length} migration(s) applied.\n` : "\n  Already up to date.\n",
      );
      break;
    }

    case "seed": {
      const result = await seed();
      console.log(`
  Reference data
    ${result.countries} countries · ${result.verticals} verticals · ${result.services} services · ${result.sequences} sequences
    ${result.regions} new region(s)

  Agents created
${result.agentsCreated.length ? result.agentsCreated.map((n) => `    + ${n}`).join("\n") : "    (none — the hierarchy already exists)"}
`);
      break;
    }

    case "status": {
      const applied = await query<{ name: string; applied_at: Date }>(
        `select name, applied_at from sales_migration order by name`,
      ).catch(() => []);
      const agents = await query<{
        name: string;
        kind: string;
        status: string;
        country_code: string | null;
      }>(`select name, kind, status, country_code from sales.agent order by kind, name`).catch(
        () => [],
      );

      console.log(`\n  Migrations (${applied.length})`);
      for (const m of applied) console.log(`    ${m.name}  ${m.applied_at.toISOString().slice(0, 10)}`);
      if (applied.length === 0) console.log("    none — run: npm run sales:db -- migrate");

      console.log(`\n  Agents (${agents.length})`);
      for (const a of agents) {
        console.log(`    ${a.status.padEnd(8)} ${a.kind.padEnd(16)} ${a.name}`);
      }
      if (agents.length === 0) console.log("    none — run: npm run sales:db -- seed");
      console.log("");
      break;
    }

    case "reset": {
      // Guarded twice on purpose: this drops every lead, message and audit row
      // in the sales schema, and the audit rows are the ones you cannot
      // reconstruct. The voice product's data/*.json is untouched either way.
      if (process.argv[3] !== "--yes-i-am-sure") {
        console.error(
          "\n  Refusing. This drops the whole sales schema — leads, messages, audit log.\n" +
            "  Re-run with: npm run sales:db -- reset --yes-i-am-sure\n",
        );
        process.exit(1);
      }
      await query("drop schema if exists sales cascade");
      await query("drop table if exists sales_migration");
      console.log("\n  Sales schema dropped. Run migrate + seed to rebuild.\n");
      break;
    }

    default:
      console.error(`\n  Unknown command "${command}". Use: migrate | seed | status | reset\n`);
      process.exit(1);
  }
} catch (err) {
  console.error(`\n  ${(err as Error).message}\n`);
  process.exitCode = 1;
} finally {
  await close();
}

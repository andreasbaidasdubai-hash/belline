import { close, isConfigured } from "../src/lib/sales/db/client";
import { getAgentByName } from "../src/lib/sales/config/agents";
import { discover } from "../src/lib/sales/discovery/run";
import { GooglePlacesProvider } from "../src/lib/sales/discovery/google-places";

/**
 * `npm run discover -- "UAE Dental" [--limit 20] [--source google_places] [--dry]`
 *
 * Discovery from the command line, so the first runs can be watched and read
 * by a person before any of this is wired to a button. `--dry` resolves the
 * agent and calls the provider but writes nothing — the cheapest way to see
 * what a query actually returns.
 */

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(["limit", "source"]);

const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

/**
 * Everything that is neither a flag nor a flag's value, rejoined.
 *
 * PowerShell and cmd both drop the quotes around `"UAE Dental"` on the way
 * through `npm run`, so the agent name arrives as two arguments. Rejoining is
 * what makes the documented command actually work on Windows.
 */
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg.startsWith("--")) {
    if (VALUE_FLAGS.has(arg.slice(2))) i++;
    continue;
  }
  positional.push(arg);
}
const name = positional.join(" ").trim() || undefined;
const limit = flag("limit") ? Number(flag("limit")) : undefined;
const source = flag("source") ?? "google_places";
const dryRun = args.includes("--dry");

if (!isConfigured()) {
  console.error("\n  DATABASE_URL is not set. Run: npm run sales:db -- status\n");
  process.exit(1);
}

if (!name) {
  console.error(`
  Which agent?

    npm run discover -- "UAE Dental"
    npm run discover -- "UAE Dental" --limit 20 --dry

  Agents: npm run agents
`);
  process.exit(1);
}

try {
  const provider = new GooglePlacesProvider();
  if (source === "google_places" && !provider.available()) {
    console.error(`\n  ${provider.unavailableReason()}\n`);
    process.exit(1);
  }

  const agent = await getAgentByName(name);
  if (!agent) {
    console.error(`\n  No agent matching "${name}". Run: npm run agents\n`);
    process.exit(1);
  }

  console.log(
    `\n  ${dryRun ? "Dry run" : "Discovering"} for ${agent.name}  (${source})` +
      `${limit ? ` · limit ${limit}` : ""}\n`,
  );

  const started = Date.now();
  const result = await discover({
    agentId: agent.id,
    source,
    limit,
    actor: "user:cli",
    dryRun,
  });

  const seconds = Math.round((Date.now() - started) / 100) / 10;

  if (result.sample.length > 0) {
    console.log("");
    for (const c of result.sample) {
      const stars = c.rating ? `${c.rating}★ ${c.reviewCount ?? 0}` : "no rating";
      console.log(`  ${c.name}`);
      console.log(
        `    ${[c.city, c.subVertical, stars].filter(Boolean).join(" · ")}`,
      );
      console.log(
        `    ${c.website ?? "(no website)"}   ${c.phone ?? "(no phone)"}`,
      );
    }
    console.log("");
  }

  console.log(`  found              ${result.found}`);
  if (!dryRun) {
    console.log(`  new companies      ${result.companiesCreated}`);
    console.log(`  already known      ${result.companiesMerged}`);
    console.log(`  leads claimed      ${result.leadsClaimed}`);
  }
  console.log(`  skipped            ${result.skipped.length}`);
  console.log(`  cost               $${result.costUsd.toFixed(4)}  (estimate)`);
  console.log(`  took               ${seconds}s\n`);

  if (result.skipped.length > 0) {
    console.log("  Skipped:");
    for (const s of result.skipped.slice(0, 10)) console.log(`    ${s.company} — ${s.reason}`);
    if (result.skipped.length > 10) console.log(`    …and ${result.skipped.length - 10} more`);
    console.log("");
  }

  if (result.conflicts.length > 0) {
    // Not an error: another agent already owns these companies, and the
    // country manager decides. See docs/sales-engine/AGENTS.md §1.
    console.log("  Already held by another agent:");
    for (const c of result.conflicts.slice(0, 10)) console.log(`    ${c.company} — ${c.heldBy}`);
    console.log("");
  }

  if (!dryRun) console.log(`  See them at /sales/leads, or: npm run agents\n`);
} catch (err) {
  console.error(`\n  ${(err as Error).message}`);
  // A ConfigError knows exactly which fields are wrong; printing only the
  // headline turns a two-second fix into a hunt through JSON.
  const issues = (err as { issues?: string[] }).issues;
  if (Array.isArray(issues)) for (const issue of issues) console.error(`    · ${issue}`);
  console.error("");
  process.exitCode = 1;
} finally {
  await close();
}

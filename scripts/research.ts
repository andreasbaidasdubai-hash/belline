import { close, isConfigured, query } from "../src/lib/sales/db/client";
import { getAgentByName } from "../src/lib/sales/config/agents";
import { researchLeads } from "../src/lib/sales/research/run";

/**
 * `npm run research -- "UAE Dental" [--limit 5] [--show] [--force]`
 *
 * `--show` prints each summary and its cited evidence afterwards. That is the
 * point of the first runs: the failure mode of this stage is confident,
 * plausible nonsense, and the only thing that catches it is a person reading
 * the claims against the pages they cite.
 */

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(["limit"]);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? undefined : args[i + 1];
};

const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) {
    if (VALUE_FLAGS.has(args[i].slice(2))) i++;
    continue;
  }
  positional.push(args[i]);
}
const name = positional.join(" ").trim();

if (!isConfigured()) {
  console.error("\n  DATABASE_URL is not set.\n");
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("\n  ANTHROPIC_API_KEY is not set — the research agent cannot run.\n");
  process.exit(1);
}
if (!name) {
  console.error(`\n  Which agent?  npm run research -- "UAE Dental" --limit 5 --show\n`);
  process.exit(1);
}

try {
  const agent = await getAgentByName(name);
  if (!agent) {
    console.error(`\n  No agent matching "${name}". Run: npm run agents\n`);
    process.exit(1);
  }

  const limit = flag("limit") ? Number(flag("limit")) : 5;
  console.log(`\n  Researching up to ${limit} leads for ${agent.name}\n`);

  const started = Date.now();
  const result = await researchLeads({
    agentId: agent.id,
    limit,
    actor: "user:cli",
    force: args.includes("--force"),
  });

  if (args.includes("--show") && result.researched > 0) {
    const rows = await query<{
      name: string;
      summary: string;
      signals: Record<string, unknown>;
      use_cases: string[];
      evidence: { claim: string; url: string; quote: string }[];
      pages_read: string[];
    }>(
      `select c.name, r.summary, r.signals, r.use_cases, r.evidence, r.pages_read
         from sales.research_record r join sales.company c on c.id = r.company_id
        where r.agent_id = $1 order by r.created_at desc limit $2`,
      [agent.id, result.researched],
    );

    for (const row of rows) {
      console.log(`\n  ${"─".repeat(70)}`);
      console.log(`  ${row.name}`);
      console.log(`  ${"─".repeat(70)}`);
      console.log(`\n  ${row.summary.replace(/\n/g, "\n  ")}\n`);

      const on = Object.entries(row.signals)
        .filter(([, v]) => v !== null && v !== false && !(Array.isArray(v) && v.length === 0))
        .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("/") : v}`);
      console.log(`  present   ${on.join("  ") || "(none established)"}`);

      // Shown separately rather than hidden, because for this product the
      // absences are the pitch: "no online booking" and "no after-hours
      // cover" are why a practice needs Belline, and a display that only
      // lists what a business *has* buries the reason to call them.
      const absent = Object.entries(row.signals)
        .filter(([, v]) => v === false)
        .map(([k]) => k);
      if (absent.length) console.log(`  absent    ${absent.join(", ")}`);

      const unknown = Object.entries(row.signals).filter(([, v]) => v === null).map(([k]) => k);
      if (unknown.length) console.log(`  unknown   ${unknown.join(", ")}`);
      console.log(`  use cases ${row.use_cases.join(", ") || "(none)"}`);
      console.log(`  read      ${row.pages_read.length} pages`);

      if (row.evidence.length) {
        console.log(`\n  evidence:`);
        for (const e of row.evidence.slice(0, 6)) {
          console.log(`    · ${e.claim}`);
          console.log(`      "${e.quote.slice(0, 100)}"`);
          console.log(`      ${e.url}`);
        }
      }
    }
    console.log("");
  }

  const seconds = Math.round((Date.now() - started) / 100) / 10;
  console.log(`\n  researched         ${result.researched} / ${result.attempted}`);
  console.log(`  unreadable sites   ${result.unreadable.length}`);
  console.log(`  failed             ${result.failed.length}`);
  console.log(`  evidence dropped   ${result.droppedEvidence}`);
  console.log(`  cost               $${result.costUsd.toFixed(4)}`);
  console.log(`  took               ${seconds}s\n`);

  for (const u of result.unreadable) console.log(`    unreadable: ${u.company} — ${u.reason}`);
  for (const f of result.failed) console.log(`    failed: ${f.company} — ${f.reason}`);
  console.log("");
} catch (err) {
  console.error(`\n  ${(err as Error).message}\n`);
  process.exitCode = 1;
} finally {
  await close();
}

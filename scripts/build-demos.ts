import { close, isConfigured } from "../src/lib/sales/db/client";
import { getAgentByName } from "../src/lib/sales/config/agents";
import { buildDemos } from "../src/lib/sales/demos/run";

/**
 * `npm run demos -- "UAE Dental" [--limit 3] [--force]`
 *
 * Writes and renders a personalised 30–60 second demo call for each qualified
 * lead. Costs one model call plus a few seconds of speech per prospect.
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
if (!name) {
  console.error(`\n  Which agent?  npm run demos -- "UAE Dental" --limit 3\n`);
  process.exit(1);
}

try {
  const agent = await getAgentByName(name);
  if (!agent) {
    console.error(`\n  No agent matching "${name}". Run: npm run agents\n`);
    process.exit(1);
  }

  const limit = flag("limit") ? Number(flag("limit")) : 3;
  console.log(`\n  Building up to ${limit} demos for ${agent.name}\n`);

  const started = Date.now();
  const result = await buildDemos({
    agentId: agent.id,
    limit,
    actor: "user:cli",
    force: args.includes("--force"),
  });

  for (const d of result.demos) {
    console.log(`  ${d.company}`);
    console.log(`    ${d.scenario}`);
    console.log(`    ~${d.seconds}s  ·  /demo/${d.slug}\n`);
  }

  if (result.rejected.length) {
    // Worth reading every time: a pattern here means the prompt has drifted,
    // and the guards are the only thing catching it.
    console.log("  Rejected by the guards:");
    for (const r of result.rejected) {
      console.log(`    ${r.company}`);
      for (const p of r.problems) console.log(`      · ${p}`);
    }
    console.log("");
  }

  for (const s of result.skipped) console.log(`    skipped: ${s.company} — ${s.reason}`);

  const seconds = Math.round((Date.now() - started) / 100) / 10;
  console.log(`\n  built       ${result.built}`);
  console.log(`  rejected    ${result.rejected.length}`);
  console.log(`  script cost $${result.llmCostUsd.toFixed(4)}`);
  console.log(`  audio cost  $${result.ttsCostUsd.toFixed(4)}`);
  console.log(`  took        ${seconds}s\n`);
} catch (err) {
  console.error(`\n  ${(err as Error).message}\n`);
  process.exitCode = 1;
} finally {
  await close();
}

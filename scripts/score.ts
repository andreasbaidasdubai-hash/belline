import { close, isConfigured } from "../src/lib/sales/db/client";
import { getAgentByName, resolveAgentConfig } from "../src/lib/sales/config/agents";
import { scoreLeads } from "../src/lib/sales/scoring/run";

/**
 * `npm run score -- "UAE Dental"`
 *
 * Free and repeatable. Change a weight in the agent's config and run it again;
 * every lead is re-ranked with no model call, because the signals are already
 * stored. Prints the full arithmetic so a ranking you disagree with can be
 * traced to the term that caused it.
 */

const args = process.argv.slice(2);
const name = args.filter((a) => !a.startsWith("--")).join(" ").trim();

if (!isConfigured()) {
  console.error("\n  DATABASE_URL is not set.\n");
  process.exit(1);
}
if (!name) {
  console.error(`\n  Which agent?  npm run score -- "UAE Dental"\n`);
  process.exit(1);
}

try {
  const agent = await getAgentByName(name);
  if (!agent) {
    console.error(`\n  No agent matching "${name}". Run: npm run agents\n`);
    process.exit(1);
  }

  const { config } = await resolveAgentConfig(agent.id);
  const result = await scoreLeads({ agentId: agent.id, actor: "user:cli" });

  console.log(
    `\n  ${agent.name} · qualifies at ${config.qualification_rules.min_score_to_contact}` +
      ` · hot ≥ ${config.scoring.bands.hot}, warm ≥ ${config.scoring.bands.warm}\n`,
  );

  for (const r of result.results) {
    const flag = r.score.priority === "hot" ? "HOT " : r.score.priority === "warm" ? "warm" : "low ";
    console.log(`  ${String(r.score.score).padStart(3)}  ${flag}  ${r.company}`);
    // The arithmetic, not just the verdict: a ranking you disagree with should
    // be traceable to the term that caused it in one glance.
    const terms = r.score.breakdown
      .map((t) => `${t.points > 0 ? "+" : ""}${t.points} ${t.why}`)
      .join("  ");
    console.log(`       ${terms}`);
  }

  console.log(`\n  scored      ${result.scored}`);
  console.log(`  qualified   ${result.qualified}`);
  console.log(`  skipped     ${result.skipped}  (not researched — nothing to score)`);
  console.log(`  cost        $0.00  (no model runs in scoring)\n`);
} catch (err) {
  console.error(`\n  ${(err as Error).message}\n`);
  process.exitCode = 1;
} finally {
  await close();
}

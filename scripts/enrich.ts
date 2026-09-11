import { close, isConfigured } from "../src/lib/sales/db/client";
import { getAgentByName } from "../src/lib/sales/config/agents";
import { enrichEmails } from "../src/lib/sales/enrich/run";

/**
 * `npm run enrich -- "UAE Dental" [--limit 25]`
 *
 * Reads each company's published contact address off its own website. No model
 * and no paid provider — just HTTP. Run it before research, so tokens are not
 * spent on a company nobody can be written to.
 */

const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? undefined : args[i + 1];
};
const name = args
  .filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--limit")
  .join(" ")
  .trim();

if (!isConfigured()) {
  console.error("\n  DATABASE_URL is not set.\n");
  process.exit(1);
}
if (!name) {
  console.error(`\n  Which agent?  npm run enrich -- "UAE Dental"\n`);
  process.exit(1);
}

try {
  const agent = await getAgentByName(name);
  if (!agent) {
    console.error(`\n  No agent matching "${name}". Run: npm run agents\n`);
    process.exit(1);
  }

  const limit = flag("limit") ? Number(flag("limit")) : 25;
  console.log(`\n  Looking for contact addresses — up to ${limit} companies\n`);

  const started = Date.now();
  const result = await enrichEmails({ agentId: agent.id, limit, actor: "user:cli" });
  const seconds = Math.round((Date.now() - started) / 100) / 10;

  console.log(`  found       ${result.found} / ${result.attempted}`);
  console.log(`  no address  ${result.notFound.length}`);
  if (result.suppressed.length) {
    console.log(`  suppressed  ${result.suppressed.length}  (already opted out — not stored)`);
  }
  console.log(`  cost        $0.00  (no model, no provider)`);
  console.log(`  took        ${seconds}s\n`);

  for (const n of result.notFound.slice(0, 15)) {
    console.log(`    no published address: ${n.company}`);
  }
  console.log("");
} catch (err) {
  console.error(`\n  ${(err as Error).message}\n`);
  process.exitCode = 1;
} finally {
  await close();
}

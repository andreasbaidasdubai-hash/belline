import { close, isConfigured, query } from "../src/lib/sales/db/client";
import { getAgentByName } from "../src/lib/sales/config/agents";
import { draftOutreach } from "../src/lib/sales/outreach/run";

/**
 * `npm run draft -- "UAE Dental" [--limit 3] [--show] [--force]`
 *
 * Writes first-touch outreach into the approval queue. Nothing is sent: in
 * MODE 1 a person approves every message, and the first hundred exist to be
 * read by someone who can tell whether the personalisation is any good.
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
  console.error(`\n  Which agent?  npm run draft -- "UAE Dental" --show\n`);
  process.exit(1);
}

try {
  const agent = await getAgentByName(name);
  if (!agent) {
    console.error(`\n  No agent matching "${name}". Run: npm run agents\n`);
    process.exit(1);
  }

  const limit = flag("limit") ? Number(flag("limit")) : 3;
  console.log(`\n  Drafting up to ${limit} messages for ${agent.name}\n`);

  const result = await draftOutreach({
    agentId: agent.id,
    limit,
    actor: "user:cli",
    force: args.includes("--force"),
  });

  if (args.includes("--show") && result.drafts.length > 0) {
    const rows = await query<{ company: string; subject: string; body: string; status: string }>(
      `select c.name as company, m.subject, m.body, m.status::text
         from sales.message m
         join sales.lead l on l.id = m.lead_id
         join sales.company c on c.id = l.company_id
        where m.id = any($1::bigint[]) order by m.id`,
      [result.drafts.map((d) => d.messageId)],
    );

    for (const row of rows) {
      const draft = result.drafts.find((d) => d.company === row.company);
      console.log(`\n${"═".repeat(74)}`);
      console.log(`To: ${row.company}   [${row.status}]`);
      console.log(`Subject: ${row.subject}`);
      console.log("═".repeat(74));
      console.log(row.body.split("\n").map((l) => `  ${l}`).join("\n"));
      if (draft?.problems.length) {
        console.log(`\n  ✗ blocked:`);
        for (const p of draft.problems) console.log(`      ${p}`);
      }
      if (draft?.warnings.length) {
        for (const w of draft.warnings) console.log(`  · ${w}`);
      }
      console.log(`\n  ${draft?.words} words of personalised copy`);
    }
    console.log("");
  }

  for (const s of result.skipped) console.log(`    skipped: ${s.company} — ${s.reason}`);

  console.log(`\n  drafted     ${result.drafted}`);
  console.log(`  flagged     ${result.flagged}  (held back from the approval queue)`);
  console.log(`  skipped     ${result.skipped.length}`);
  console.log(`  cost        $${result.costUsd.toFixed(4)}`);
  console.log(`\n  Review at /sales/approvals\n`);
} catch (err) {
  console.error(`\n  ${(err as Error).message}\n`);
  process.exitCode = 1;
} finally {
  await close();
}

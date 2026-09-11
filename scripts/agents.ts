/**
 * Show the agent workforce.
 *
 * Runs with no database and no API keys, because the inheritance resolver is
 * pure. That matters for one specific reason: "where are my agents?" should be
 * answerable before Postgres exists, and the answer should be the same one the
 * dashboard will show once it does.
 *
 * With DATABASE_URL set this reads the live agents. Without it, it shows the
 * seed — what `npm run sales:db -- seed` will create.
 *
 *   npm run agents
 */

import { COUNTRIES, FIRST_AGENT_CONFIG, SERVICES } from "../src/lib/sales/config/defaults";
import { mergeChain } from "../src/lib/sales/config/agents";
import type { PartialAgentConfig } from "../src/lib/sales/config/schema";
import { isConfigured, query, close } from "../src/lib/sales/db/client";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const warn = (s: string) => `\x1b[33m${s}\x1b[0m`;
const ok = (s: string) => `\x1b[32m${s}\x1b[0m`;

// ---------------------------------------------------------------------------

if (isConfigured()) {
  try {
    const rows = await query<{
      id: number;
      name: string;
      kind: string;
      status: string;
      country_code: string | null;
      vertical_slug: string | null;
      leads: number;
    }>(
      `select a.id, a.name, a.kind::text, a.status::text, a.country_code, a.vertical_slug,
              (select count(*)::int from sales.lead l where l.agent_id = a.id) as leads
         from sales.agent a where a.status <> 'archived' order by a.kind, a.name`,
    );
    console.log(`\n  ${bold("Live agents")}  ${dim("(from the database)")}\n`);
    if (rows.length === 0) {
      console.log(`  none yet — run: npm run sales:db -- seed\n`);
    } else {
      for (const r of rows) {
        const scope = [r.country_code, r.vertical_slug].filter(Boolean).join(" · ");
        console.log(
          `  ${r.status === "active" ? ok("●") : warn("○")} ${r.name.padEnd(28)} ` +
            `${dim(r.kind.padEnd(16))} ${dim(scope.padEnd(18))} ${r.leads} leads`,
        );
      }
      console.log("");
    }
  } catch {
    console.log(`\n  ${warn("Database reachable but not migrated.")}  npm run sales:db -- migrate\n`);
  }
  await close();
}

// ---------------------------------------------------------------------------

console.log(`\n  ${bold("The workforce, as configured")}${isConfigured() ? "" : dim("  (no DATABASE_URL — showing the seed)")}\n`);

const director: PartialAgentConfig = {
  belline_services: SERVICES.map((s) => s.slug),
  compliance: { min_days_between_touches: 2, company_touch_cap_90d: 6 },
};

console.log(`  ${bold("Belline Sales Director")}   ${dim("global · budget $60/day")}`);

for (const country of COUNTRIES) {
  const manager: PartialAgentConfig = {
    languages: country.default_languages,
    compliance: country.compliance_profile,
    outreach_strategy: { channels: country.channels, send_window: country.send_window },
  };

  console.log(
    `\n   └─ ${bold(`${country.name} Manager`)}  ${dim(
      `${country.code} · ${country.default_languages.join("/")} · ${country.channels.join(", ")}`,
    )}`,
  );

  const consent = country.compliance_profile.email_requires_prior_consent;
  console.log(
    `        ${consent ? warn("email needs prior consent") : dim("email: legitimate interest")}` +
      dim(` · max ${country.compliance_profile.max_sequence_steps} steps`) +
      dim(` · ${country.compliance_profile.company_touch_cap_90d} touches/90d`),
  );

  // Only the UAE has a vertical agent in the seed. The rest are shown as what
  // adding one would produce — the point being that it is a form, not a deploy.
  const verticals =
    country.code === "AE"
      ? [{ name: "UAE Dental Agent", config: FIRST_AGENT_CONFIG }]
      : [{ name: `${country.code} Dental Agent`, config: { ...FIRST_AGENT_CONFIG } }];

  for (const v of verticals) {
    const resolved = mergeChain([director, manager, v.config]);
    const channels = resolved.outreach_strategy?.channels ?? [];
    const asked = v.config.outreach_strategy?.channels ?? [];
    const removed = asked.filter((c) => !channels.includes(c));

    console.log(
      `        └─ ${country.code === "AE" ? bold(v.name) : dim(v.name + "  (not seeded)")}`,
    );
    console.log(
      `             channels ${channels.join(", ") || warn("none")}` +
        (removed.length ? warn(`   ${removed.join(", ")} removed by the country manager`) : ""),
    );
    console.log(
      dim(
        `             languages ${(resolved.languages ?? []).join("/")}` +
          ` · sequence ${resolved.outreach_strategy?.sequence}` +
          ` capped at ${resolved.compliance?.max_sequence_steps} steps` +
          ` · budget $${resolved.budget?.daily_usd}/day`,
      ),
    );
  }
}

console.log(`
  ${dim("Each of these is a row plus a JSON config — no per-agent code.")}
  ${dim("Adding a vertical or a country is a form, not a deploy.")}
`);

if (!isConfigured()) {
  console.log(`  ${warn("They do not exist yet.")} They are created by:

     1. Add DATABASE_URL to .env   ${dim("(Railway → New → Database → Postgres → Variables)")}
     2. npm run sales:db -- migrate
     3. npm run sales:db -- seed

  ${dim("Then they appear at /sales in the dashboard, and here.")}
`);
}

import { query, tx } from "../db/client";
import { resolveAgentConfig } from "../config/agents";
import { log } from "../db/repo/activity";
import { isSuppressed } from "../compliance/suppression";
import { personalise } from "./personalise";
import { assemble, resolveFrame } from "./templates";

/**
 * Draft first-touch outreach for qualified leads.
 *
 * Drafts only. In MODE 1 every message lands at `pending_approval` and a
 * person decides — and that is not a limitation to be engineered around, it
 * is how the first hundred get read by someone who can tell whether the
 * personalisation is any good.
 *
 * A draft that fails a guard is still written to the database, flagged. A
 * silently discarded draft teaches nobody anything; a flagged one shows you
 * the prompt has drifted.
 */

const CUSTOMER_WORD: Record<string, { word: string; forbidden: string[] }> = {
  dentists: { word: "patient", forbidden: ["guest", "client", "customer"] },
  clinics: { word: "patient", forbidden: ["guest", "client", "customer"] },
  salons: { word: "client", forbidden: ["patient", "guest"] },
  restaurants: { word: "guest", forbidden: ["patient", "client"] },
};

export interface DraftRunResult {
  drafted: number;
  flagged: number;
  skipped: { company: string; reason: string }[];
  costUsd: number;
  drafts: {
    company: string;
    leadId: number;
    messageId: number;
    subject: string;
    words: number;
    problems: string[];
    warnings: string[];
  }[];
}

export async function draftOutreach(options: {
  agentId: number;
  limit?: number;
  actor?: string;
  /** Draft even for leads that already have a pending or sent message. */
  force?: boolean;
}): Promise<DraftRunResult> {
  const { agent, config } = await resolveAgentConfig(options.agentId);
  const actor = options.actor ?? `agent:${agent.id}`;
  const publicOrigin = process.env.PUBLIC_ORIGIN ?? "https://belline.ai";
  const senderAddress = process.env.SENDER_POSTAL_ADDRESS ?? "Belline · Dubai, United Arab Emirates";

  const candidates = await query<{
    lead_id: number;
    company_id: number;
    name: string;
    city: string | null;
    email: string | null;
    vertical_slug: string | null;
    country_code: string | null;
    domain: string | null;
    summary: string;
    evidence: { claim: string; url: string; quote: string }[];
    signals: Record<string, unknown>;
    demo_slug: string | null;
    demo_scenario: string | null;
    demo_hint: string | null;
    contact_name: string | null;
    contact_email: string | null;
  }>(
    `select l.id as lead_id, c.id as company_id, c.name, c.city, c.email,
            c.vertical_slug, c.country_code, c.domain,
            r.summary, r.evidence, r.signals,
            d.location_slug as demo_slug, d.scenario as demo_scenario,
            d.script_hint as demo_hint,
            ct.full_name as contact_name, ct.email as contact_email
       from sales.lead l
       join sales.company c on c.id = l.company_id
       join lateral (
         select summary, evidence, signals from sales.research_record rr
          where rr.company_id = c.id order by rr.created_at desc limit 1
       ) r on true
       left join lateral (
         select location_slug, scenario, script_hint from sales.demo dd
          where dd.lead_id = l.id and dd.expires_at > now()
          order by dd.issued_at desc limit 1
       ) d on true
       left join sales.contact ct on ct.id = l.contact_id
      where l.agent_id = $1
        and l.stage = 'qualified'
        -- A live demo is a precondition, not a bonus. The email's entire job
        -- is to earn one click on the recording; without one it promises
        -- "listen to your demo" and links to the homepage, which is a broken
        -- promise in the first message a business ever gets from us.
        and d.location_slug is not null
        and ($3 or not exists (
              select 1 from sales.message m
               where m.lead_id = l.id and m.direction = 'outbound'))
      order by l.current_score desc nulls last
      limit $2`,
    [agent.id, options.limit ?? 5, options.force ?? false],
  );

  const result: DraftRunResult = {
    drafted: 0,
    flagged: 0,
    skipped: [],
    costUsd: 0,
    drafts: [],
  };

  // The anti-template check needs something to compare against. Scoped to this
  // agent: two agents writing similar copy for different countries is fine.
  const recent = await query<{ body: string }>(
    `select body from sales.message
      where agent_id = $1 and direction = 'outbound'
      order by created_at desc limit 50`,
    [agent.id],
  );
  const recentBodies = recent.map((r) => r.body);

  for (const candidate of candidates) {
    const toAddress = candidate.contact_email ?? candidate.email;

    if (!toAddress) {
      result.skipped.push({ company: candidate.name, reason: "no email address" });
      continue;
    }

    // Checked here so we never spend a model call on someone we may not
    // write to, and again at send time because approval may be hours old.
    const suppression = await isSuppressed({
      email: toAddress,
      domain: candidate.domain,
      companyId: candidate.company_id,
    });
    if (suppression) {
      result.skipped.push({ company: candidate.name, reason: `suppressed: ${suppression}` });
      continue;
    }

    const vocab = CUSTOMER_WORD[candidate.vertical_slug ?? ""] ?? {
      word: "customer",
      forbidden: [],
    };

    try {
      const grounding = [
        candidate.summary,
        "",
        "Established facts:",
        ...Object.entries(candidate.signals)
          .filter(([, v]) => v !== null)
          .map(([k, v]) => `  ${k.replace(/_/g, " ")}: ${Array.isArray(v) ? v.join(", ") : v}`),
        "",
        "From their own pages:",
        ...candidate.evidence.map((e) => `  "${e.quote}"`),
      ].join("\n");

      const out = await personalise({
        agentId: agent.id,
        leadId: candidate.lead_id,
        companyName: candidate.name,
        city: candidate.city,
        vertical: candidate.vertical_slug,
        customerWord: vocab.word,
        forbiddenCustomerWords: vocab.forbidden,
        grounding,
        demoScenario: candidate.demo_scenario,
        allowedServices: config.belline_services,
        tone: config.outreach_strategy.tone,
        maxWords: config.outreach_strategy.max_words_first_touch,
        recentBodies,
      });
      result.costUsd += out.costUsd;

      const frame = resolveFrame({
        countryCode: candidate.country_code,
        language: candidate.contact_name ? config.default_language : config.default_language,
      });

      const demoUrl = candidate.demo_slug
        ? `${publicOrigin}/demo/${candidate.demo_slug}`
        : `${publicOrigin}/`;

      // Signed at send time; a placeholder here would be a dead link in a
      // draft someone might copy out of the approval queue by hand.
      const unsubscribeUrl = `${publicOrigin}/u/{token}`;

      const { body } = assemble({
        frame,
        firstName: candidate.contact_name?.split(" ")[0] ?? null,
        observation: out.draft.observation,
        problem: out.draft.problem,
        solution: out.draft.solution,
        cta: out.draft.cta,
        demoUrl,
        tryThis: candidate.demo_hint,
        unsubscribeUrl,
        senderAddress,
      });

      const flagged = out.guard.problems.length > 0;

      const inserted = await tx(async (c) => {
        const row = await c.query<{ id: number }>(
          `insert into sales.message
             (lead_id, contact_id, agent_id, sequence_step, channel, direction,
              status, language, to_address, subject, body, personalisation,
              guard_flags, template_key)
           values ($1, $2, $3, 1, 'email', 'outbound', $4, $5, $6, $7, $8, $9, $10, $11)
           returning id`,
          [
            candidate.lead_id,
            null,
            agent.id,
            // A flagged draft is still a draft, not a queued message. It never
            // reaches the bulk-approve path.
            flagged ? "draft" : "pending_approval",
            frame.language,
            toAddress,
            out.draft.subjects[0],
            body,
            JSON.stringify({
              observation: out.draft.observation,
              problem: out.draft.problem,
              solution: out.draft.solution,
              cta: out.draft.cta,
              subjects: out.draft.subjects,
              demoUrl,
              words: out.guard.wordCount,
              similarity: out.guard.similarity,
              model: out.model,
              promptHash: out.promptHash,
            }),
            JSON.stringify([...out.guard.problems, ...out.guard.warnings.map((w) => `warning: ${w}`)]),
            frame.key,
          ],
        );

        await log({
          client: c,
          leadId: candidate.lead_id,
          companyId: candidate.company_id,
          agentId: agent.id,
          actor,
          type: "drafted",
          summary: flagged
            ? `Draft flagged: ${out.guard.problems[0]}`
            : out.draft.subjects[0],
          data: {
            messageId: row.rows[0].id,
            words: out.guard.wordCount,
            problems: out.guard.problems,
            warnings: out.guard.warnings,
            costUsd: out.costUsd,
          },
        });

        return row.rows[0].id;
      });

      recentBodies.unshift(body);
      result.drafted++;
      if (flagged) result.flagged++;
      result.drafts.push({
        company: candidate.name,
        leadId: candidate.lead_id,
        messageId: inserted,
        subject: out.draft.subjects[0],
        words: out.guard.wordCount,
        problems: out.guard.problems,
        warnings: out.guard.warnings,
      });
    } catch (err) {
      result.skipped.push({ company: candidate.name, reason: (err as Error).message });
    }
  }

  return result;
}

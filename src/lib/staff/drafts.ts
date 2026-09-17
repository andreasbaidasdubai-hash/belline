import type { User } from "../types";
import { flag, type FlagName } from "../flags";
import { isConfigured, query, tx } from "../sales/db/client";
import { resolveAgentConfig } from "../sales/config/agents";
import { SERVICES, vocabularyFor } from "../sales/config/defaults";
import { checkDraft, type DraftParts, type GuardContext, type GuardResult } from "../sales/outreach/guards";
import { suppress } from "../sales/compliance/suppression";
import { staffAudit } from "./audit";

/**
 * The email an agent drafted for a lead, from the lead's own page.
 *
 * What the old Approvals page did, plus the two things it could not: edit a
 * draft, and record that a person sent it by hand. There is still no sender.
 * Nothing here delivers email: approving records the decision, and "Mark as
 * sent" records that somebody copied the approved text into their own mail
 * program and sent it from there.
 *
 * An edit changes only the four parts the agent wrote (the opening, the
 * problem, how Belline helps, the ask) and the subject; the greeting, demo link,
 * sign-off and opt-out line around them stay as they were. Every edit is
 * checked by the same pre-send guards the agent's own draft went through, with
 * the same research and settings, and an approve re-runs them on what is
 * stored rather than trusting the flags saved beside it.
 */

export interface DraftView {
  id: number;
  leadId: number;
  companyId: number;
  agentId: number;
  status: string;
  toAddress: string | null;
  subject: string;
  body: string;
  parts: Omit<DraftParts, "subject">;
  problems: string[];
  warnings: string[];
  demoUrl?: string;
  createdAt: string;
  sentAt: string | null;
}

interface MessageRow {
  id: number;
  lead_id: number;
  company_id: number;
  agent_id: number;
  status: string;
  to_address: string | null;
  subject: string | null;
  body: string;
  personalisation: { observation?: string; problem?: string; solution?: string; cta?: string; demoUrl?: string } | null;
  guard_flags: string[] | null;
  created_at: Date;
  sent_at: Date | null;
}

const OPEN = ["draft", "pending_approval", "approved"];

function view(row: MessageRow): DraftView {
  const p = row.personalisation ?? {};
  const flags = row.guard_flags ?? [];
  return {
    id: row.id,
    leadId: row.lead_id,
    companyId: row.company_id,
    agentId: row.agent_id,
    status: row.status,
    toAddress: row.to_address,
    subject: row.subject ?? "",
    body: row.body,
    parts: { observation: p.observation ?? "", problem: p.problem ?? "", solution: p.solution ?? "", cta: p.cta ?? "" },
    problems: flags.filter((f) => !f.startsWith("warning:")),
    warnings: flags.filter((f) => f.startsWith("warning:")).map((f) => f.replace(/^warning:\s*/, "")),
    demoUrl: p.demoUrl,
    createdAt: row.created_at.toISOString(),
    sentAt: row.sent_at ? row.sent_at.toISOString() : null,
  };
}

const SELECT = `select m.id, m.lead_id, l.company_id, m.agent_id, m.status::text, m.to_address,
                       m.subject, m.body, m.personalisation, m.guard_flags, m.created_at, m.sent_at
                  from sales.message m join sales.lead l on l.id = m.lead_id`;

/** The newest draft for a lead that a person still has something to do with, or the last one sent. */
export async function draftForLead(leadId: number): Promise<DraftView | null> {
  if (!isConfigured()) return null;
  try {
    const rows = await query<MessageRow>(
      `${SELECT}
        where m.lead_id = $1 and m.direction = 'outbound'
          and m.status in ('draft', 'pending_approval', 'approved', 'sent')
        order by (m.status <> 'sent') desc, m.created_at desc
        limit 1`,
      [leadId],
    );
    return rows[0] ? view(rows[0]) : null;
  } catch {
    return null;
  }
}

async function messageById(messageId: number): Promise<DraftView | null> {
  const rows = await query<MessageRow>(`${SELECT} where m.id = $1 and m.direction = 'outbound'`, [messageId]);
  return rows[0] ? view(rows[0]) : null;
}

// --- pure ---------------------------------------------------------------------

/**
 * Put the edited parts into the stored body in place of the old ones.
 *
 * `assemble` (outreach/templates.ts) writes the opening and the problem as one
 * paragraph, then the solution, then the ask, each exactly once. Null when a
 * part cannot be found, so an edit never produces a body with the old copy
 * still in it.
 */
export function applyDraftEdit(body: string, before: Omit<DraftParts, "subject">, after: Omit<DraftParts, "subject">): string | null {
  const swaps: [string, string][] = [
    [`${before.observation} ${before.problem}`.trim(), `${after.observation.trim()} ${after.problem.trim()}`.trim()],
    [before.solution.trim(), after.solution.trim()],
    [before.cta.trim(), after.cta.trim()],
  ];
  let out = body;
  for (const [from, to] of swaps) {
    if (!from) return null;
    const at = out.indexOf(from);
    if (at < 0) return null;
    out = out.slice(0, at) + to + out.slice(at + from.length);
  }
  return out;
}

export function cleanParts(raw: Partial<Record<keyof DraftParts, unknown>>): DraftParts {
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\r\n/g, "\n").trim().slice(0, max) : "");
  return {
    subject: text(raw.subject, 200),
    observation: text(raw.observation, 1200),
    problem: text(raw.problem, 1200),
    solution: text(raw.solution, 1200),
    cta: text(raw.cta, 600),
  };
}

/** The guard flags as stored: problems as they are, warnings prefixed. */
export function flagsOf(guard: GuardResult): string[] {
  return [...guard.problems, ...guard.warnings.map((w) => `warning: ${w}`)];
}

// --- the guard's context, rebuilt ------------------------------------------------

/** The context the agent's draft was checked against, read again from the database. */
async function guardContext(draft: DraftView): Promise<GuardContext | { error: string }> {
  const [company] = await query<{ name: string; vertical_slug: string | null }>(
    `select name, vertical_slug from sales.company where id = $1`,
    [draft.companyId],
  );
  const [research] = await query<{ summary: string; signals: Record<string, unknown>; evidence: { quote: string }[] }>(
    `select summary, signals, evidence from sales.research_record where company_id = $1 order by created_at desc limit 1`,
    [draft.companyId],
  );
  if (!company) return { error: "The company behind this draft is gone." };
  if (!research) return { error: "There is no research on file, so nothing in the draft can be checked. Reject it instead." };
  let config: Awaited<ReturnType<typeof resolveAgentConfig>>["config"];
  try {
    config = (await resolveAgentConfig(draft.agentId)).config;
  } catch {
    return { error: "This agent's settings cannot be read, so the draft cannot be checked." };
  }
  const recent = await query<{ body: string }>(
    `select body from sales.message where agent_id = $1 and direction = 'outbound' and id <> $2 order by created_at desc limit 50`,
    [draft.agentId, draft.id],
  );
  const vocab = vocabularyFor(company.vertical_slug);
  // The same shape outreach/run.ts builds, so an edit is judged exactly as the draft was.
  const grounding = [
    research.summary,
    "",
    "Established facts:",
    ...Object.entries(research.signals ?? {})
      .filter(([, v]) => v !== null)
      .map(([k, v]) => `  ${k.replace(/_/g, " ")}: ${Array.isArray(v) ? v.join(", ") : v}`),
    "",
    "From their own pages:",
    ...(research.evidence ?? []).map((e) => `  "${e.quote}"`),
  ].join("\n");
  return {
    companyName: company.name,
    grounding,
    allowedClaims: config.belline_services.filter((slug) => {
      const service = SERVICES.find((s) => s.slug === slug);
      return !service?.flag || flag(service.flag);
    }),
    customerWord: vocab.word,
    forbiddenCustomerWords: vocab.forbidden,
    maxWords: config.outreach_strategy.max_words_first_touch,
    recentBodies: recent.map((r) => r.body),
    flagOn: (name) => flag(name as FlagName),
  };
}

// --- actions --------------------------------------------------------------------

export type DraftOutcome =
  | { ok: true; draft: DraftView; guard?: GuardResult }
  | { ok: false; status: number; error: string; problems?: string[]; warnings?: string[] };

function refuseNoDb(): DraftOutcome {
  return { ok: false, status: 503, error: "The sales database is not connected, so drafts cannot be changed." };
}

/** Save an edit. A draft the guards refuse is saved as held back, and cannot be approved until fixed. */
export async function saveDraftEdit(messageId: number, raw: Partial<Record<keyof DraftParts, unknown>>, user: User): Promise<DraftOutcome> {
  if (!isConfigured()) return refuseNoDb();
  const draft = await messageById(messageId);
  if (!draft) return { ok: false, status: 404, error: "No such draft." };
  if (!OPEN.includes(draft.status)) return { ok: false, status: 409, error: `This draft is already ${draft.status.replace(/_/g, " ")}.` };
  const next = cleanParts(raw);
  if (!next.subject || !next.observation || !next.solution || !next.cta) {
    return { ok: false, status: 422, error: "Subject, opening, how Belline helps and the ask all need some words." };
  }
  const body = applyDraftEdit(draft.body, draft.parts, next);
  if (body === null) {
    return { ok: false, status: 422, error: "This draft was written before editing was possible and its parts cannot be found in the email. Reject it and draft again." };
  }
  const ctx = await guardContext(draft);
  if ("error" in ctx) return { ok: false, status: 422, error: ctx.error };
  const guard = checkDraft(next, ctx);
  const status = guard.problems.length ? "draft" : "pending_approval";
  const actor = `user:${user.id}`;

  await tx(async (c) => {
    await c.query(
      `update sales.message
          set subject = $2, body = $3, status = $4::sales.msg_status, guard_flags = $5,
              personalisation = coalesce(personalisation, '{}'::jsonb) || $6::jsonb
        where id = $1`,
      [messageId, next.subject, body, status, JSON.stringify(flagsOf(guard)), JSON.stringify({ observation: next.observation, problem: next.problem, solution: next.solution, cta: next.cta, words: guard.wordCount, similarity: guard.similarity, editedBy: actor, editedAt: new Date().toISOString() })],
    );
    await c.query(
      `insert into sales.activity (lead_id, company_id, agent_id, actor, type, summary, data)
       values ($1, $2, $3, $4, 'drafted', $5, $6)`,
      [draft.leadId, draft.companyId, draft.agentId, actor, guard.problems.length ? `Draft edited, held back: ${guard.problems[0]}`.slice(0, 500) : `Draft edited: ${next.subject}`.slice(0, 500), JSON.stringify({ messageId, problems: guard.problems, warnings: guard.warnings })],
    );
  });
  await staffAudit({ actor: user, action: "draft_edited", entity: "message", entityId: messageId, before: { status: draft.status, subject: draft.subject }, after: { status, subject: next.subject, problems: guard.problems } });
  const saved = await messageById(messageId);
  return { ok: true, draft: saved!, guard };
}

export async function decideDraft(
  messageId: number,
  action: "approve" | "reject" | "reject_suppress",
  reason: string | null,
  user: User,
): Promise<DraftOutcome> {
  if (!isConfigured()) return refuseNoDb();
  const draft = await messageById(messageId);
  if (!draft) return { ok: false, status: 404, error: "No such draft." };
  if (!["pending_approval", "draft"].includes(draft.status) && !(action !== "approve" && draft.status === "approved")) {
    // Two people with the page open, or a double-click.
    return { ok: false, status: 409, error: `Already ${draft.status.replace(/_/g, " ")}.` };
  }
  if (action !== "approve" && (!reason || reason.trim().length < 3)) {
    // The reasons are the corpus that shows where the personaliser goes wrong.
    return { ok: false, status: 422, error: action === "reject_suppress" ? "Say why this company should never be contacted." : "Say what is wrong with this draft." };
  }
  const actor = `user:${user.id}`;

  let guard: GuardResult | undefined;
  if (action === "approve") {
    // Re-run on what is stored. A guard that trusts its own saved flags can be
    // bypassed by anything that writes the row.
    const ctx = await guardContext(draft);
    if ("error" in ctx) return { ok: false, status: 422, error: ctx.error };
    guard = checkDraft({ subject: draft.subject, ...draft.parts }, ctx);
    if (guard.problems.length) {
      await query(`update sales.message set guard_flags = $2, status = 'draft' where id = $1`, [messageId, JSON.stringify(flagsOf(guard))]);
      return { ok: false, status: 422, error: "The checks refused this draft. Fix it and save, or reject it.", problems: guard.problems, warnings: guard.warnings };
    }
  }

  const [lead] = await query<{ domain: string | null }>(`select c.domain from sales.lead l join sales.company c on c.id = l.company_id where l.id = $1`, [draft.leadId]);

  await tx(async (c) => {
    if (action === "approve") {
      await c.query(`update sales.message set status = 'approved', approved_by = $2, approved_at = now() where id = $1`, [messageId, actor]);
    } else {
      await c.query(`update sales.message set status = 'rejected', rejected_reason = $2 where id = $1`, [messageId, reason]);
    }
    if (action === "reject_suppress") {
      const source = `staff console: ${reason ?? ""}`.slice(0, 300);
      if (draft.toAddress) await suppress({ matchType: "email", value: draft.toAddress, reason: "manual", source, createdBy: actor, client: c });
      if (lead?.domain) await suppress({ matchType: "domain", value: lead.domain, reason: "manual", source, createdBy: actor, client: c });
      await suppress({ matchType: "company_id", value: String(draft.companyId), reason: "manual", source, createdBy: actor, client: c });
      await c.query(
        `update sales.lead set stage = 'do_not_contact', stage_changed_at = now(), updated_at = now(), closed_reason = $2 where id = $1`,
        [draft.leadId, reason],
      );
    }
    await c.query(
      `insert into sales.activity (lead_id, company_id, agent_id, actor, type, summary, data)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        draft.leadId,
        draft.companyId,
        draft.agentId,
        actor,
        action === "approve" ? "approved" : "rejected",
        (action === "approve" ? `Approved: ${draft.subject}` : `Rejected${action === "reject_suppress" ? ", do not contact" : ""}: ${reason ?? ""}`).slice(0, 500),
        JSON.stringify({ messageId, action, reason }),
      ],
    );
  });
  await staffAudit({ actor: user, action: `draft_${action}`, entity: "message", entityId: messageId, reason: reason ?? undefined, before: { status: draft.status }, after: { status: action === "approve" ? "approved" : "rejected" } });
  return { ok: true, draft: (await messageById(messageId))!, guard };
}

/**
 * A person sent the approved email from their own mail program. Records it,
 * and moves the lead to Contacted. Nothing is delivered from here.
 */
export async function markDraftSent(messageId: number, user: User): Promise<DraftOutcome> {
  if (!isConfigured()) return refuseNoDb();
  const draft = await messageById(messageId);
  if (!draft) return { ok: false, status: 404, error: "No such draft." };
  if (draft.status !== "approved") {
    return { ok: false, status: 409, error: draft.status === "sent" ? "Already marked as sent." : "Approve the draft before marking it sent." };
  }
  const actor = `user:${user.id}`;
  const who = user.name || user.email;
  await tx(async (c) => {
    await c.query(`update sales.message set status = 'sent', sent_at = now() where id = $1`, [messageId]);
    const lead = await c.query<{ stage: string }>(`select stage::text from sales.lead where id = $1 for update`, [draft.leadId]);
    const stage = lead.rows[0]?.stage;
    if (stage && ["discovered", "researching", "qualified"].includes(stage)) {
      await c.query(`update sales.lead set stage = 'contacted', stage_changed_at = now(), updated_at = now() where id = $1`, [draft.leadId]);
    }
    await c.query(
      `insert into sales.activity (lead_id, company_id, agent_id, actor, type, summary, data)
       values ($1, $2, $3, $4, 'sent', $5, $6)`,
      [draft.leadId, draft.companyId, draft.agentId, actor, `Sent by hand by ${who} from their own email: ${draft.subject}`.slice(0, 500), JSON.stringify({ messageId, by: "hand", from: stage ?? null })],
    );
  });
  await staffAudit({ actor: user, action: "draft_marked_sent", entity: "message", entityId: messageId, before: { status: "approved" }, after: { status: "sent", leadStage: "contacted" } });
  return { ok: true, draft: (await messageById(messageId))! };
}

/** Drafts waiting for a person, newest first: the old approval queue, for Today and the Leads filter. */
export async function draftsAwaitingReview(limit = 50): Promise<{ messageId: number; leadId: number; company: string; subject: string; held: boolean; createdAt: string }[]> {
  if (!isConfigured()) return [];
  try {
    const rows = await query<{ id: number; lead_id: number; company: string; subject: string | null; status: string; created_at: Date }>(
      `select m.id, m.lead_id, c.name as company, m.subject, m.status::text, m.created_at
         from sales.message m join sales.lead l on l.id = m.lead_id join sales.company c on c.id = l.company_id
        where m.direction = 'outbound' and m.status in ('pending_approval', 'draft')
        order by m.created_at desc limit $1`,
      [limit],
    );
    return rows.map((r) => ({ messageId: r.id, leadId: r.lead_id, company: r.company, subject: r.subject ?? "", held: r.status === "draft", createdAt: r.created_at.toISOString() }));
  } catch {
    return [];
  }
}

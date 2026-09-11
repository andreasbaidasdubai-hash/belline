import type pg from "pg";
import { query } from "../db/client";

/**
 * The suppression list.
 *
 * Rows are never deleted. An opt-out is permanent, it outlives a data-deletion
 * request (otherwise "delete me" becomes "contact me again next quarter"), and
 * it is global: someone who asked Belline to stop asked *Belline*, not the UAE
 * Dental Agent. See COMPLIANCE.md §2.
 *
 * Checked twice on every message — once at draft time so we do not spend a
 * model call on someone we may not write to, and again immediately before
 * sending, because an approval can be hours old and an opt-out can arrive in
 * between.
 */

export type SuppressionReason =
  | "opt_out"
  | "bounce"
  | "complaint"
  | "manual"
  | "legal"
  | "competitor"
  | "customer";

export interface SuppressionCheck {
  email?: string | null;
  domain?: string | null;
  phone?: string | null;
  companyId?: number | null;
}

/**
 * Returns a human-readable reason when the target is suppressed, else null.
 *
 * Domain matching is what makes this useful rather than theatrical: a person
 * who opts out at `info@clinic.ae` has opted out for `manager@clinic.ae` too,
 * and treating those as different addresses is how a business receives a
 * second email after asking you to stop.
 */
export async function isSuppressed(check: SuppressionCheck): Promise<string | null> {
  const clauses: string[] = [];
  const params: unknown[] = [];

  const add = (matchType: string, value: string) => {
    params.push(value.toLowerCase());
    clauses.push(`(match_type = '${matchType}' and lower(value) = $${params.length})`);
  };

  if (check.email) {
    add("email", check.email.trim());
    const at = check.email.indexOf("@");
    if (at > -1) add("domain", check.email.slice(at + 1).trim());
  }
  if (check.domain) add("domain", check.domain.replace(/^www\./i, "").trim());
  if (check.phone) add("phone", check.phone.trim());
  if (check.companyId) add("company_id", String(check.companyId));

  if (clauses.length === 0) return null;

  const rows = await query<{ reason: string; match_type: string; value: string }>(
    `select reason, match_type, value from sales.suppression
      where ${clauses.join(" or ")}
      limit 1`,
    params,
  );

  const hit = rows[0];
  return hit ? `${hit.reason} (${hit.match_type} ${hit.value})` : null;
}

export interface SuppressInput {
  matchType: "email" | "domain" | "phone" | "company_id";
  value: string;
  reason: SuppressionReason;
  source?: string;
  createdBy?: string;
  scope?: "global" | "country" | "agent";
  scopeId?: string;
  client?: pg.PoolClient;
}

/**
 * Add to the list. Idempotent — suppressing an already-suppressed address is a
 * no-op rather than an error, because the same opt-out can legitimately arrive
 * twice (a reply and an unsubscribe click).
 */
export async function suppress(input: SuppressInput): Promise<void> {
  const sql = `
    insert into sales.suppression (scope, scope_id, match_type, value, reason, source, created_by)
    values ($1, $2, $3, $4, $5, $6, $7)
    on conflict (scope, coalesce(scope_id, ''), match_type, lower(value)) do nothing`;
  const params = [
    input.scope ?? "global",
    input.scopeId ?? null,
    input.matchType,
    input.value.trim(),
    input.reason,
    input.source ?? null,
    input.createdBy ?? "system",
  ];

  if (input.client) {
    await input.client.query(sql, params);
    return;
  }
  await query(sql, params);
}

/**
 * Phrases that mean "stop", per language.
 *
 * Matched deterministically *before* any classifier sees the reply. Asking a
 * model whether someone really meant to opt out is not a question this system
 * asks — a regex match is authoritative and final.
 */
const OPT_OUT_PHRASES = [
  /\bunsubscribe\b/i,
  /\bremove me\b/i,
  /\btake me off\b/i,
  /\bopt[- ]?out\b/i,
  /\bstop (?:emailing|contacting|writing)\b/i,
  /^\s*stop\s*$/i,
  /\bdo not (?:contact|email|write)\b/i,
  /\bno longer wish\b/i,
  // Arabic
  /ألغ(?:ِ|ي)? الاشتراك/,
  /توقف عن (?:المراسلة|الإرسال)/,
  /لا تراسلني/,
  // German
  /\babmelden\b/i,
  /\bkeine weiteren\b/i,
  /\bbitte keine\b/i,
  // French
  /\bdésinscri/i,
  /\bne plus (?:me )?contacter\b/i,
];

/** True when a reply is an opt-out. Deterministic by design. */
export function looksLikeOptOut(text: string): boolean {
  const body = text.slice(0, 2000);
  return OPT_OUT_PHRASES.some((p) => p.test(body));
}

import crypto from "node:crypto";
import type { ExceptionKind, SupportException, User } from "./types";
import { getLocation, getTenant, id, listExceptionRows, saveExceptionRow } from "./store";
import { isBellineStaff } from "./auth";
import { deliverEmail } from "./mailer";
import { redact } from "./errors/customer";

/**
 * The staff exceptions queue: everything a person at Belline has to do.
 *
 * Self-serve is the product, so each row here is a gap in it, and a row is
 * only opened for something the owner cannot fix alone — no number in the
 * pool, Meta refusing a WhatsApp number twice, somebody locked out with email
 * switched off, or an owner who has asked for a person twice. The queue says
 * why, what to do next, and records the minutes it took to clear.
 *
 * One open row per venue and kind. Raising the same thing again while it is
 * open counts it on that row rather than adding another, so a page that
 * raises on every render cannot flood the queue.
 *
 * JSON-backed, like the rest of the store. The plan's Postgres table is the
 * same shape and can replace `listExceptionRows`/`saveExceptionRow` alone.
 */

export const EXCEPTION_KINDS: readonly ExceptionKind[] = [
  "pool_empty",
  "number_assign_failed",
  "forwarding_unverified_2x",
  "whatsapp_rejected",
  "whatsapp_token_expired",
  "import_failed_3x",
  "payment_failed_final",
  "stripe_off_trial_end",
  "deletion_legal_hold",
  "owner_requested_human",
  "vendor_balance_low",
  "webhook_failures",
  "billing_dispute",
  "account_recovery",
  "handoff_requested",
  "google_sync_failed",
];

interface KindMeta {
  label: string;
  /** What the person picking it up does first. */
  next: string;
  /** May Belle open it for an owner? Only kinds no owner can fix alone. */
  belle: boolean;
}

export const KIND_META: Record<ExceptionKind, KindMeta> = {
  pool_empty: { label: "No number available", next: "Buy or assign a number for this venue, then tell the owner it is on the Go live page.", belle: true },
  number_assign_failed: { label: "Number could not be assigned", next: "Check the number in Twilio and assign it by hand.", belle: true },
  forwarding_unverified_2x: { label: "Forwarding failed twice", next: "Call the owner and walk through their carrier or phone system settings.", belle: true },
  whatsapp_rejected: { label: "WhatsApp number refused", next: "Read Meta's reason and help the owner with the next attempt.", belle: true },
  whatsapp_token_expired: { label: "WhatsApp access expired", next: "Reconnect the WhatsApp account; the owner has nothing to do.", belle: true },
  import_failed_3x: { label: "Reading the business failed", next: "Look at the site or file and fill the draft in by hand if needed.", belle: false },
  payment_failed_final: { label: "Final payment failed", next: "Contact the owner before service stops.", belle: true },
  stripe_off_trial_end: { label: "Trial ended with payments off", next: "Confirm the automatic extension and plan the owner's first payment.", belle: false },
  deletion_legal_hold: { label: "Deletion on legal hold", next: "Check the hold before anything is deleted.", belle: false },
  owner_requested_human: { label: "Owner asked for a person", next: "Read the excerpt and contact the owner at the address on the account.", belle: true },
  vendor_balance_low: { label: "Provider balance low", next: "Top up the provider account.", belle: false },
  webhook_failures: { label: "Webhooks failing", next: "Check the provider's delivery log and the server logs.", belle: false },
  billing_dispute: { label: "Billing question", next: "Check the subscription and invoices, then reply to the owner.", belle: true },
  account_recovery: {
    label: "Locked out, email off",
    next: "Write to the address on the account and confirm it is them before resetting the password.",
    belle: false,
  },
  handoff_requested: { label: "Prospect asked for a person", next: "Reply in the Belline inbox.", belle: false },
  google_sync_failed: {
    label: "Bookings not reaching Google Calendar",
    next: "Check the server log for the venue's [google] lines. Belline retries on its own; if Google keeps refusing, ask the owner to reconnect.",
    belle: false,
  },
};

export function isExceptionKind(value: unknown): value is ExceptionKind {
  return typeof value === "string" && (EXCEPTION_KINDS as readonly string[]).includes(value);
}

/** Kinds Belle may open on an owner's behalf. */
export const BELLE_KINDS: ExceptionKind[] = EXCEPTION_KINDS.filter((k) => KIND_META[k].belle);

export interface OpenInput {
  tenantId: string;
  locationId?: string;
  kind: ExceptionKind;
  reason: string;
  context?: Record<string, unknown>;
  source: SupportException["source"];
}

export interface Opened {
  exception: SupportException;
  created: boolean;
  /** Resolves once the team alert is written. Only awaited by tests. */
  notified: Promise<boolean>;
}

// No 0/O or 1/I: a ticket is read out and typed back.
const TICKET_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function newTicket(taken: Set<string>): string {
  for (;;) {
    const bytes = crypto.randomBytes(4);
    const code = `B-${[...bytes].map((b) => TICKET_ALPHABET[b % TICKET_ALPHABET.length]).join("")}`;
    if (!taken.has(code)) return code;
  }
}

/**
 * What makes two raises the same thing: the venue (or, with none, the person)
 * and the kind — and the conversation, when one is named, so two prospects
 * asking for a person on Belline's own line are two rows.
 */
function subjectOf(row: Pick<SupportException, "tenantId" | "locationId" | "kind" | "context">): string {
  const conversation = row.context.conversationId === undefined ? "" : `conv:${String(row.context.conversationId)}`;
  return [row.tenantId, row.locationId ?? `user:${String(row.context.userId ?? "")}`, row.kind, conversation].join("|");
}

export function openException(input: OpenInput, now: Date = new Date()): Opened {
  const at = now.toISOString();
  const context = input.context ?? {};
  const reason = input.reason.trim().slice(0, 500) || KIND_META[input.kind].label;
  const rows = listExceptionRows();
  const subject = subjectOf({ ...input, context });
  const existing = rows.find((r) => r.status !== "resolved" && subjectOf(r) === subject);

  if (existing) {
    const updated = saveExceptionRow({ ...existing, count: existing.count + 1, lastRaisedAt: at, context: { ...existing.context, ...context } });
    return { exception: updated, created: false, notified: Promise.resolve(false) };
  }

  const row: SupportException = {
    id: id("exc"),
    ticket: newTicket(new Set(rows.map((r) => r.ticket))),
    tenantId: input.tenantId,
    ...(input.locationId ? { locationId: input.locationId } : {}),
    kind: input.kind,
    reason,
    context,
    source: input.source,
    status: "open",
    count: 1,
    openedAt: at,
    lastRaisedAt: at,
  };
  saveExceptionRow(row);
  // The same line shape raiseException always logged, so log alerts keep working.
  console.error(`[exception] ${row.kind} ${row.ticket}: ${redact(reason)}`);
  return { exception: row, created: true, notified: notifyTeam(row) };
}

/** One alert per new row. Real email only with `email.transactional`; the outbox otherwise. */
async function notifyTeam(row: SupportException): Promise<boolean> {
  const venue = row.locationId ? getLocation(row.locationId) : undefined;
  const who = venue?.name ?? getTenant(row.tenantId)?.name ?? row.tenantId;
  const meta = KIND_META[row.kind];
  const text = [
    `${meta.label} — ${who}`,
    ``,
    `Why: ${row.reason}`,
    `Next: ${meta.next}`,
    `Ticket ${row.ticket}, opened by ${row.source}. Queue: /sales/exceptions`,
  ].join("\n");
  try {
    const out = await deliverEmail({
      to: process.env.EXCEPTIONS_EMAIL?.trim() || "exceptions-queue",
      subject: `[${row.ticket}] ${meta.label} — ${who}`,
      text,
      html: `<pre style="font:14px/1.5 system-ui,sans-serif;white-space:pre-wrap">${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>`,
    });
    return out.via !== "none";
  } catch {
    return false;
  }
}

export interface ExceptionFilter {
  status?: SupportException["status"] | "unresolved" | "all";
  kind?: ExceptionKind;
  tenantId?: string;
  locationId?: string;
}

export function listExceptions(filter: ExceptionFilter = {}): SupportException[] {
  const status = filter.status ?? "unresolved";
  return listExceptionRows()
    .filter((r) => {
      if (status === "unresolved" && r.status === "resolved") return false;
      if (status !== "unresolved" && status !== "all" && r.status !== status) return false;
      if (filter.kind && r.kind !== filter.kind) return false;
      if (filter.tenantId && r.tenantId !== filter.tenantId) return false;
      if (filter.locationId && r.locationId !== filter.locationId) return false;
      return true;
    })
    .sort((a, b) => b.lastRaisedAt.localeCompare(a.lastRaisedAt));
}

/** Staff see every row; anybody else only their own tenant's. */
export function exceptionsVisibleTo(user: User, filter: ExceptionFilter = {}): SupportException[] {
  return isBellineStaff(user) ? listExceptions(filter) : listExceptions({ ...filter, tenantId: user.tenantId });
}

/** What an owner is shown about a ticket: never the internal reason or context. */
export interface OwnerTicket {
  ticket: string;
  status: string;
  openedAt: string;
}

const OWNER_STATUS: Record<SupportException["status"], string> = {
  open: "The Belline team is on it",
  waiting_customer: "Waiting for your reply",
  resolved: "Resolved",
};

export function ownerTickets(locationId: string): OwnerTicket[] {
  return listExceptions({ locationId }).map((r) => ({ ticket: r.ticket, status: OWNER_STATUS[r.status], openedAt: r.openedAt }));
}

export type UpdateResult = { ok: true; exception: SupportException } | { ok: false; status: number; error: string };

export function updateException(
  exceptionId: string,
  action: { kind: "resolve"; note: unknown; minutes: unknown; by: string } | { kind: "waiting"; by: string },
  now: Date = new Date(),
): UpdateResult {
  const row = listExceptionRows().find((r) => r.id === exceptionId);
  if (!row) return { ok: false, status: 404, error: "No such exception." };
  if (row.status === "resolved") return { ok: false, status: 409, error: "Already resolved." };

  if (action.kind === "waiting") {
    return { ok: true, exception: saveExceptionRow({ ...row, status: "waiting_customer" }) };
  }

  const note = typeof action.note === "string" ? action.note.trim().slice(0, 1000) : "";
  if (note.length < 3) return { ok: false, status: 422, error: "Write what was done before resolving." };
  const minutes = Number(action.minutes);
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 24 * 60) {
    return { ok: false, status: 422, error: "Minutes spent must be a whole number from 0 to 1440." };
  }
  return {
    ok: true,
    exception: saveExceptionRow({ ...row, status: "resolved", resolvedAt: now.toISOString(), resolvedBy: action.by, resolution: note, humanMinutes: minutes }),
  };
}

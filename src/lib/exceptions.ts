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
  "trial_cap_reached",
  "packs_held_payments_off",
  "whatsapp_assisted_setup",
  "deletion_legal_hold",
  "owner_requested_human",
  "vendor_balance_low",
  "webhook_failures",
  "billing_dispute",
  "account_recovery",
  "handoff_requested",
  "video_calls_cut_short",
  "video_provider_at_capacity",
  "video_session_never_answered",
  "google_sync_failed",
  "google_token_expired",
  "google_misconfigured",
  "google_connect_abandoned",
  "outlook_sync_failed",
  "outlook_token_expired",
  "outlook_misconfigured",
  "outlook_connect_abandoned",
  "outlook_admin_approval",
  "calendly_token_expired",
  "calendly_misconfigured",
  "calendly_connect_abandoned",
  "calendly_plan_blocked",
  "calendly_rate_limited",
  "calendly_booking_failed",
  "calendly_cancel_failed",
  "email_unverified",
];

interface KindMeta {
  label: string;
  /** What the person picking it up does first. */
  next: string;
  /** May Belle open it for an owner? Only kinds no owner can fix alone. */
  belle: boolean;
}

export const KIND_META: Record<ExceptionKind, KindMeta> = {
  pool_empty: { label: "No number available", next: "Buy or assign a number for this venue, then tell the owner it is on their Phone page (Channels, then Phone).", belle: true },
  number_assign_failed: { label: "Number could not be assigned", next: "Check the number in Twilio and assign it by hand.", belle: true },
  forwarding_unverified_2x: { label: "Forwarding failed twice", next: "Call the owner and walk through their carrier or phone system settings.", belle: true },
  whatsapp_rejected: { label: "WhatsApp number refused", next: "Read Meta's reason and help the owner with the next attempt.", belle: true },
  whatsapp_token_expired: { label: "WhatsApp access expired", next: "Reconnect the WhatsApp account; the owner has nothing to do.", belle: true },
  import_failed_3x: { label: "Reading the business failed", next: "Look at the site or file and fill the draft in by hand if needed.", belle: false },
  payment_failed_final: { label: "Final payment failed", next: "Contact the owner before service stops.", belle: true },
  stripe_off_trial_end: { label: "Trial ended with payments off", next: "Confirm the automatic extension and plan the owner's first payment.", belle: false },
  trial_cap_reached: {
    label: "Trial allowance used, payments off",
    next: "Belline has stopped the used-up channels. Contact the owner and plan their first payment.",
    belle: false,
  },
  packs_held_payments_off: {
    label: "Allowance used, no pack while payments off",
    next: "The owner chose packs, but none can be charged yet, so Belline has stopped that allowance's channels. Contact the owner and plan their first payment.",
    belle: false,
  },
  whatsapp_assisted_setup: {
    label: "Owner wants WhatsApp set up",
    next: "Contact the owner, register their second WhatsApp number with Meta and connect it to the venue.",
    belle: true,
  },
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
  video_calls_cut_short: {
    label: "Video calls ending early",
    next: "The provider is ending calls before the length we ask for, and no API reports the plan or the minutes left. Open the Tavus dashboard: check the plan's maximum conversation duration and whether the month's CVI minutes are used up. Until it is fixed the pages stop promising a length they cannot keep.",
    belle: false,
  },
  video_provider_at_capacity: {
    label: "Video provider full",
    next: "Tavus refused a call because the account is at its concurrent-conversation limit, so a visitor was turned away after we had already said yes. No API reports the plan's number: open the Tavus dashboard, read the tier's concurrency, and set VIDEO_PROVIDER_MAX_CONCURRENT to it (or below). Until it matches, our own ceilings can promise more rooms than the account has.",
    belle: false,
  },
  video_session_never_answered: {
    label: "Video call nobody was answered on",
    next: "A video call ran and the provider never asked us for a single word, so the visitor heard the opening and then nothing. Read the [video] lines for the session id on it: `joined=false` means the browser never got into the room — check the microphone gate and the Tavus participant_absent_timeout; `joined=true` means the room was fine and the visitor was never heard, which points at the microphone or the panel's quiet prompt.",
    belle: false,
  },
  google_sync_failed: {
    label: "Bookings not reaching Google Calendar",
    next: "Check the server log for the venue's [google] lines. Belline retries on its own; if Google keeps refusing, ask the owner to reconnect.",
    belle: false,
  },
  google_token_expired: {
    label: "Google Calendar access expired",
    next: "The venue is on requests and the owner has a banner. If they do not reconnect within a day, contact them.",
    belle: false,
  },
  google_misconfigured: {
    label: "Google project refusing Belline",
    next: "Read the reason: usually the Google Calendar API is not enabled on the project. Fix it in Google Cloud; the sweep clears the venue on its own.",
    belle: false,
  },
  google_connect_abandoned: {
    label: "Google connection never came back",
    next: "While the Google app is in Testing, add the owner's Google address to the test users, then ask them to connect again.",
    belle: false,
  },
  outlook_sync_failed: {
    label: "Bookings not reaching Outlook",
    next: "Check the server log for the venue's [outlook] lines. Belline retries on its own; if Microsoft keeps refusing, ask the owner to reconnect.",
    belle: false,
  },
  outlook_token_expired: {
    label: "Outlook access expired",
    next: "The venue is on requests and the owner has a banner. If they do not reconnect within a day, contact them.",
    belle: false,
  },
  outlook_misconfigured: {
    label: "Microsoft refusing Belline's app",
    next: "Read the reason: a wrong or expired MICROSOFT_CLIENT_SECRET, a client id Microsoft does not know, or a redirect address missing from the Entra app registration. Fix it in Entra; the sweep clears the venue on its own.",
    belle: false,
  },
  outlook_connect_abandoned: {
    label: "Outlook connection never came back",
    next: "Usually a work account whose organisation needs its IT admin to approve Belline. Contact the owner, and send their IT admin the approval link in the reason.",
    belle: false,
  },
  outlook_admin_approval: {
    label: "Organisation must approve Belline for Outlook",
    next: "Contact the owner and send their IT admin the approval link in the reason. Publisher verification of Belline's Entra app removes most of these.",
    belle: false,
  },
  calendly_token_expired: {
    label: "Calendly access expired",
    next: "The venue is on requests and the owner has a banner. Usually they removed Belline under Integrations in their Calendly account. If they do not reconnect within a day, contact them.",
    belle: false,
  },
  calendly_misconfigured: {
    label: "Calendly refusing Belline's app",
    next: "Read the reason: a wrong CALENDLY_CLIENT_ID or CALENDLY_CLIENT_SECRET, a redirect address missing from the OAuth application, or a scope it was not registered with. Fix it in Calendly's developer portal; the sweep clears the venue on its own.",
    belle: false,
  },
  calendly_connect_abandoned: {
    label: "Calendly connection never came back",
    next: "Usually the owner closed the window. Check the OAuth application's redirect address matches Belline's before contacting them.",
    belle: false,
  },
  calendly_plan_blocked: {
    label: "Calendly plan will not take bookings",
    next: "Making a booking through Calendly's API needs a paid Calendly plan. The venue is on requests and the owner has been told. Contact them about their Calendly subscription, or move them to Google Calendar or Outlook.",
    belle: false,
  },
  calendly_rate_limited: {
    label: "Calendly booking limit reached",
    next: "Calendly caps how many bookings an app may make for one account: about a hundred a day on a paid plan, five on a trial. Callers were taken as requests, so nothing is lost. A venue that books more than that every day needs a different destination, and should be told.",
    belle: false,
  },
  calendly_booking_failed: {
    label: "Calendly refused a booking",
    next: "The caller was told Belline could not confirm and was taken as a message, so nothing was promised. Check the server log for the venue's [calendly] lines, and whether the owner's event types have changed.",
    belle: false,
  },
  calendly_cancel_failed: {
    label: "Cancellation not reaching Calendly",
    next: "The customer has been told their booking is cancelled, but the slot is still held in the owner's Calendly. Belline retries on its own; if it does not clear, cancel it in Calendly by hand and tell the owner.",
    belle: false,
  },
  email_unverified: {
    label: "New owner's email not confirmed, email off",
    next: "Write to the address on the account. When they reply, mark the email confirmed in Abuse review; until then Belline does no paid setup work for them.",
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
    `Ticket ${row.ticket}, opened by ${row.source}. Queue: /sales/issues`,
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

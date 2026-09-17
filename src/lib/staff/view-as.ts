import crypto from "node:crypto";
import type { Session, User, ViewAsGrant } from "../types";
import { deleteSessions, getSession, getTenant, getUser, listUsersFor, pruneSessions, saveSession } from "../store";
import { isBellineStaff } from "../auth";
import { staffAudit } from "./audit";

/**
 * "View as customer (read-only)".
 *
 * A member of Belline staff opens a customer's dashboard exactly as the
 * customer's owner sees it, to answer "what are they looking at?" without
 * asking for a password or a screen share. Built so that looking cannot turn
 * into doing:
 *
 *   · a separate session, not the staff member's own, naming the customer's
 *     owner and carrying `viewAs`; the staff session is kept aside and given
 *     back on exit
 *   · thirty minutes, then the session is gone
 *   · every request on it passes through `viewAsRefusal` in server.ts before
 *     Next sees it: anything but GET, HEAD or the exit is refused with 403, and
 *     no voice socket is opened
 *   · the GETs that remain run inside a read-only context (readonly.ts), so a
 *     store or database write reached from a page throws before it changes
 *     anything
 *   · start and exit are audited; the customer's last sign-in is not touched
 *
 * No `next/*` imports, because server.ts calls it.
 */

export const VIEW_AS_MINUTES = 30;
export const VIEW_AS_EXIT_PATH = "/api/view-as/exit";

export type StartResult = { ok: true; session: Session; ownerName: string } | { ok: false; status: number; error: string };

export async function startViewAs(
  staff: User,
  staffSessionId: string | undefined,
  tenantId: string,
  reason: string,
  opts: { now?: Date; userAgent?: string } = {},
): Promise<StartResult> {
  if (!isBellineStaff(staff)) return { ok: false, status: 403, error: "Belline staff only." };
  const current = staffSessionId ? getSession(staffSessionId) : undefined;
  if (current?.viewAs) return { ok: false, status: 409, error: "Exit the current view first." };
  const tenant = getTenant(tenantId);
  if (!tenant || tenant.internal) return { ok: false, status: 404, error: "No such customer." };
  const owner = listUsersFor(tenantId).find((u) => u.role === "owner" && !u.disabled);
  if (!owner) return { ok: false, status: 409, error: "This customer has no active owner to view as." };
  if (reason.trim().length < 3) return { ok: false, status: 422, error: "Say why you are opening their dashboard. It goes in the audit log." };

  const now = opts.now ?? new Date();
  const expiresAt = new Date(now.getTime() + VIEW_AS_MINUTES * 60_000).toISOString();
  pruneSessions();
  const grant: ViewAsGrant = {
    staffUserId: staff.id,
    tenantId,
    startedAt: now.toISOString(),
    expiresAt,
    ...(current && current.userId === staff.id ? { returnSessionId: current.id } : {}),
    reason: reason.trim().slice(0, 500),
  };
  // Not `startSession`: that stamps the owner's lastSeenAt, and the customer
  // page shows it as their last sign-in.
  const session: Session = {
    id: crypto.randomBytes(32).toString("base64url"),
    userId: owner.id,
    createdAt: grant.startedAt,
    expiresAt,
    userAgent: opts.userAgent?.slice(0, 200),
    viewAs: grant,
  };
  saveSession(session);
  await staffAudit({ actor: staff, action: "view_as_started", entity: "tenant", entityId: tenantId, reason: grant.reason, after: { asUserId: owner.id, expiresAt } }, now);
  return { ok: true, session, ownerName: owner.name || owner.email };
}

export interface ViewAsState {
  grant: ViewAsGrant;
  businessName: string;
  minutesLeft: number;
}

/** The view a session id is on, if it is one and has not run out. */
export function viewAsState(sessionId: string | undefined, now = Date.now()): ViewAsState | null {
  if (!sessionId) return null;
  const session = getSession(sessionId);
  if (!session?.viewAs) return null;
  const left = Date.parse(session.viewAs.expiresAt) - now;
  if (!(left > 0)) return null;
  return {
    grant: session.viewAs,
    businessName: getTenant(session.viewAs.tenantId)?.name ?? "this customer",
    minutesLeft: Math.max(1, Math.ceil(left / 60_000)),
  };
}

/** End a view. Returns the staff member's own session id when it is still valid, to put back in the cookie. */
export async function exitViewAs(sessionId: string | undefined, now = new Date()): Promise<{ returnSessionId: string | null }> {
  const session = sessionId ? getSession(sessionId) : undefined;
  if (!session?.viewAs) return { returnSessionId: null };
  const grant = session.viewAs;
  deleteSessions({ sessionId: session.id });
  const staff = getUser(grant.staffUserId);
  if (staff) {
    await staffAudit({ actor: staff, action: "view_as_ended", entity: "tenant", entityId: grant.tenantId, after: { expired: Date.parse(grant.expiresAt) <= now.getTime() } }, now);
  }
  const back = grant.returnSessionId ? getSession(grant.returnSessionId) : undefined;
  const valid = back && back.userId === grant.staffUserId && back.expiresAt > now.toISOString() && !back.viewAs;
  return { returnSessionId: valid ? back.id : null };
}

/**
 * What the server does with a request on a view-as session.
 *
 * Pure, so the check can walk every method. `null` means let it through
 * (inside a read-only context); anything else is the status to answer with.
 */
export function viewAsRefusal(method: string | undefined, pathname: string): { status: number; error: string } | null {
  const m = (method ?? "GET").toUpperCase();
  if (pathname === VIEW_AS_EXIT_PATH) return null;
  if (m === "GET" || m === "HEAD") return null;
  return { status: 403, error: "You are viewing this dashboard as the customer, read-only. Nothing can be changed. Exit the view to make changes." };
}

export type ViewAsDecision =
  /** Not a view-as session: carry on as normal. */
  | { kind: "normal" }
  /** The exit route, which must be able to write. */
  | { kind: "exit" }
  /** The view ran out: send them to the exit, which gives their own session back. */
  | { kind: "expired" }
  | { kind: "refuse"; status: number; error: string }
  /** Let it through, inside a read-only context. */
  | { kind: "read_only"; grant: ViewAsGrant };

/** The whole decision server.ts makes for one HTTP request. */
export function decideViewAs(sessionId: string | undefined, method: string | undefined, pathname: string, now = Date.now()): ViewAsDecision {
  const session = sessionId ? getSession(sessionId) : undefined;
  if (!session?.viewAs) return { kind: "normal" };
  if (pathname === VIEW_AS_EXIT_PATH) return { kind: "exit" };
  if (!viewAsState(sessionId, now)) return { kind: "expired" };
  const refusal = viewAsRefusal(method, pathname);
  if (refusal) return { kind: "refuse", ...refusal };
  return { kind: "read_only", grant: session.viewAs };
}

/** Is this cookie's session a view? Voice sockets spend money and act for the venue: never on one. */
export function isViewAsSession(sessionId: string | undefined): boolean {
  return Boolean(sessionId && getSession(sessionId)?.viewAs);
}

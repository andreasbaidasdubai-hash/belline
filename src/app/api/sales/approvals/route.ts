import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import { isConfigured, one, tx } from "@/lib/sales/db/client";
import { audit, log } from "@/lib/sales/db/repo/activity";
import { suppress } from "@/lib/sales/compliance/suppression";

export const dynamic = "force-dynamic";

/**
 * Approve or reject one drafted message.
 *
 * Route handlers are not covered by the `(internal)` layout's guard, so this
 * checks for itself — and checks for `owner` specifically, because approving
 * outbound is Belline's decision, not a venue manager's.
 *
 * An approved message does not send here. It becomes `approved`, and the send
 * step re-runs every guard — suppression, frequency caps, send window, budget
 * — because an approval can be hours old and an opt-out can arrive in the gap.
 */
export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  // Belline staff, not any owner — see isBellineStaff.
  if (!isBellineStaff(auth.user)) {
    return NextResponse.json({ error: "Not permitted." }, { status: 403 });
  }
  if (!isConfigured()) {
    return NextResponse.json({ error: "The sales database is not configured." }, { status: 503 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    messageId?: unknown;
    action?: unknown;
    reason?: unknown;
  };

  const messageId = Number(body.messageId);
  const action = String(body.action ?? "");
  const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : null;

  if (!Number.isInteger(messageId) || messageId <= 0) {
    return NextResponse.json({ error: "Which message?" }, { status: 400 });
  }
  if (!["approve", "reject", "reject_suppress"].includes(action)) {
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }

  const message = await one<{
    id: number;
    lead_id: number;
    company_id: number;
    agent_id: number;
    status: string;
    to_address: string | null;
    subject: string | null;
    guard_flags: string[];
    domain: string | null;
  }>(
    `select m.id, m.lead_id, l.company_id, m.agent_id, m.status::text,
            m.to_address, m.subject, m.guard_flags, c.domain
       from sales.message m
       join sales.lead l on l.id = m.lead_id
       join sales.company c on c.id = l.company_id
      where m.id = $1`,
    [messageId],
  );

  if (!message) return NextResponse.json({ error: "No such message." }, { status: 404 });
  if (!["pending_approval", "draft"].includes(message.status)) {
    // Two people with the queue open, or a double-click.
    return NextResponse.json(
      { error: `Already ${message.status.replace(/_/g, " ")}.` },
      { status: 409 },
    );
  }

  const problems = (message.guard_flags ?? []).filter((f) => !f.startsWith("warning:"));
  if (action === "approve" && problems.length > 0) {
    // Refused server-side as well as hidden in the UI: a guard that can be
    // bypassed by a crafted request is not a guard.
    return NextResponse.json(
      { error: `Blocked by a guard: ${problems[0]}` },
      { status: 422 },
    );
  }

  const actor = `user:${auth.user.id}`;

  await tx(async (c) => {
    if (action === "approve") {
      await c.query(
        `update sales.message
            set status = 'approved', approved_by = $2, approved_at = now()
          where id = $1`,
        [messageId, actor],
      );
    } else {
      await c.query(
        `update sales.message set status = 'rejected', rejected_reason = $2 where id = $1`,
        [messageId, reason],
      );
    }

    if (action === "reject_suppress") {
      if (message.to_address) {
        await suppress({
          matchType: "email",
          value: message.to_address,
          reason: "manual",
          source: `approval queue: ${reason ?? "no reason given"}`,
          createdBy: actor,
          client: c,
        });
      }
      await suppress({
        matchType: "company_id",
        value: String(message.company_id),
        reason: "manual",
        source: `approval queue: ${reason ?? "no reason given"}`,
        createdBy: actor,
        client: c,
      });
      await c.query(
        `update sales.lead
            set stage = 'do_not_contact', stage_changed_at = now(), closed_reason = $2
          where id = $1`,
        [message.lead_id, reason],
      );
    }

    await log({
      client: c,
      leadId: message.lead_id,
      companyId: message.company_id,
      agentId: message.agent_id,
      actor,
      type: action === "approve" ? "approved" : "rejected",
      summary:
        action === "approve"
          ? `Approved: ${message.subject ?? ""}`
          : `Rejected${action === "reject_suppress" ? " and suppressed" : ""}: ${reason ?? ""}`,
      data: { messageId, action, reason },
    });

    await audit({
      client: c,
      actor,
      action,
      entity: "message",
      entityId: messageId,
      before: { status: message.status },
      after: { status: action === "approve" ? "approved" : "rejected", reason },
    });
  });

  return NextResponse.json({ ok: true });
}

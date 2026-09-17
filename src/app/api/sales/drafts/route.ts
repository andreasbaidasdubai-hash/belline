import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import { decideDraft, markDraftSent, saveDraftEdit } from "@/lib/staff/drafts";
import { cleanReason } from "@/lib/staff/audit";

export const dynamic = "force-dynamic";

/**
 * The email draft on a lead's page.
 *
 *   POST { messageId, action: "save", subject, observation, problem, solution, cta }
 *   POST { messageId, action: "approve" }
 *   POST { messageId, action: "reject" | "reject_suppress", reason }
 *   POST { messageId, action: "mark_sent" }
 *
 * There is no sender. Approving records the decision; "mark_sent" records that
 * a person sent the approved text from their own email program. The pre-send
 * guards run on every save and again on approve, on what is stored, and a
 * refused draft cannot be approved from here or anywhere else.
 *
 * Belline staff only, checked here: route handlers are not covered by the
 * console layout.
 */
export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!isBellineStaff(auth.user)) return NextResponse.json({ error: "Belline staff only." }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const messageId = Number(body.messageId);
  if (!Number.isInteger(messageId) || messageId <= 0) return NextResponse.json({ error: "Which draft?" }, { status: 400 });

  let out;
  switch (body.action) {
    case "save":
      out = await saveDraftEdit(messageId, body, auth.user);
      break;
    case "approve":
      out = await decideDraft(messageId, "approve", null, auth.user);
      break;
    case "reject":
    case "reject_suppress":
      out = await decideDraft(messageId, body.action, cleanReason(body.reason) || null, auth.user);
      break;
    case "mark_sent":
      out = await markDraftSent(messageId, auth.user);
      break;
    default:
      return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }
  if (!out.ok) return NextResponse.json({ error: out.error, problems: out.problems, warnings: out.warnings }, { status: out.status });
  return NextResponse.json({ ok: true, status: out.draft.status, problems: out.guard?.problems ?? [], warnings: out.guard?.warnings ?? [] });
}

import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import { addNote, assignOwner, changeStage, setNextAction } from "@/lib/staff/leads";
import { isStage } from "@/lib/staff/stages";
import { cleanReason } from "@/lib/staff/audit";

export const dynamic = "force-dynamic";

/**
 * Change a lead from the staff console, whichever store it lives in.
 *
 *   POST { leadId: "json:<id>" | "db:<id>", action: "stage", stage, reason? }
 *   POST { leadId, action: "owner", ownerUserId | "" }
 *   POST { leadId, action: "next", nextAction, due }
 *   POST { leadId, action: "note", text }
 *
 * Route handlers are not covered by the `(internal)` layout's guard, so this
 * checks for itself. Every change is audited in staff/leads.ts.
 */
export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!isBellineStaff(auth.user)) return NextResponse.json({ error: "Belline staff only." }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const leadId = typeof body.leadId === "string" ? body.leadId : "";
  const user = auth.user;

  let out;
  switch (body.action) {
    case "stage": {
      if (!isStage(body.stage)) return NextResponse.json({ error: "Choose a stage." }, { status: 422 });
      const reason = cleanReason(body.reason);
      if ((body.stage === "lost" || body.stage === "do_not_contact") && reason.length < 3) {
        return NextResponse.json({ error: "Say why, in a few words. It goes in the audit log." }, { status: 422 });
      }
      out = await changeStage(leadId, body.stage, user, reason || null);
      break;
    }
    case "owner":
      out = await assignOwner(leadId, typeof body.ownerUserId === "string" && body.ownerUserId ? body.ownerUserId : null, user);
      break;
    case "next":
      out = await setNextAction(leadId, typeof body.nextAction === "string" ? body.nextAction : "", typeof body.due === "string" && body.due ? body.due : null, user);
      break;
    case "note":
      out = await addNote(leadId, typeof body.text === "string" ? body.text : "", user);
      break;
    default:
      return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });
  return NextResponse.json({ ok: true });
}

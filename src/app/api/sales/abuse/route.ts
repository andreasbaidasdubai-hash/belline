import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import { decide, listAbuse, type StaffAction } from "@/lib/abuse/review";
import { markEmailVerified, needsEmailVerification } from "@/lib/email-verify";
import { getUser } from "@/lib/store";
import { listExceptions, updateException } from "@/lib/exceptions";

export const dynamic = "force-dynamic";

/**
 * The abuse review, for Belline staff only.
 *
 *   GET                                   open records
 *   POST { id, action: "allow" | "note" | "suspend" | "unsuspend", note? }
 *   POST { userId, action: "verify" }     mark an owner's email confirmed
 *
 * Route handlers are not covered by the `(internal)` layout's guard, so this
 * checks for itself.
 */

async function staff() {
  const auth = await requireApiUser();
  if (auth.response) return { response: auth.response };
  if (!isBellineStaff(auth.user)) return { response: NextResponse.json({ error: "Not permitted." }, { status: 403 }) };
  return { user: auth.user };
}

export async function GET() {
  const who = await staff();
  if (who.response) return who.response;
  return NextResponse.json({ records: listAbuse({ status: "all" }) });
}

const ACTIONS: StaffAction[] = ["allow", "note", "suspend", "unsuspend"];

export async function POST(request: Request) {
  const who = await staff();
  if (who.response) return who.response;
  const by = who.user.name || who.user.email;
  const body = (await request.json().catch(() => ({}))) as { id?: unknown; userId?: unknown; action?: unknown; note?: unknown };

  if (body.action === "verify") {
    const user = typeof body.userId === "string" ? getUser(body.userId) : undefined;
    if (!user) return NextResponse.json({ error: "No such account." }, { status: 404 });
    if (!needsEmailVerification(user)) return NextResponse.json({ ok: true, already: true });
    markEmailVerified(user.id, `staff: ${by}`);
    // The team's ticket for it, if email was off, is done too.
    for (const row of listExceptions({ kind: "email_unverified" }).filter((e) => e.context.userId === user.id && e.status !== "resolved")) {
      updateException(row.id, { kind: "resolve", note: `Email confirmed by ${by} in Abuse review.`, minutes: 0, by });
    }
    return NextResponse.json({ ok: true });
  }

  const action = ACTIONS.find((a) => a === body.action);
  if (!action || typeof body.id !== "string") return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  const out = decide(body.id, action, by, typeof body.note === "string" ? body.note : "");
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });
  return NextResponse.json({ ok: true, record: out.record });
}

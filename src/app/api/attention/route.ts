import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { canSeeLocation } from "@/lib/auth";
import { getCall } from "@/lib/store";
import { resolveAttention, reopenAttention } from "@/lib/attention";

export const dynamic = "force-dynamic";

/** Clear an item from the Action Inbox, or put it back. */
export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const { callId, reopen } = (await request.json()) as { callId?: string; reopen?: boolean };
  if (!callId) return NextResponse.json({ error: "Which call?" }, { status: 400 });

  const call = getCall(callId);
  if (!call) return NextResponse.json({ error: "Unknown call" }, { status: 404 });

  // Signed in is not the same as entitled to this venue's calls.
  if (!canSeeLocation(auth.user, call.locationId)) {
    return NextResponse.json({ error: "Not your venue" }, { status: 403 });
  }

  const updated = reopen ? reopenAttention(callId) : resolveAttention(callId, auth.user.id);
  return NextResponse.json({ ok: true, resolvedAt: updated?.attentionResolvedAt ?? null });
}

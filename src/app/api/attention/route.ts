import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { canSeeLocation } from "@/lib/auth";
import { getCall } from "@/lib/store";
import { resolveAttention, reopenAttention } from "@/lib/attention";
import { getWaitlistEntry } from "@/lib/store";
import { markCancelled, markOffered } from "@/lib/waitlist";

export const dynamic = "force-dynamic";

/** Clear an item from the Action Inbox, or put it back. */
export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const { callId, entryId, reopen } = (await request.json()) as {
    callId?: string;
    entryId?: string;
    reopen?: boolean;
  };

  // A waitlist match is not a call. Clearing one means the guest was rung —
  // either they took the slot, in which case the booking marks it converted,
  // or they did not and there is nothing more to do.
  if (entryId) {
    const entry = getWaitlistEntry(entryId);
    if (!entry) return NextResponse.json({ error: "Unknown waitlist entry" }, { status: 404 });
    if (!canSeeLocation(auth.user, entry.locationId)) {
      return NextResponse.json({ error: "Not your venue" }, { status: 403 });
    }
    const updated = reopen ? markOffered(entryId) : markCancelled(entryId);
    return NextResponse.json({ ok: true, status: updated?.status ?? null });
  }

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

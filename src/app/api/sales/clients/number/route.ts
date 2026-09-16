import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import { recordStaffNumber } from "@/lib/telephony/pool";
import { tryAudit } from "@/lib/sales/db/repo/activity";

export const dynamic = "force-dynamic";

/**
 * Give a venue the number its calls are forwarded to: its Belline number.
 *
 * The Twilio webhook routes by the number dialled, and nothing in the product
 * could set a venue's number — so a self-serve signup could finish setup and
 * never receive a single call. Staff only: the number has to be bought in
 * Twilio and pointed at /api/twilio/voice first, which is not a customer's job.
 *
 * The work is `recordStaffNumber` (telephony/pool.ts): E.164 only, refuses a
 * number another venue holds, keeps the pool in step (recordManualAssignment,
 * releaseNumber), closes the "being prepared" ticket, and writes
 * `bellineNumber` without ever touching the business's own phone.
 */
export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!isBellineStaff(auth.user)) {
    return NextResponse.json({ error: "Staff only." }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as { venueId?: unknown; phone?: unknown };
  const venueId = String(body.venueId ?? "");
  const out = recordStaffNumber(venueId, body.phone, auth.user.id);
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });

  // Who pointed which venue's calls where. The JSON store keeps no history of
  // its own, so without this row "when did this venue's number change, and who
  // changed it" is answerable nowhere. The pool has its own ledger, but it only
  // sees numbers it handed out; this row covers the ones typed in by hand too.
  await tryAudit({
    actor: `user:${auth.user.id}`,
    action: "venue_number_recorded",
    entity: "location",
    entityId: venueId,
    before: { bellineNumber: out.before },
    after: { bellineNumber: out.bellineNumber },
  });

  return NextResponse.json({ ok: true, bellineNumber: out.bellineNumber });
}

import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import { getLocation, listLocations, upsertLocation } from "@/lib/store";
import { recordManualAssignment, releaseNumber } from "@/lib/telephony/pool";
import { listExceptions, updateException } from "@/lib/exceptions";
import { tryAudit } from "@/lib/sales/db/repo/activity";

export const dynamic = "force-dynamic";

/**
 * Give a venue the number its calls are forwarded to.
 *
 * The Twilio webhook routes by the number dialled, and nothing in the product
 * could set a venue's number — so a self-serve signup could finish setup and
 * never receive a single call. Staff only: the number has to be bought in
 * Twilio and pointed at /api/twilio/voice first, which is not a customer's job.
 *
 * Refuses a number another venue already holds. Two venues on one number
 * means the webhook answers the first as both, which is the exact failure
 * that once answered our own line as a customer's restaurant.
 */
export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!isBellineStaff(auth.user)) {
    return NextResponse.json({ error: "Staff only." }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as { venueId?: unknown; phone?: unknown };
  const venue = getLocation(String(body.venueId ?? ""));
  if (!venue) return NextResponse.json({ error: "No such venue." }, { status: 404 });

  const raw = String(body.phone ?? "").trim();
  const digits = raw.replace(/\D/g, "");

  if (raw && (!raw.startsWith("+") || digits.length < 8 || digits.length > 15)) {
    return NextResponse.json(
      { error: "Write it in international form, starting with +, as Twilio shows it." },
      { status: 422 },
    );
  }

  if (digits) {
    const holder = listLocations({ includeInternal: true }).find(
      (l) => l.id !== venue.id && l.phone.replace(/\D/g, "") === digits,
    );
    if (holder) {
      return NextResponse.json({ error: `${holder.name} already has that number.` }, { status: 409 });
    }
  }

  const before = venue.phone;
  const phone = digits ? `+${digits}` : "";
  // The pool follows what staff set: a number cleared from a venue is
  // quarantined, a number set by hand is marked taken so code never hands it
  // out again.
  if (venue.phone.trim() && venue.phone.replace(/\D/g, "") !== digits) releaseNumber(venue.id);
  if (phone) recordManualAssignment(venue.id, phone, auth.user.id);
  // Stamped, so the number reads as Belline's even when it is not a pool
  // number (telephony/number.ts): the same field also holds a business's own
  // phone from the review step, which must never be shown as a forwarding target.
  const o = venue.onboarding;
  const phoneState = { ...(o?.channels.phone ?? {}) };
  if (phone) phoneState.numberAssignedAt = new Date().toISOString();
  else delete phoneState.numberAssignedAt;
  upsertLocation({ ...venue, phone, ...(o ? { onboarding: { ...o, channels: { ...o.channels, phone: phoneState } } } : {}) });

  // The override is the fix for a "being prepared" ticket, so it closes it
  // with a note saying what was done.
  if (phone) {
    for (const row of listExceptions({ locationId: venue.id, kind: "pool_empty" })) {
      updateException(row.id, { kind: "resolve", note: `Number ${phone} assigned by hand.`, minutes: 0, by: auth.user.id });
    }
  }

  // Who pointed which venue's calls where. The JSON store keeps no history of
  // its own, so without this row "when did this venue's number change, and who
  // changed it" is answerable nowhere. The pool has its own ledger, but it only
  // sees numbers it handed out; this row covers the ones typed in by hand too.
  await tryAudit({
    actor: `user:${auth.user.id}`,
    action: "venue_number_recorded",
    entity: "location",
    entityId: venue.id,
    before: { phone: before },
    after: { phone },
  });

  return NextResponse.json({ ok: true, phone });
}

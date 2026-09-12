import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { canSeeLocation } from "@/lib/auth";
import { getLocation, getWaitlistEntry } from "@/lib/store";
import { join, markCancelled } from "@/lib/waitlist";
import { isValidDate, parseClock } from "@/lib/time";

export const dynamic = "force-dynamic";

/**
 * The waitlist, from the desk.
 *
 * Belline adds people to it on the phone; until now nobody else could, and
 * nobody could take anyone off. A guest who rang to say "never mind" stayed
 * on the list and was offered a table that freed the next day. Two doors:
 * add, and remove.
 */
export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const body = (await request.json().catch(() => ({}))) as {
    locationId?: string;
    guestName?: string;
    guestPhone?: string;
    date?: string;
    earliest?: string;
    latest?: string;
    partySize?: number;
    notes?: string;
  };

  const location = body.locationId ? getLocation(body.locationId) : undefined;
  if (!location) return NextResponse.json({ error: "Unknown venue" }, { status: 404 });
  if (!canSeeLocation(auth.user, location.id)) {
    return NextResponse.json({ error: "Not your venue" }, { status: 403 });
  }

  const guestName = body.guestName?.trim() ?? "";
  if (!guestName) return NextResponse.json({ error: "Whose name?" }, { status: 400 });
  if (!body.date || !isValidDate(body.date)) {
    return NextResponse.json({ error: "Which day?" }, { status: 400 });
  }
  const earliestMin = parseClock(body.earliest ?? "");
  const latestMin = parseClock(body.latest ?? "");
  if (earliestMin === null || latestMin === null || latestMin < earliestMin) {
    return NextResponse.json({ error: "A window like 7:00 PM to 9:00 PM." }, { status: 400 });
  }

  const entry = join({
    locationId: location.id,
    guestName,
    guestPhone: (body.guestPhone ?? "").trim(),
    date: body.date,
    earliestMin,
    latestMin,
    partySize: location.vertical === "restaurant" ? Math.max(1, Number(body.partySize) || 2) : undefined,
    notes: body.notes?.trim() || undefined,
  });
  return NextResponse.json({ ok: true, id: entry.id });
}

export async function DELETE(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const id = new URL(request.url).searchParams.get("id") ?? "";
  const entry = getWaitlistEntry(id);
  if (!entry) return NextResponse.json({ error: "Unknown entry" }, { status: 404 });
  if (!canSeeLocation(auth.user, entry.locationId)) {
    return NextResponse.json({ error: "Not your venue" }, { status: 403 });
  }
  markCancelled(entry.id);
  return NextResponse.json({ ok: true });
}

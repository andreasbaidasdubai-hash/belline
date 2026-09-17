import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { canEditAgent } from "@/lib/auth";
import { getLocation, upsertLocation } from "@/lib/store";
import { changeCalendarPeople, type PeopleChange } from "@/lib/integrations/calendar-people";
import { resyncMovedCalendars } from "@/lib/integrations/calendar-sync";

export const dynamic = "force-dynamic";

/**
 * The people on the Calendars page's "Who uses which calendar" list.
 *
 *   POST /api/calendars/people { locationId, action: "add", name }
 *   POST /api/calendars/people { locationId, action: "rename", staffId, name }
 *   POST /api/calendars/people { locationId, action: "remove", staffId }
 *
 * Owners and managers only, as every other calendar change. The rules are in
 * integrations/calendar-people.ts; this only checks who is asking and saves.
 */
export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const location = getLocation(String(body.locationId ?? ""));
  if (!location || !canEditAgent(auth.user, location.id)) {
    return NextResponse.json({ error: "Not your venue." }, { status: 403 });
  }

  let change: PeopleChange;
  if (body.action === "add") change = { action: "add", name: String(body.name ?? "") };
  else if (body.action === "rename") change = { action: "rename", staffId: String(body.staffId ?? ""), name: String(body.name ?? "") };
  else if (body.action === "remove") change = { action: "remove", staffId: String(body.staffId ?? "") };
  else return NextResponse.json({ error: "Unknown change." }, { status: 400 });

  const out = changeCalendarPeople(location, change);
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });
  const saved = upsertLocation(out.location);
  // Someone removed had their own calendar: their upcoming bookings follow the
  // venue calendar now, as a person switched back to "venue calendar" does.
  if (change.action === "remove") resyncMovedCalendars(saved);
  const added = change.action === "add" ? saved.salon?.staff.at(-1) : undefined;
  return NextResponse.json({ ok: true, ...(added ? { person: { id: added.id, name: added.name } } : {}) });
}

import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { canEditAgent } from "@/lib/auth";
import { getLocation } from "@/lib/store";
import { revertTo } from "@/lib/brain";

export const dynamic = "force-dynamic";

/**
 * Put a venue back the way it was.
 *
 * The Business Brain has kept every published version since it existed, and
 * `revertTo` has been written and tested for as long. Nothing on any screen
 * called it — the history was visible as "Version 12" on the home page and
 * that was all. This is the button.
 */
export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const body = (await request.json().catch(() => ({}))) as { locationId?: string; number?: number };
  const location = body.locationId ? getLocation(body.locationId) : undefined;
  if (!location) return NextResponse.json({ error: "Unknown venue" }, { status: 404 });
  if (!canEditAgent(auth.user, location.id)) {
    return NextResponse.json({ error: "Not your venue" }, { status: 403 });
  }

  const number = Number(body.number);
  if (!Number.isInteger(number) || number < 1) {
    return NextResponse.json({ error: "Which version?" }, { status: 400 });
  }

  const result = revertTo(location.id, number, auth.user);
  if (!result) return NextResponse.json({ error: "No such version." }, { status: 404 });
  return NextResponse.json({ ok: true, version: result.version.number, changed: result.changed });
}

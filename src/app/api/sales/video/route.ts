import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import { getLocation } from "@/lib/store";
import { readVideoControl, setKillSwitch, setVenueVideo } from "@/lib/video/control";
import { endAllVideoSessions, endVideoSession, liveVideoSessions } from "@/lib/video/sessions";
import { prewarmVideoVenueSoon } from "@/lib/video/prewarm";

export const dynamic = "force-dynamic";

/**
 * The video receptionist's switches, for Belline staff.
 *
 * Route handlers are not covered by the `(internal)` layout's guard, so this
 * checks for itself. Actions:
 *
 *   `{ action: "kill", note }`   stop video everywhere and end every live call
 *   `{ action: "restore" }`      lift the kill switch
 *   `{ action: "allow", locationId }` / `{ action: "disallow", locationId }`
 *   `{ action: "end", sessionId }`   end one live session
 */

async function staff() {
  const auth = await requireApiUser();
  if (auth.response) return { response: auth.response };
  if (!isBellineStaff(auth.user)) return { response: NextResponse.json({ error: "Not permitted." }, { status: 403 }) };
  return { user: auth.user };
}

export async function POST(request: Request) {
  const who = await staff();
  if (who.response) return who.response;
  const body = (await request.json().catch(() => ({}))) as { action?: unknown; locationId?: unknown; sessionId?: unknown; note?: unknown };
  const by = who.user.name || who.user.email;

  switch (body.action) {
    case "kill": {
      setKillSwitch(true, by, typeof body.note === "string" ? body.note : undefined);
      const ended = await endAllVideoSessions("kill_switch", "kill_switch");
      return NextResponse.json({ ok: true, killSwitch: readVideoControl().killSwitch, ended });
    }
    case "restore":
      setKillSwitch(false, by);
      return NextResponse.json({ ok: true, killSwitch: readVideoControl().killSwitch });
    case "allow":
    case "disallow": {
      const locationId = typeof body.locationId === "string" ? body.locationId : "";
      if (!getLocation(locationId)) return NextResponse.json({ error: "Which venue?" }, { status: 400 });
      setVenueVideo(locationId, body.action === "allow", by);
      if (body.action === "disallow") {
        await Promise.all(liveVideoSessions(locationId).map((s) => endVideoSession(s.id, "disallowed", { by: "staff" })));
      } else {
        // Its shared PAL, made now rather than in the first visitor's call.
        prewarmVideoVenueSoon({ id: locationId });
      }
      return NextResponse.json({ ok: true, venue: readVideoControl().venues[locationId] });
    }
    case "end": {
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      const ended = await endVideoSession(sessionId, "ended_by_staff", { by: "staff" });
      return NextResponse.json({ ok: true, ended });
    }
    default:
      return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }
}

import { NextResponse } from "next/server";
import { verifyStreamToken } from "@/lib/auth";
import { getLocation } from "@/lib/store";
import { checkDemoGate } from "@/lib/demo";
import { mayStreamTo } from "@/lib/voice/entitlement";
import { seedIfEmpty } from "@/lib/seed";

export const dynamic = "force-dynamic";

/**
 * Why the call would not connect.
 *
 * A websocket handshake that fails hands JavaScript nothing — the browser
 * deliberately hides the status code, so a 403 and a 429 and a dead server
 * are all just "connection failed" to the page. That is the message a visitor
 * has been getting, and it is also all *I* could see while trying to work out
 * what was wrong.
 *
 * So the client asks here after a failure and gets a reason it can say out
 * loud. Same checks as the upgrade handler, in the same order, using the same
 * predicate — anything else and this becomes a second opinion that disagrees
 * with the first at exactly the wrong moment.
 *
 * Unauthenticated, like the socket it explains, and it says nothing a caller
 * could not learn by dialling: whether this line is open, and how many calls
 * it has left today.
 */
export async function GET(request: Request) {
  seedIfEmpty();

  const token = new URL(request.url).searchParams.get("token") ?? "";
  const locationId = verifyStreamToken(token);

  if (!locationId) {
    return NextResponse.json(
      { ok: false, reason: "token", say: "This page has been open a while. Reload it and try again." },
      { headers: { "cache-control": "no-store" } },
    );
  }

  const location = getLocation(locationId);
  if (!location || !mayStreamTo(location)) {
    return NextResponse.json(
      { ok: false, reason: "forbidden", say: "This line is not taking calls." },
      { headers: { "cache-control": "no-store" } },
    );
  }

  const gate = checkDemoGate(location);
  if (!gate.allowed) {
    return NextResponse.json(
      {
        ok: false,
        reason: "cap",
        used: gate.used,
        limit: gate.limit,
        say: "Our demonstration line has taken all the calls it can today. Ring the number on the site, or book a call and we will come to you.",
      },
      { headers: { "cache-control": "no-store" } },
    );
  }

  return NextResponse.json(
    { ok: true, used: gate.used, limit: gate.limit },
    { headers: { "cache-control": "no-store" } },
  );
}

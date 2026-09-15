import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { canEditAgent } from "@/lib/auth";
import { getLocation, listLocationsFor } from "@/lib/store";
import { openWindow, verificationState } from "@/lib/telephony/verify";

export const dynamic = "force-dynamic";

/**
 * The forwarding test window.
 *
 *   POST /api/phone/verify { locationId?, carrier? }  → opens ten minutes
 *   GET  /api/phone/verify?locationId=                → none | open | verified | expired
 *
 * The page polls GET while the window is open and flips to success when the
 * voice webhook has recorded the test call. See telephony/verify.ts.
 */

const CARRIERS = ["du", "eand", "virgin", "landline", "pbx"] as const;

async function venue(locationId: string) {
  const auth = await requireApiUser();
  if (auth.response) return { response: auth.response } as const;
  const id = locationId || listLocationsFor(auth.user.tenantId)[0]?.id || "";
  const location = getLocation(id);
  if (!location || !canEditAgent(auth.user, location.id)) {
    return { response: NextResponse.json({ error: "Not your venue." }, { status: 403 }) } as const;
  }
  return { location } as const;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { locationId?: string; carrier?: string };
  const v = await venue(String(body.locationId ?? ""));
  if ("response" in v) return v.response;
  const carrier = CARRIERS.find((c) => c === body.carrier);
  const out = openWindow(v.location, carrier);
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });
  return NextResponse.json({ ok: true, ...verificationState(getLocation(v.location.id)!) });
}

export async function GET(req: Request) {
  const v = await venue(new URL(req.url).searchParams.get("locationId") ?? "");
  if ("response" in v) return v.response;
  return NextResponse.json({ ok: true, ...verificationState(v.location) });
}

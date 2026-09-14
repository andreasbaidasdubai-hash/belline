import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { visibleLocations } from "@/lib/auth";
import { liveStamp } from "@/lib/live";

export const dynamic = "force-dynamic";

/** The dashboard's change fingerprint — see lib/live.ts. */
export async function GET() {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  return NextResponse.json(liveStamp(visibleLocations(auth.user)), { headers: { "cache-control": "no-store" } });
}

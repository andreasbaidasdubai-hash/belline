import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth-server";
import { readLook, saveLook } from "@/lib/video/look-settings";

export const dynamic = "force-dynamic";

/** The video face and background for the signed-in owner's venue. The rules are in lib/video/look-settings.ts. */

const NO_STORE = { "cache-control": "no-store" };

export async function GET(request: Request) {
  const out = await readLook(await currentUser(), new URL(request.url).searchParams.get("locationId"));
  return NextResponse.json(out.body, { status: out.status, headers: NO_STORE });
}

export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const out = await saveLook(await currentUser(), body);
  return NextResponse.json(out.body, { status: out.status, headers: NO_STORE });
}

import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { canEditAgent } from "@/lib/auth";
import { getLocation } from "@/lib/store";
import { removeLogo, uploadLogoFromRequest } from "@/lib/logo-store";

export const dynamic = "force-dynamic";

/**
 * The venue's own logo: upload (POST, multipart `locationId` + `file`) and
 * remove (DELETE `?locationId=`).
 *
 * Owner-only, like every venue setting. The file is checked by its bytes and
 * an SVG is rebuilt from an allowlist before anything is written — see
 * lib/logo.ts. The venue id travels in the query string rather than the form
 * so it can be checked before the upload is read at all.
 */
export async function POST(req: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const locationId = new URL(req.url).searchParams.get("locationId") ?? "";
  const location = getLocation(locationId);
  if (!location || !canEditAgent(auth.user, location.id)) {
    return NextResponse.json({ error: "Not your venue." }, { status: 403 });
  }

  const out = await uploadLogoFromRequest(req, location.id);
  return NextResponse.json(out.body, { status: out.status });
}

export async function DELETE(req: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const locationId = new URL(req.url).searchParams.get("locationId") ?? "";
  const location = getLocation(locationId);
  if (!location || !canEditAgent(auth.user, location.id)) {
    return NextResponse.json({ error: "Not your venue." }, { status: 403 });
  }

  removeLogo(location.id);
  return NextResponse.json({ ok: true, logoUrl: null });
}

import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { canEditAgent } from "@/lib/auth";
import { getLocation, upsertLocation } from "@/lib/store";
import { checkInstall } from "@/lib/onboarding/platform";

export const dynamic = "force-dynamic";

/**
 * Is the widget installed yet? Polled by the website page every 20 seconds.
 *
 *   GET /api/embed/status?locationId=
 *
 * The widget's own ping (/api/embed/[key]/seen) is what normally answers this.
 * As a fallback for a page nobody has opened yet, the first site the widget is
 * allowed on is fetched and searched for the key — at most once every 20
 * seconds per venue, however many tabs are polling.
 */
const CHECK_EVERY_MS = 20_000;

export async function GET(req: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const location = getLocation(new URL(req.url).searchParams.get("locationId") ?? "");
  if (!location || !canEditAgent(auth.user, location.id)) {
    return NextResponse.json({ error: "Not your venue." }, { status: 403 });
  }
  const web = location.onboarding?.channels.web;
  if (web?.detectedAt || !location.embed?.enabled) {
    return NextResponse.json({ ok: true, detectedAt: web?.detectedAt ?? null });
  }

  const site = location.embed.allowedOrigins[0];
  const last = web?.lastCheckAt ? Date.parse(web.lastCheckAt) : 0;
  if (!site || Date.now() - last < CHECK_EVERY_MS || !location.onboarding) {
    return NextResponse.json({ ok: true, detectedAt: null });
  }

  const at = new Date().toISOString();
  const check = await checkInstall(site, location.embed.key);
  const fresh = getLocation(location.id)!;
  const o = fresh.onboarding ?? location.onboarding;
  const detectedAt = check.installed ? (o.channels.web?.detectedAt ?? at) : o.channels.web?.detectedAt;
  upsertLocation({
    ...fresh,
    onboarding: {
      ...o,
      channels: { ...o.channels, web: { domains: location.embed.allowedOrigins, lastCheckAt: at, ...(detectedAt ? { detectedAt } : {}) } },
    },
  });
  return NextResponse.json({ ok: true, detectedAt: detectedAt ?? null });
}

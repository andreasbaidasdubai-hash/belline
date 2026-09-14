import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { canEditAgent } from "@/lib/auth";
import { getLocation } from "@/lib/store";
import { INSTALL_STEPS, checkInstall } from "@/lib/onboarding/platform";

export const dynamic = "force-dynamic";

/**
 * Is the widget on the venue's website yet — and which builder is it?
 *
 * Fetches the page they name and looks for their own key. Returns the
 * platform's install steps either way, so the answer to "no" is what to do.
 */
export async function POST(req: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const body = (await req.json().catch(() => ({}))) as { locationId?: string; url?: string };
  const location = body.locationId ? getLocation(body.locationId) : undefined;
  if (!location || !canEditAgent(auth.user, location.id)) {
    return NextResponse.json({ error: "Not your venue." }, { status: 403 });
  }
  if (!location.embed?.key) {
    return NextResponse.json({ error: "Switch the website widget on first." }, { status: 409 });
  }
  const url = String(body.url ?? "").trim();
  if (!url) return NextResponse.json({ error: "Paste your website address." }, { status: 422 });

  const check = await checkInstall(url, location.embed.key);
  return NextResponse.json({
    ok: true,
    ...check,
    steps: check.platform ? INSTALL_STEPS[check.platform] : INSTALL_STEPS.custom,
  });
}

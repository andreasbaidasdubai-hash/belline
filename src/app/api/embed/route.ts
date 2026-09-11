import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { canEditAgent } from "@/lib/auth";
import { getLocation, listLocationsFor } from "@/lib/store";
import { disableEmbed, embedSnippet, enableEmbed, normaliseOrigin } from "@/lib/embed";
import { publish } from "@/lib/brain";

export const dynamic = "force-dynamic";

/**
 * Switching the website widget on and off.
 *
 * The one setting in Belline that makes a venue's minutes spendable by
 * strangers, so it is deliberately not a toggle on its own: turning it on
 * requires naming the sites it may appear on, and an empty list is refused
 * rather than quietly meaning "anywhere".
 */
export async function POST(req: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const user = auth.user;

  let body: { locationId?: string; origins?: unknown; enabled?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Send JSON." }, { status: 400 });
  }

  const locationId = String(body.locationId ?? "") || listLocationsFor(user.tenantId)[0]?.id || "";
  const location = getLocation(locationId);
  if (!location || !canEditAgent(user, location.id)) {
    return NextResponse.json({ error: "Not your venue." }, { status: 403 });
  }

  if (body.enabled === false) {
    const off = disableEmbed(location);
    publish(off.id, user, "Website widget switched off");
    return NextResponse.json({ ok: true, enabled: false, key: off.embed?.key });
  }

  const raw = Array.isArray(body.origins) ? body.origins.map(String) : [];
  const origins = raw.map(normaliseOrigin).filter((o): o is string => Boolean(o));

  if (origins.length === 0) {
    // Refused rather than accepted-and-inert. A widget that is "on" with no
    // origins would appear switched on in the dashboard and work nowhere,
    // which is the most confusing of the available failures.
    return NextResponse.json(
      {
        error:
          raw.length > 0
            ? "None of those look like website addresses. Try something like marinahair.ae."
            : "Which website is it going on? Belline will only open on the sites you name.",
      },
      { status: 422 },
    );
  }

  const updated = enableEmbed(location, origins);
  publish(updated.id, user, `Website widget on for ${origins.join(", ")}`);

  return NextResponse.json({
    ok: true,
    enabled: true,
    key: updated.embed!.key,
    origins: updated.embed!.allowedOrigins,
    snippet: embedSnippet(updated, new URL(req.url).origin),
    maxCallsPerDay: updated.embed!.maxCallsPerDay,
  });
}

import { NextResponse } from "next/server";
import { seedIfEmpty } from "@/lib/seed";
import { listLocations } from "@/lib/store";
import { widgetConfig } from "@/lib/embed";
import { answersIn, languageNotice } from "@/lib/language";
import { venueWhatsApp, whatsappLink } from "@/lib/whatsapp";
import { isActivated } from "@/lib/onboarding/journey";
import { logoUrlFor } from "@/lib/logo";

export const dynamic = "force-dynamic";

/**
 * What the widget looks like, fetched by embed.js on load.
 *
 * Public and cross-origin by design: it runs on the customer's site, and it
 * carries only what a visitor could see by looking at the buttons anyway —
 * words, colours, which corner, the WhatsApp link, the logo when the button
 * carries one (a public picture already). The origin allowlist and
 * the ceilings stay out of it (see `widgetConfig`).
 *
 * Fetched rather than baked into the pasted snippet so a venue can change
 * the words on its buttons in the dashboard and see them on its site within
 * a minute, without editing its website again.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params;
  seedIfEmpty();

  const location = listLocations({ includeInternal: true }).find(
    (l) => l.embed?.enabled && l.embed.key === key,
  );
  if (!location?.embed) {
    return NextResponse.json({ error: "Not found" }, { status: 404, headers: cors() });
  }

  // Installed but not live: the script stays on the page (its install ping is
  // how Go live knows it is there) and shows nothing to visitors.
  if (!isActivated(location)) {
    return NextResponse.json({ live: false }, { headers: { ...cors(), "cache-control": "no-store" } });
  }

  const account = await venueWhatsApp(location).catch(() => null);
  const link = account?.phoneE164 ? `https://wa.me/${account.phoneE164.slice(1)}` : whatsappLinkFor(location.id);

  return NextResponse.json(
    widgetConfig(location.embed, link, answersIn(location), languageNotice(location), logoUrlFor(location)),
    {    headers: { ...cors(), "cache-control": "public, max-age=60" },
  });
}

/** Belline's own site is the one venue whose number comes from the environment. */
function whatsappLinkFor(locationId: string): string | null {
  return locationId === "loc_belline" ? whatsappLink("Hi Belle") : null;
}

function cors(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET",
  };
}

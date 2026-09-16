import { NextResponse } from "next/server";
import { seedIfEmpty } from "@/lib/seed";
import { listLocations } from "@/lib/store";
import { recordSeen } from "@/lib/embed";
import { track } from "@/lib/reception/events";

export const dynamic = "force-dynamic";

/**
 * "The widget just loaded on this page", from embed.js.
 *
 * The authoritative install check: no crawling, and no waiting for a builder to
 * publish. The Origin header is the browser's, not the page's, so only a site
 * the venue named can mark the widget as installed. A refusal is 403 and tells
 * the widget not to render.
 */
function cors(origin: string | null, allowed: boolean): Record<string, string> {
  return allowed && origin
    ? { "access-control-allow-origin": origin, "access-control-allow-methods": "POST", vary: "Origin" }
    : { vary: "Origin" };
}

export async function OPTIONS(req: Request) {
  const origin = req.headers.get("origin");
  return new Response(null, {
    status: 204,
    headers: { "access-control-allow-origin": origin ?? "*", "access-control-allow-methods": "POST", vary: "Origin" },
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params;
  seedIfEmpty();
  const origin = req.headers.get("origin");
  const location = listLocations({ includeInternal: true }).find((l) => l.embed?.enabled && l.embed.key === key);
  const out = location ? recordSeen(location, origin) : ({ ok: false } as const);
  if (!out.ok) {
    return NextResponse.json({ render: false }, { status: 403, headers: cors(origin, false) });
  }
  if (out.firstTime) {
    await track({ tenantId: out.location.tenantId, locationId: out.location.id, name: "widget.detected", payload: { origin } });
  }
  return NextResponse.json({ render: true }, { headers: cors(origin, true) });
}

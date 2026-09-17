import { NextResponse } from "next/server";
import { readBody } from "@/lib/video/http";
import { linkFromParams, NO_STORE } from "@/lib/sales/video-demo/http";
import { pageViewAllowed, recordDemoEvent } from "@/lib/sales/video-demo/service";

export const dynamic = "force-dynamic";

/**
 * "Opened", reported by the page's script once it has rendered in a browser —
 * not by the page request itself, which mail scanners and link previews make
 * without anybody looking.
 */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const found = await linkFromParams(ctx.params);
  if (!found.ok) return found.response;
  const body = await readBody(req, 500);
  if (body?.name !== "opened") return NextResponse.json({ error: "bad_event" }, { status: 400, headers: NO_STORE });
  if (!pageViewAllowed(`track:${found.link.id}`)) return NextResponse.json({ error: "slow_down" }, { status: 429, headers: NO_STORE });
  await recordDemoEvent(found.link.id, "opened");
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}

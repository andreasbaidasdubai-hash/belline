import { NextResponse } from "next/server";
import { linkFromParams } from "@/lib/sales/video-demo/http";
import { recordDemoEvent } from "@/lib/sales/video-demo/service";

export const dynamic = "force-dynamic";

/**
 * "Get started" on a demo page: recorded against the lead, then on to signup
 * with `?ref=demo_<link id>`. The link id rather than the token, so the signup
 * URL (and anything that logs it) cannot reopen the prospect's demo.
 */
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const origin = new URL(req.url).origin;
  const found = await linkFromParams(ctx.params);
  if (!found.ok) return NextResponse.redirect(`${origin}/start`, 303);
  await recordDemoEvent(found.link.id, "get_started_clicked");
  return NextResponse.redirect(`${origin}/start?ref=demo_${encodeURIComponent(found.link.id)}`, 303);
}

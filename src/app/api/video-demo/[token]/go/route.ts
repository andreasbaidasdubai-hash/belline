import { NextResponse } from "next/server";
import { linkFromParams } from "@/lib/sales/video-demo/http";
import { demoPlanId } from "@/lib/sales/video-demo/packages";
import { recordDemoEvent } from "@/lib/sales/video-demo/service";

export const dynamic = "force-dynamic";

/**
 * "Get started" on a demo page: recorded against the lead, then on to checkout
 * with `?ref=demo_<link id>`, and the package the visitor chose (`?plan=`, only
 * a plan on sale; `?cycle=annual` when they picked annual). The link id rather
 * than the token, so the checkout URL (and anything that logs it) cannot
 * reopen the prospect's demo.
 */
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const url = new URL(req.url);
  const origin = url.origin;
  const plan = demoPlanId(url.searchParams.get("plan"));
  const target = new URLSearchParams();
  if (plan) {
    target.set("products", plan);
    target.set("market", "AE");
    if (url.searchParams.get("cycle") === "annual") target.set("cycle", "annual");
  }
  const found = await linkFromParams(ctx.params);
  if (!found.ok) return NextResponse.redirect(`${origin}/checkout${target.size ? `?${target}` : ""}`, 303);
  await recordDemoEvent(found.link.id, "get_started_clicked");
  target.set("ref", `demo_${found.link.id}`);
  return NextResponse.redirect(`${origin}/checkout?${target}`, 303);
}

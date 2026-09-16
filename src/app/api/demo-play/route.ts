import { NextResponse } from "next/server";
import { isConfigured } from "@/lib/sales/db/client";
import { recordDemoPlay } from "@/lib/sales/demos/run";

export const dynamic = "force-dynamic";

/**
 * A prospect played their demo.
 *
 * Public and unauthenticated by necessity — the person pressing play has never
 * signed in. That makes it forgeable, so nothing expensive may hang off it:
 * `recordDemoPlay` counts a play at most once an hour per demo, with the
 * counters and the activity row moving together, and clamps the seconds it
 * will believe. The points a demo contributes are excluded from the number
 * that decides whether a lead may be contacted, so the worst a forger achieves
 * is a warmer-looking sort order.
 *
 * Always answers 204, even on failure. The page must not behave differently
 * depending on whether our analytics worked, and a prospect must never see an
 * error because we could not record something for ourselves.
 */
export async function POST(request: Request) {
  if (!isConfigured()) return new NextResponse(null, { status: 204 });

  try {
    const body = (await request.json()) as { demoId?: unknown; seconds?: unknown };
    const demoId = Number(body.demoId);
    if (!Number.isInteger(demoId) || demoId <= 0) {
      return new NextResponse(null, { status: 204 });
    }
    const seconds = Number(body.seconds);
    await recordDemoPlay(demoId, Number.isFinite(seconds) ? seconds : 0);
  } catch {
    // Deliberately swallowed — see above.
  }
  return new NextResponse(null, { status: 204 });
}

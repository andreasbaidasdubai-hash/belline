import { NextResponse } from "next/server";
import { isConfigured } from "@/lib/sales/db/client";
import { recordDemoPlay } from "@/lib/sales/demos/run";

export const dynamic = "force-dynamic";

/**
 * A prospect played their demo.
 *
 * Public and unauthenticated by necessity — the person pressing play has never
 * signed in. That makes it forgeable, which is acceptable for a funnel metric
 * and would not be for anything else: the endpoint can only ever increment a
 * play count on a demo that already exists, and `recordDemoPlay` will not
 * write a second `demo_used` activity row within the hour.
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

import { NextResponse } from "next/server";
import { getLocation, upsertLocation } from "@/lib/store";
import { canEditAgent } from "@/lib/auth";
import { requireApiUser } from "@/lib/auth-server";
import type { AgentConfig } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Agent configuration.
 *
 * Everything a venue can change about how the agent behaves lives in this
 * object — no redeploy, no prompt engineering by the operator. The next call
 * picks up the change because the system prompt is rebuilt per call.
 */
export async function PATCH(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const body = (await request.json()) as {
    locationId?: string;
    agent?: Partial<AgentConfig>;
  };

  const location = body.locationId ? getLocation(body.locationId) : undefined;
  if (!location) {
    return NextResponse.json({ error: "Unknown location" }, { status: 404 });
  }
  if (!canEditAgent(auth.user, location.id)) {
    return NextResponse.json(
      { error: "You cannot change the agent at this venue." },
      { status: 403 },
    );
  }
  if (!body.agent) {
    return NextResponse.json({ error: "No agent payload" }, { status: 400 });
  }

  const next: AgentConfig = {
    ...location.agent,
    ...body.agent,
    // Guard the numeric fields — a blank input arrives as NaN and a zero-second
    // call limit would hang up on every caller mid-greeting.
    maxCallSeconds:
      Number(body.agent.maxCallSeconds) > 0
        ? Number(body.agent.maxCallSeconds)
        : location.agent.maxCallSeconds,
    bookingHorizonDays:
      Number(body.agent.bookingHorizonDays) > 0
        ? Number(body.agent.bookingHorizonDays)
        : location.agent.bookingHorizonDays,
    policies: (body.agent.policies ?? location.agent.policies).filter((p) => p.trim()),
    faqs: (body.agent.faqs ?? location.agent.faqs).filter((f) => f.q.trim() && f.a.trim()),
  };

  upsertLocation({ ...location, agent: next });
  return NextResponse.json({ ok: true, agent: next });
}

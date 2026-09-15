import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { canEditAgent } from "@/lib/auth";
import { getLocation, listCalls, listLocationsFor, upsertLocation } from "@/lib/store";
import { factsFrom, journey, recordStep, type StepAction } from "@/lib/onboarding/journey";
import type { DestinationKind } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * The owner's actions on the setup steps that are not a form.
 *
 *   POST /api/setup/journey { action: "destination", destination }
 *   POST /api/setup/journey { action: "rules" }
 *   POST /api/setup/journey { action: "activate" }
 *
 * Every rule lives in `recordStep`, including the Go live gate: the button is
 * only rendered when the journey allows it, and this refuses the same request
 * sent by hand.
 */
export async function POST(req: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const user = auth.user;

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const locationId = String(body.locationId ?? "") || listLocationsFor(user.tenantId)[0]?.id || "";
  const location = getLocation(locationId);
  if (!location || !canEditAgent(user, location.id)) {
    return NextResponse.json({ error: "Not your venue." }, { status: 403 });
  }

  let action: StepAction;
  if (body.action === "destination") action = { kind: "destination", destination: String(body.destination ?? "") as DestinationKind };
  else if (body.action === "rules") action = { kind: "rules" };
  else if (body.action === "activate") action = { kind: "activate", by: user.id };
  else return NextResponse.json({ error: "Unknown step." }, { status: 400 });

  const facts = factsFrom(location, listCalls(location.id));
  const out = recordStep(location, action, facts);
  if (!out.ok) return NextResponse.json({ error: out.error, fix: out.fix }, { status: out.status });

  const saved = upsertLocation(out.location);
  return NextResponse.json({ ok: true, next: journey(saved, facts).next?.url ?? "/" });
}

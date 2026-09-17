import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { canEditAgent } from "@/lib/auth";
import { listLocationsFor } from "@/lib/store";
import { runSetupTurn, type SetupMessage } from "@/lib/onboarding/assistant";
import { isStepId } from "@/lib/onboarding/journey";
import { paidWorkRefusal } from "@/lib/abuse/gate";
import { getLocation } from "@/lib/store";
import { onViewAs } from "@/lib/belle/server";

export const dynamic = "force-dynamic";

/**
 * One turn of setting a venue up by talking to Belle.
 *
 * The page keeps the conversation and sends it back each turn; every change
 * the assistant makes goes through the venue gate and onto the version history
 * (see onboarding/assistant.ts). Owners and managers only — the same rule as
 * editing the venue by hand.
 */
export async function POST(req: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const user = auth.user;
  // Belline staff viewing a dashboard as the customer: read-only, and Belle saves.
  if (await onViewAs()) return NextResponse.json({ error: "Read-only view: Belle is not available here." }, { status: 403 });

  let body: { locationId?: unknown; messages?: unknown; step?: unknown; page?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Send JSON." }, { status: 400 });
  }

  const locationId =
    (typeof body.locationId === "string" && body.locationId) || listLocationsFor(user.tenantId)[0]?.id || "";
  if (!locationId || !canEditAgent(user, locationId) || getLocation(locationId)?.tenantId !== user.tenantId) {
    return NextResponse.json({ error: "Not your venue." }, { status: 403 });
  }
  // Belle is a model call: not before the owner's email is confirmed.
  const held = paidWorkRefusal(user, getLocation(locationId));
  if (held) return NextResponse.json({ error: held.error, fix: held.fix, code: held.code }, { status: held.status });

  const messages: SetupMessage[] = (Array.isArray(body.messages) ? body.messages : [])
    .filter(
      (m): m is SetupMessage =>
        Boolean(m) &&
        typeof m === "object" &&
        ((m as SetupMessage).role === "user" || (m as SetupMessage).role === "assistant") &&
        typeof (m as SetupMessage).content === "string",
    )
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }))
    .slice(-30);

  // The conversation has to end on something the owner said.
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return NextResponse.json({ error: "Say something first." }, { status: 400 });
  }
  // The model API needs the first turn to be the user's.
  while (messages.length && messages[0].role !== "user") messages.shift();

  try {
    // The setup step Belle was opened from, so her fallback help is for that step.
    const step = typeof body.step === "string" && isStepId(body.step) ? body.step : undefined;
    // The owner's own tenant, so Belle may read their account; the dashboard page, as a hint from the page guide.
    const page = typeof body.page === "string" ? body.page.slice(0, 200) : undefined;
    const result = await runSetupTurn(locationId, { id: user.id, name: user.name }, messages, { step, viewerTenantId: user.tenantId, page });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[setup assistant]", err);
    return NextResponse.json({ error: "Belle could not answer just then. Try again in a moment." }, { status: 502 });
  }
}

import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { canEditAgent } from "@/lib/auth";
import { getLocation, listCalls, listLocationsFor } from "@/lib/store";
import { runSelftest } from "@/lib/onboarding/selftest";
import { testsCurrent } from "@/lib/onboarding/selftest-state";
import { factsFrom, journey, stepAfter } from "@/lib/onboarding/journey";

export const dynamic = "force-dynamic";

/**
 * The automatic checks.
 *
 *   POST /api/setup/selftest { locationId? }  run them (10 a day per venue)
 *   GET  /api/setup/selftest?locationId=      the last run, and whether it is current
 *
 * Plain HTTP and no WebSocket, so it works under `next dev` and anywhere the
 * dashboard does. Failures come back with the exact reply and the likely cause.
 */

async function venueFor(user: Awaited<ReturnType<typeof requireApiUser>>["user"], raw: unknown) {
  if (!user) return null;
  const id = String(raw ?? "") || listLocationsFor(user.tenantId)[0]?.id || "";
  const location = getLocation(id);
  return location && canEditAgent(user, location.id) ? location : null;
}

export async function POST(req: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const body = (await req.json().catch(() => ({}))) as { locationId?: unknown };
  const location = await venueFor(auth.user, body.locationId);
  if (!location) return NextResponse.json({ error: "Not your venue." }, { status: 403 });

  const out = await runSelftest(location.id);
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });

  const j = journey(out.location, factsFrom(out.location, listCalls(out.location.id)));
  return NextResponse.json({ ok: true, passed: out.passed, results: out.results, next: stepAfter(j, "test")?.url ?? "/", canGoLive: j.canGoLive });
}

export async function GET(req: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const location = await venueFor(auth.user, new URL(req.url).searchParams.get("locationId"));
  if (!location) return NextResponse.json({ error: "Not your venue." }, { status: 403 });
  const tests = location.onboarding?.tests;
  return NextResponse.json({ ok: true, tests: tests ?? null, current: testsCurrent(location) });
}

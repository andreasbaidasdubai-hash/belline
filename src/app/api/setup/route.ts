import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { canEditAgent } from "@/lib/auth";
import { getLocation, listLocationsFor } from "@/lib/store";
import { applyDraft, draftFromWebsite, readiness } from "@/lib/onboarding";
import { publish } from "@/lib/brain";
import type { WeeklyHours } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Setting a venue up from its own website.
 *
 * Two verbs, and the gap between them is deliberate.
 *
 *   POST /api/setup { website }   — read it, return a draft. Writes nothing.
 *   PUT  /api/setup { ...fields } — write the draft the owner confirmed.
 *
 * Nothing a model read off a web page reaches a live venue without a person
 * having seen it on screen and pressed a button. That separation is the entire
 * safety property of this feature: the reader is good, and it is wrong often
 * enough that an unreviewed price or an invented stylist would otherwise be
 * quoted to a real customer on a real telephone call.
 */

export async function POST(req: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const user = auth.user;

  let body: { website?: string };
  try {
    body = (await req.json()) as { website?: string };
  } catch {
    return NextResponse.json({ error: "Send JSON." }, { status: 400 });
  }

  const website = String(body.website ?? "").trim();
  if (!website) {
    return NextResponse.json({ error: "Paste the address of your website." }, { status: 422 });
  }

  try {
    const draft = await draftFromWebsite(website);
    return NextResponse.json({ ok: true, draft });
  } catch (err) {
    // Everything that can go wrong here is the customer's problem to
    // understand, not ours to hide: a typo, a site behind a login, a site that
    // is mostly images. Say which, and let them type it in instead.
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        error: message,
        // The route out. A business with no website is a customer too.
        fallback: "You can skip this and tell Belline about the business yourself.",
      },
      { status: 422 },
    );
  }
}

export async function PUT(req: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const user = auth.user;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Send JSON." }, { status: 400 });
  }

  // The venue they are setting up. Defaults to their only one, which is the
  // case for every account that has just signed up.
  const locationId =
    String(body.locationId ?? "") || listLocationsFor(user.tenantId)[0]?.id || "";
  const location = getLocation(locationId);

  if (!location || !canEditAgent(user, location.id)) {
    return NextResponse.json({ error: "Not your venue." }, { status: 403 });
  }

  const confirmed = {
    name: body.name ? String(body.name) : undefined,
    address: body.address ? String(body.address) : undefined,
    phone: body.phone ? String(body.phone) : undefined,
    greeting: body.greeting ? String(body.greeting) : undefined,
    hours: (body.hours as WeeklyHours) ?? undefined,
    services: Array.isArray(body.services)
      ? (body.services as { name: string; durationMin: number; price: number }[])
      : undefined,
    staff: Array.isArray(body.staff) ? (body.staff as string[]) : undefined,
    faqs: Array.isArray(body.faqs) ? (body.faqs as { q: string; a: string }[]) : undefined,
    policies: Array.isArray(body.policies) ? (body.policies as string[]) : undefined,
  };

  const updated = applyDraft(location, confirmed);

  // Recorded as a published version, like every other change to a venue's
  // configuration — so "who set this up, and what did it say on the call I am
  // complaining about" has an answer from the first day rather than the
  // second.
  publish(
    updated.id,
    user,
    body.website ? `Set up from ${String(body.website)}` : "Set up by hand",
  );

  return NextResponse.json({ ok: true, readiness: readiness(updated) });
}

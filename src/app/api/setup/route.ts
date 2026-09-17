import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { canEditAgent } from "@/lib/auth";
import { getLocation, listLocationsFor, upsertLocation } from "@/lib/store";
import { applyDraft, readiness, setupNote } from "@/lib/onboarding";
import { journeyFor, markReviewed, stepAfter } from "@/lib/onboarding/journey";
import { draftFromRequest } from "@/lib/onboarding/uploads";
import { publish } from "@/lib/brain";
import { cleanConfirmed } from "@/lib/onboarding/review";
import { customerError } from "@/lib/errors/customer";
import { serviceLengthsRequired } from "@/lib/booking/destination";
import { normaliseOrigin } from "@/lib/embed";
import { venueMarket } from "@/lib/onboarding/rules";
import { paidWorkRefusal } from "@/lib/abuse/gate";
import { screenTrial } from "@/lib/abuse/review";

export const dynamic = "force-dynamic";

/**
 * Setting a venue up from its own website.
 *
 * Two verbs, and the gap between them is deliberate.
 *
 *   POST /api/setup { website }   — read it, return a draft. Writes nothing.
 *        (or multipart: website and/or up to three PDFs or images, read once
 *        and dropped — see lib/onboarding/uploads.ts)
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

  // Reading is a model call: never for an unconfirmed email or a paused trial,
  // and never for a website another account's trial or plan already has.
  const venue = listLocationsFor(user.tenantId)[0];
  const held = paidWorkRefusal(user, venue);
  if (held) return NextResponse.json({ error: held.error, fix: held.fix, code: held.code }, { status: held.status });
  const screen = (website: string) => {
    const refused = venue && website ? screenTrial(venue, "import", { website }) : null;
    return refused ? { status: refused.status, body: { error: refused.error, fix: refused.fix, code: refused.code } } : null;
  };

  // JSON { website } or multipart website + up to three files. Validation,
  // reading and refusals all live in the library so they can be checked
  // without a request scope; the files are read once there and dropped.
  const out = await draftFromRequest(req, {}, screen);
  return NextResponse.json(out.body, { status: out.status });
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

  // Every field is checked, hours included: the old handler cast whatever
  // arrived to WeeklyHours and saved it.
  // A length for each service only where Belline books it into a day itself.
  const checked = cleanConfirmed(body, { lengthsRequired: serviceLengthsRequired(location), country: venueMarket(location) });
  // With the field it is about, so the page can show it under that input.
  if (!checked.ok) return NextResponse.json({ error: checked.error, field: checked.field, service: checked.service }, { status: 422 });

  // One free trial per business: a website or phone another account's trial or
  // plan already has is refused before it is saved, and recorded for review.
  const duplicate = screenTrial(location, "review", { website: String(body.website ?? ""), phone: checked.confirmed.phone });
  if (duplicate) return NextResponse.json({ error: duplicate.error, fix: duplicate.fix, code: duplicate.code }, { status: duplicate.status });

  let updated;
  try {
    updated = applyDraft(location, checked.confirmed);
    // The review step is done, and the import step with it when what was
    // saved came from a website or files rather than being typed.
    const imported = Boolean(String(body.website ?? "").trim()) || Number(body.documents) > 0;
    updated = markReviewed(updated, Object.keys(checked.confirmed), imported);
    // The website setup read goes on as the widget's suggested site, so the
    // owner is not asked for it a second time on the website step.
    const site = normaliseOrigin(String(body.website ?? ""));
    const o = updated.onboarding!;
    if (site && !o.channels.web?.domains.includes(site)) {
      updated = { ...updated, onboarding: { ...o, channels: { ...o.channels, web: { ...o.channels.web, domains: [...(o.channels.web?.domains ?? []), site] } } } };
    }
    updated = upsertLocation(updated);
  } catch (err) {
    const out = customerError("setup", err, "failed", location.id);
    return NextResponse.json({ error: `${out.message} ${out.next}` }, { status: 500 });
  }

  // Recorded as a published version, like every other change to a venue's
  // configuration — so "who set this up, and what did it say on the call I am
  // complaining about" has an answer from the first day rather than the
  // second.
  publish(updated.id, user, setupNote(String(body.website ?? ""), Number(body.documents) || 0));

  // The page moves on to whatever the journey says is next, read from the venue
  // as it was just saved.
  return NextResponse.json({ ok: true, readiness: readiness(updated), next: stepAfter(journeyFor(updated), "import")?.url ?? "/" });
}

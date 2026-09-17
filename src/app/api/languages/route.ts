import { NextResponse } from "next/server";
import { getLocation, upsertLocation } from "@/lib/store";
import { canEditAgent } from "@/lib/auth";
import { requireApiUser } from "@/lib/auth-server";
import { publish } from "@/lib/brain";
import { checkLanguages } from "@/lib/language";

export const dynamic = "force-dynamic";

/**
 * The languages a business's customers are answered in: a main one, up to two
 * more, how a call picks between them, and a main language per channel.
 *
 * Only languages selectable on this deployment are accepted (language.ts
 * `checkLanguages`). A language whose flag is off is refused rather than stored
 * for later: a business that silently changes language the day a flag is
 * switched on is a surprise for an owner who tried it once.
 */
export async function PATCH(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const body = (await request.json().catch(() => ({}))) as { locationId?: string; languages?: unknown };
  const location = body.locationId ? getLocation(body.locationId) : undefined;
  if (!location) return NextResponse.json({ error: "Unknown location" }, { status: 404 });
  if (!canEditAgent(auth.user, location.id)) {
    return NextResponse.json({ error: "You cannot change the languages at this venue." }, { status: 403 });
  }

  const checked = checkLanguages(body.languages);
  if (!checked.ok) return NextResponse.json({ error: checked.error, field: checked.field }, { status: 422 });

  // `language` kept equal to the main language, for anything still reading it.
  upsertLocation({ ...location, languages: checked.value, language: checked.value.main });

  const published = publish(location.id, { id: auth.user.id, name: auth.user.name }, "Changed the languages");
  return NextResponse.json({
    ok: true,
    languages: checked.value,
    version: published?.version.number,
    changed: published?.changed ?? false,
  });
}

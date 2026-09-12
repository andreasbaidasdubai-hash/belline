import { NextResponse } from "next/server";
import { getLocation, upsertLocation } from "@/lib/store";
import { canEditAgent } from "@/lib/auth";
import { requireApiUser } from "@/lib/auth-server";
import { publish } from "@/lib/brain";
import type { Location } from "@/lib/types";
import {
  coercePolicy,
  coerceRestaurant,
  coerceSalon,
  isBlocking,
  validateVenue,
} from "@/lib/booking/config";

export const dynamic = "force-dynamic";

/**
 * How the venue actually works: the room, the price list, the team, the rules.
 *
 * The agent route next door changes what the agent *says*. This changes what
 * the engine *does* — and that difference is why this one refuses a bad save
 * rather than accepting it. A venue that talks nonsense on one call is an
 * embarrassment; a venue whose diary silently cannot take a booking is a
 * cancelled subscription, and nobody finds out which it was for a fortnight.
 *
 * So the order is: rebuild every field from scratch (nothing arriving over
 * HTTP is trusted to be the shape it claims), assemble the venue it would
 * become, check *that* rather than the payload, and only then write. Warnings
 * come back with a successful save, because a venue halfway through setting
 * itself up has plenty of them on purpose.
 */
export async function PATCH(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const body = (await request.json()) as {
    locationId?: string;
    policy?: unknown;
    restaurant?: unknown;
    salon?: unknown;
    note?: string;
  };

  const location = body.locationId ? getLocation(body.locationId) : undefined;
  if (!location) {
    return NextResponse.json({ error: "Unknown venue" }, { status: 404 });
  }
  if (!canEditAgent(auth.user, location.id)) {
    return NextResponse.json(
      { error: "You cannot change how this venue works." },
      { status: 403 },
    );
  }

  const next: Location = { ...location };

  // `"policy" in body` rather than a truthiness check: clearing every house
  // rule is a real edit, and it arrives as null.
  if ("policy" in body) next.policy = coercePolicy(body.policy);
  if ("restaurant" in body && location.restaurant) {
    next.restaurant = coerceRestaurant(body.restaurant, location.restaurant);
  }
  if ("salon" in body && location.salon) {
    next.salon = coerceSalon(body.salon, location.salon);
  }

  const findings = validateVenue(next);
  if (isBlocking(findings)) {
    return NextResponse.json(
      {
        error: "That would leave the diary unable to take a booking.",
        findings,
      },
      { status: 422 },
    );
  }

  upsertLocation(next);

  // After the save, not instead of it: the live venue stays the single source
  // of truth for the next call, and the history answers who changed what and
  // why. See brain.ts.
  const published = publish(
    location.id,
    { id: auth.user.id, name: auth.user.name },
    typeof body.note === "string" && body.note.trim() ? body.note.trim() : "Updated how the venue works",
  );

  return NextResponse.json({
    ok: true,
    findings,
    version: published?.version.number,
    changed: published?.changed ?? false,
  });
}

/** What is wrong with the venue as it stands, without changing anything. */
export async function GET(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const locationId = new URL(request.url).searchParams.get("loc") ?? "";
  const location = getLocation(locationId);
  if (!location) return NextResponse.json({ error: "Unknown venue" }, { status: 404 });
  if (!canEditAgent(auth.user, location.id)) {
    return NextResponse.json({ error: "Not your venue" }, { status: 403 });
  }

  return NextResponse.json({ findings: validateVenue(location) });
}

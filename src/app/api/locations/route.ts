import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { publish } from "@/lib/brain";
import {
  archiveLocation,
  createLocation,
  deleteLocation,
  restoreLocation,
  updateLocationBasics,
  type LocationInput,
} from "@/lib/locations";

export const dynamic = "force-dynamic";

/**
 * A business's locations: add, change the basics, archive, restore, delete.
 *
 * One route with an action, because every one of them is the same shape — an
 * owner or manager, a venue of theirs, a result that is either the venue or a
 * sentence to show. The rules live in lib/locations.ts, where they are tested.
 */
export async function POST(req: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const user = auth.user;

  const body = (await req.json().catch(() => ({}))) as LocationInput & {
    action?: string;
    locationId?: string;
    confirmName?: string;
  };
  const id = String(body.locationId ?? "");

  const fail = (error: string, status = 422, field?: string) => NextResponse.json({ error, field }, { status });

  switch (body.action) {
    case "create": {
      const result = createLocation(user, body);
      if (!result.ok) return fail(result.error, 422, result.field);
      return NextResponse.json({ ok: true, locationId: result.location.id });
    }
    case "update": {
      const result = updateLocationBasics(user, id, body);
      if (!result.ok) return fail(result.error, 422, result.field);
      publish(result.location.id, { id: user.id, name: user.name }, "Changed the location's details");
      return NextResponse.json({ ok: true });
    }
    case "archive": {
      const result = archiveLocation(user, id);
      return result.ok ? NextResponse.json({ ok: true }) : fail(result.error, 409);
    }
    case "restore": {
      const result = restoreLocation(user, id);
      return result.ok ? NextResponse.json({ ok: true }) : fail(result.error, 409);
    }
    case "delete": {
      const result = deleteLocation(user, id, String(body.confirmName ?? ""));
      return result.ok ? NextResponse.json({ ok: true }) : fail(result.error, 409);
    }
    default:
      return fail("Unknown action.", 400);
  }
}

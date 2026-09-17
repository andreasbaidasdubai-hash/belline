import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import type { Location, User } from "../types";
import { SESSION_COOKIE, canEditAgent } from "../auth";
import { getLocation, getSession, listLocationsFor } from "../store";
import { currentUser } from "../auth-server";
import { isViewAs } from "./identity";

/**
 * The dashboard Belle's routes share one gate: a signed-in person, not on a
 * read-only view-as session, asking about a venue of their own tenant that
 * they may change. Everything else is refused before anything is read.
 */

export async function belleOwner(
  requestedLocationId?: unknown,
): Promise<{ ok: true; user: User; location: Location } | { ok: false; response: NextResponse }> {
  const user = await currentUser();
  if (!user) return { ok: false, response: NextResponse.json({ error: "Not signed in." }, { status: 401 }) };
  const session = getSession((await cookies()).get(SESSION_COOKIE)?.value ?? "");
  if (isViewAs(session)) {
    return { ok: false, response: NextResponse.json({ error: "Read-only view: Belle is not available here." }, { status: 403 }) };
  }
  const id = (typeof requestedLocationId === "string" && requestedLocationId) || listLocationsFor(user.tenantId)[0]?.id || "";
  const location = id ? getLocation(id) : undefined;
  if (!location || location.tenantId !== user.tenantId || !canEditAgent(user, location.id)) {
    return { ok: false, response: NextResponse.json({ error: "Not your venue." }, { status: 403 }) };
  }
  return { ok: true, user, location };
}

/** For layouts: is the current cookie a read-only view-as session? */
export async function onViewAs(): Promise<boolean> {
  const id = (await cookies()).get(SESSION_COOKIE)?.value;
  return isViewAs(id ? getSession(id) : undefined);
}

import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { canSeeLocation } from "@/lib/auth";
import { getLocation, upsertLocation } from "@/lib/store";
import { authUrl, exchangeCode, googleConfigured, pushBooking } from "@/lib/integrations/google";
import { listBookings } from "@/lib/store";
import { todayIn } from "@/lib/time";

export const dynamic = "force-dynamic";

/** Where Google returns the venue after they approve. */
function redirectUri(request: Request): string {
  const url = new URL(request.url);
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ?? url.protocol.replace(":", "");
  const host = (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host)
    .split(",")[0]
    .trim();
  return `${proto}://${host}/api/integrations/google`;
}

/**
 * Start the connection, or finish it.
 *
 * Google sends the venue back here with a code. The same route handles both
 * halves so there is one URI to register with Google, which is the part that
 * is tedious to change later.
 */
export async function GET(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  if (!googleConfigured()) {
    return NextResponse.json(
      { error: "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first." },
      { status: 503 },
    );
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const locationId = url.searchParams.get("state") ?? url.searchParams.get("locationId");

  if (!locationId) return NextResponse.json({ error: "Which venue?" }, { status: 400 });

  const location = getLocation(locationId);
  if (!location) return NextResponse.json({ error: "Unknown venue" }, { status: 404 });
  if (!canSeeLocation(auth.user, location.id)) {
    return NextResponse.json({ error: "Not your venue" }, { status: 403 });
  }

  // First half: send them to Google.
  if (!code) {
    return NextResponse.redirect(authUrl(location.id, redirectUri(request)));
  }

  // Second half: they came back.
  try {
    const refreshToken = await exchangeCode(code, redirectUri(request));
    upsertLocation({
      ...location,
      google: {
        // The venue's own default calendar. A picker belongs here once more
        // than one is ever wanted; until then, guessing wrong is worse.
        calendarId: "primary",
        refreshToken,
        connectedAt: new Date().toISOString(),
        connectedBy: auth.user.id,
      },
    });

    // Push what is already on the book, so the calendar is not empty on the
    // day they connect it — which reads as "it did not work".
    const today = todayIn(location.timezone);
    const upcoming = listBookings({ locationId: location.id, status: "confirmed" })
      .filter((b) => b.date >= today)
      .slice(0, 50);
    const fresh = getLocation(location.id)!;
    for (const booking of upcoming) await pushBooking(fresh, booking);

    return NextResponse.redirect(new URL(`/integrations?loc=${location.id}&connected=1`, request.url));
  } catch (err) {
    return NextResponse.redirect(
      new URL(
        `/integrations?loc=${location.id}&error=${encodeURIComponent(
          err instanceof Error ? err.message : "Google refused the connection.",
        )}`,
        request.url,
      ),
    );
  }
}

/** Disconnect. The events already written stay — they are the venue's. */
export async function DELETE(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const { locationId } = (await request.json()) as { locationId?: string };
  const location = locationId ? getLocation(locationId) : undefined;
  if (!location) return NextResponse.json({ error: "Unknown venue" }, { status: 404 });
  if (!canSeeLocation(auth.user, location.id)) {
    return NextResponse.json({ error: "Not your venue" }, { status: 403 });
  }

  const { google: _dropped, ...rest } = location;
  upsertLocation(rest);
  return NextResponse.json({ ok: true });
}

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requireApiUser, sessionCookieOptions } from "@/lib/auth-server";
import { canEditAgent } from "@/lib/auth";
import { getLocation, listBookings, upsertLocation } from "@/lib/store";
import { flag } from "@/lib/flags";
import { credentialsConfigured } from "@/lib/db/credentials";
import { destinationOf } from "@/lib/booking/destination";
import {
  STATE_COOKIE,
  authUrl,
  chooseCalendars,
  completeConnection,
  disconnectGoogle,
  GoogleScopeError,
  listCalendarsFor,
  reportMisconfigured,
  returnPath,
  signState,
  verifyState,
  type Outcome,
  type ReturnTo,
} from "@/lib/integrations/google";
import { GoogleConfigError } from "@/lib/integrations/google-api";
import { queueGoogleSync, resyncMovedCalendars, settleGoogleSync } from "@/lib/integrations/google-sync";
import { todayIn } from "@/lib/time";
import { appOrigin } from "@/lib/origin";
import { customerError, raiseException } from "@/lib/errors/customer";

export const dynamic = "force-dynamic";

/** Where Google returns the owner after they choose. */
function redirectUri(request: Request): string {
  const url = new URL(request.url);
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ?? url.protocol.replace(":", "");
  const host = (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host)
    .split(",")[0]
    .trim();
  return `${proto}://${host}/api/integrations/google`;
}

const COOKIE_PATH = "/api/integrations/google";

/**
 * Back to the step or page the owner started from. The state cookie goes either
 * way: it is single use.
 *
 * Against `appOrigin()`, never `request.url`. Behind Railway's proxy the URL
 * this handler sees is the container's own `http://localhost:3000/...`, so a
 * redirect resolved against it sent the owner to localhost after a connection
 * that had otherwise succeeded. `redirectUri()` above reads the forwarded
 * headers because Google must be told the address it will call back; this one
 * is a browser redirect, and the app already knows its own public address.
 */
function land(_request: Request, returnTo: ReturnTo, locationId: string | undefined, outcome: Outcome) {
  const res = NextResponse.redirect(new URL(returnPath(returnTo, locationId, outcome), appOrigin()));
  res.cookies.set(STATE_COOKIE, "", { ...sessionCookieOptions(0), path: COOKIE_PATH });
  return res;
}

/**
 * Start the connection, or finish it.
 *
 * Without `state` this starts: the owner must be able to edit the venue, the
 * `booking.google` flag must be on, and the state sent to Google is signed,
 * expires, names the user and carries a nonce that is also a cookie. With
 * `state` Google has sent the owner back, and nothing is trusted until the
 * state checks out — the venue comes from the signed state, never the URL.
 *
 * A decline (`access_denied`) lands back where the owner started with "No
 * problem — requests for now", and never sends them to Google again.
 */
export async function GET(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const url = new URL(request.url);
  const state = url.searchParams.get("state");

  if (!state) {
    const returnTo: ReturnTo = url.searchParams.get("from") === "setup" ? "setup" : "integrations";
    const location = getLocation(url.searchParams.get("locationId") ?? "");
    if (!location || !canEditAgent(auth.user, location.id)) {
      return NextResponse.json({ error: "Not your venue." }, { status: 403 });
    }
    if (!flag("booking.google") || !credentialsConfigured()) {
      raiseException("google:not_configured", "Google Calendar connect opened while booking.google is off or no sealing key is set");
      return land(request, returnTo, location.id, "google_unavailable");
    }
    const signed = signState({ locationId: location.id, userId: auth.user.id, returnTo });
    const res = NextResponse.redirect(authUrl(signed.state, redirectUri(request)));
    res.cookies.set(STATE_COOKIE, signed.nonce, { ...sessionCookieOptions(600), path: COOKIE_PATH });
    return res;
  }

  const jar = await cookies();
  const checked = verifyState(state, { userId: auth.user.id, cookieNonce: jar.get(STATE_COOKIE)?.value });
  if (!checked.ok) {
    customerError("google", `oauth state refused: ${checked.reason}`, "failed");
    return land(request, checked.returnTo ?? "integrations", undefined, "google_failed");
  }
  const location = getLocation(checked.locationId);
  if (!location || !canEditAgent(auth.user, location.id)) {
    return NextResponse.json({ error: "Not your venue." }, { status: 403 });
  }

  const oauthError = url.searchParams.get("error");
  // Logged either way: a run of declines from one venue is worth a look.
  if (oauthError) console.warn(`[google] ${location.name}: Google sent the owner back with error=${oauthError.slice(0, 60)}`);
  if (oauthError === "access_denied") return land(request, checked.returnTo, location.id, "declined");
  if (oauthError) {
    customerError("google", `oauth returned ${oauthError}`, "refused", location.id);
    return land(request, checked.returnTo, location.id, "google_refused");
  }
  const code = url.searchParams.get("code");
  if (!code) return land(request, checked.returnTo, location.id, "google_failed");
  if (!flag("booking.google")) return land(request, checked.returnTo, location.id, "google_unavailable");

  try {
    const saved = upsertLocation(await completeConnection(location, code, redirectUri(request), auth.user.id));

    // One read before saying "connected": Google refusing Belline's own project
    // (the Calendar API switched off) only shows on a real call, and an owner
    // told "connected" would then find nothing works. withAccess marks the
    // venue, and the team gets the exception with the fix.
    try {
      await listCalendarsFor(saved);
    } catch (err) {
      if (err instanceof GoogleConfigError) return land(request, checked.returnTo, saved.id, "google_unavailable");
      // Anything else is transient: the connection stands, and the picker tries again.
      console.warn(`[google] ${saved.name}: calendars not readable right after connecting: ${err instanceof Error ? err.message : String(err)}`);
    }

    // A venue on Belline's diary gets what is already booked copied out, so
    // the calendar is not empty on the day they connect it. A venue booking
    // into Google starts with what it books from here on.
    if (destinationOf(saved) === "belline") {
      const today = todayIn(saved.timezone);
      const upcoming = listBookings({ locationId: saved.id, status: "confirmed" })
        .filter((b) => b.date >= today)
        .slice(0, 50);
      for (const booking of upcoming) queueGoogleSync(saved, booking);
      await settleGoogleSync();
    }
    return land(request, checked.returnTo, saved.id, "connected");
  } catch (err) {
    // The raw error is logged with a trace id; the owner gets a sentence.
    if (err instanceof GoogleScopeError) {
      // A permission unticked on Google's screen: connect again with both allowed.
      customerError("google", err, "refused", location.id);
      return land(request, checked.returnTo, location.id, "google_refused");
    }
    if (err instanceof GoogleConfigError) {
      // Our client id, secret or redirect address, not the owner.
      reportMisconfigured(location, err);
      customerError("google", err, "not_configured", location.id);
      return land(request, checked.returnTo, location.id, "google_unavailable");
    }
    customerError("google", err, "failed", location.id);
    return land(request, checked.returnTo, location.id, "google_failed");
  }
}

/** The calendar picker: one calendar for the venue, and optionally one per person. */
export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const body = (await request.json().catch(() => ({}))) as {
    locationId?: string;
    calendarId?: string;
    staffCalendars?: Record<string, string>;
  };
  const location = getLocation(String(body.locationId ?? ""));
  if (!location || !canEditAgent(auth.user, location.id)) {
    return NextResponse.json({ error: "Not your venue." }, { status: 403 });
  }
  if (!flag("booking.google") || !location.google) {
    return NextResponse.json({ error: "Connect Google Calendar first." }, { status: 409 });
  }

  try {
    const out = await chooseCalendars(location, {
      calendarId: String(body.calendarId ?? ""),
      staffCalendars: body.staffCalendars && typeof body.staffCalendars === "object" ? body.staffCalendars : {},
    });
    if (!out.ok) return NextResponse.json({ error: out.error }, { status: 422 });
    // Someone's bookings follow them to the calendar they now use.
    resyncMovedCalendars(upsertLocation(out.location));
    return NextResponse.json({ ok: true });
  } catch (err) {
    const said = customerError("google", err, "unavailable", location.id);
    return NextResponse.json({ error: `${said.message} ${said.next}` }, { status: 502 });
  }
}

/**
 * Disconnect. Access is withdrawn at Google, the link is dropped, and a venue
 * that booked into Google goes back to requests. Events already written stay:
 * they are the venue's.
 */
export async function DELETE(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const { locationId } = (await request.json().catch(() => ({}))) as { locationId?: string };
  const location = locationId ? getLocation(locationId) : undefined;
  if (!location || !canEditAgent(auth.user, location.id)) {
    return NextResponse.json({ error: "Not your venue." }, { status: 403 });
  }

  upsertLocation(await disconnectGoogle(location));
  return NextResponse.json({ ok: true });
}

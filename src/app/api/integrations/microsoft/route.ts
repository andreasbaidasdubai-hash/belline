import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requireApiUser, sessionCookieOptions } from "@/lib/auth-server";
import { canEditAgent } from "@/lib/auth";
import { getLocation, upsertLocation } from "@/lib/store";
import { flag } from "@/lib/flags";
import { credentialsConfigured } from "@/lib/db/credentials";
import {
  OUTLOOK_CALLBACK_PATH,
  OUTLOOK_DISCONNECTED_TEXT,
  OUTLOOK_STATE_COOKIE,
  chooseOutlookCalendars,
  disconnectOutlook,
  OutlookNoCalendarError,
  OutlookScopeError,
  completeOutlookConnection,
  outlookAuthUrl,
  outlookReturnPath,
  reportOutlookMisconfigured,
  signOutlookState,
  verifyOutlookState,
  type OutlookOutcome,
} from "@/lib/integrations/outlook";
import { MicrosoftConfigError } from "@/lib/integrations/microsoft-api";
import type { ReturnTo } from "@/lib/integrations/oauth-state";
import { resyncMovedCalendars } from "@/lib/integrations/calendar-sync";
import { appOrigin } from "@/lib/origin";
import { customerError, raiseException } from "@/lib/errors/customer";

export const dynamic = "force-dynamic";

/**
 * Where Microsoft returns the owner after they choose. Built from the forwarded
 * headers, as Google's is: Microsoft compares it character for character with
 * the redirect addresses registered on the Entra app.
 */
function redirectUri(request: Request): string {
  const url = new URL(request.url);
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ?? url.protocol.replace(":", "");
  const host = (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host)
    .split(",")[0]
    .trim();
  return `${proto}://${host}${OUTLOOK_CALLBACK_PATH}`;
}

/**
 * Back to the step or page the owner started from, against `appOrigin()` and
 * never `request.url`: behind Railway's proxy that is the container's own
 * localhost (see the Google route's `land()`). The state cookie goes either way.
 */
function land(returnTo: ReturnTo, locationId: string | undefined, outcome: OutlookOutcome) {
  const res = NextResponse.redirect(new URL(outlookReturnPath(returnTo, locationId, outcome), appOrigin()));
  res.cookies.set(OUTLOOK_STATE_COOKIE, "", { ...sessionCookieOptions(0), path: OUTLOOK_CALLBACK_PATH });
  return res;
}

/**
 * Start the connection, or finish it. The Outlook twin of the Google route.
 *
 * Without `state` this starts: the owner must be able to edit the venue, the
 * `booking.outlook` flag must be on, and the venue must not already have
 * Google Calendar connected (Belline keeps one calendar per venue). With
 * `state` Microsoft has sent the owner back, and nothing is trusted until the
 * state checks out — the venue comes from the signed state, never the URL.
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
    if (!flag("booking.outlook") || !credentialsConfigured()) {
      raiseException("outlook:not_configured", "Outlook connect opened while booking.outlook is off or no sealing key is set");
      return land(returnTo, location.id, "outlook_unavailable");
    }
    if (location.google) return land(returnTo, location.id, "outlook_in_use");
    const signed = signOutlookState({ locationId: location.id, userId: auth.user.id, returnTo });
    const res = NextResponse.redirect(outlookAuthUrl(signed.state, redirectUri(request)));
    res.cookies.set(OUTLOOK_STATE_COOKIE, signed.nonce, { ...sessionCookieOptions(600), path: OUTLOOK_CALLBACK_PATH });
    return res;
  }

  const jar = await cookies();
  const checked = verifyOutlookState(state, { userId: auth.user.id, cookieNonce: jar.get(OUTLOOK_STATE_COOKIE)?.value });
  if (!checked.ok) {
    customerError("outlook", `oauth state refused: ${checked.reason}`, "failed");
    return land(checked.returnTo ?? "integrations", undefined, "outlook_failed");
  }
  const location = getLocation(checked.locationId);
  if (!location || !canEditAgent(auth.user, location.id)) {
    return NextResponse.json({ error: "Not your venue." }, { status: 403 });
  }

  const oauthError = url.searchParams.get("error");
  const described = url.searchParams.get("error_description") ?? "";
  // Logged either way: a run of declines from one venue is worth a look.
  if (oauthError) console.warn(`[outlook] ${location.name}: Microsoft sent the owner back with error=${oauthError.slice(0, 60)} ${described.slice(0, 120)}`);
  if (oauthError === "access_denied") return land(checked.returnTo, location.id, "declined");
  if (oauthError) {
    customerError("outlook", `oauth returned ${oauthError}`, "refused", location.id);
    return land(checked.returnTo, location.id, "outlook_refused");
  }
  const code = url.searchParams.get("code");
  if (!code) return land(checked.returnTo, location.id, "outlook_failed");
  if (!flag("booking.outlook")) return land(checked.returnTo, location.id, "outlook_unavailable");
  if (location.google) return land(checked.returnTo, location.id, "outlook_in_use");

  try {
    upsertLocation(await completeOutlookConnection(location, code, redirectUri(request), auth.user.id));
    return land(checked.returnTo, location.id, "connected");
  } catch (err) {
    // The raw error is logged with a trace id; the owner gets a sentence.
    if (err instanceof OutlookScopeError || err instanceof OutlookNoCalendarError) {
      customerError("outlook", err, "refused", location.id);
      return land(checked.returnTo, location.id, "outlook_refused");
    }
    if (err instanceof MicrosoftConfigError) {
      // Our client id, secret or redirect address, not the owner.
      reportOutlookMisconfigured(location, err);
      customerError("outlook", err, "not_configured", location.id);
      return land(checked.returnTo, location.id, "outlook_unavailable");
    }
    customerError("outlook", err, "failed", location.id);
    return land(checked.returnTo, location.id, "outlook_failed");
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
  if (!flag("booking.outlook") || !location.outlook) {
    return NextResponse.json({ error: "Connect Outlook first." }, { status: 409 });
  }

  try {
    const out = await chooseOutlookCalendars(location, {
      calendarId: String(body.calendarId ?? ""),
      staffCalendars: body.staffCalendars && typeof body.staffCalendars === "object" ? body.staffCalendars : {},
    });
    if (!out.ok) return NextResponse.json({ error: out.error }, { status: 422 });
    // Someone's bookings follow them to the calendar they now use.
    resyncMovedCalendars(upsertLocation(out.location));
    return NextResponse.json({ ok: true });
  } catch (err) {
    const said = customerError("outlook", err, "unavailable", location.id);
    return NextResponse.json({ error: `${said.message} ${said.next}` }, { status: 502 });
  }
}

/**
 * Disconnect. Belline's sealed token and the link are dropped, and a venue that
 * booked into Outlook goes back to requests. Microsoft has no endpoint to revoke
 * one refresh token, so the answer tells the owner where to remove Belline's
 * permission in their Microsoft account. Events already written stay.
 */
export async function DELETE(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const { locationId } = (await request.json().catch(() => ({}))) as { locationId?: string };
  const location = locationId ? getLocation(locationId) : undefined;
  if (!location || !canEditAgent(auth.user, location.id)) {
    return NextResponse.json({ error: "Not your venue." }, { status: 403 });
  }

  upsertLocation(disconnectOutlook(location));
  return NextResponse.json({ ok: true, said: OUTLOOK_DISCONNECTED_TEXT });
}

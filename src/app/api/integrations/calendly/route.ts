import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requireApiUser, sessionCookieOptions } from "@/lib/auth-server";
import { canEditAgent } from "@/lib/auth";
import { getLocation, upsertLocation } from "@/lib/store";
import { flag } from "@/lib/flags";
import { credentialsConfigured } from "@/lib/db/credentials";
import {
  CALENDLY_CALLBACK_PATH,
  CALENDLY_DISCONNECTED_TEXT,
  CALENDLY_STATE_COOKIE,
  CalendlyConfigError,
  CalendlyNoEventTypesError,
  CalendlyScopeError,
  calendlyAuthUrl,
  calendlyReturnPath,
  chooseCalendlyEventTypes,
  completeCalendlyConnection,
  disconnectCalendly,
  reportCalendlyMisconfigured,
  signCalendlyState,
  verifyCalendlyState,
  type CalendlyOutcome,
} from "@/lib/integrations/calendly";
import type { ReturnTo } from "@/lib/integrations/oauth-state";
import { appOrigin } from "@/lib/origin";
import { customerError, raiseException } from "@/lib/errors/customer";

export const dynamic = "force-dynamic";

/**
 * Where Calendly returns the owner after they choose. Built from the forwarded
 * headers, as Google's and Microsoft's are: Calendly compares it character for
 * character with the redirect addresses on the OAuth application.
 */
function redirectUri(request: Request): string {
  const url = new URL(request.url);
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ?? url.protocol.replace(":", "");
  const host = (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host).split(",")[0].trim();
  return `${proto}://${host}${CALENDLY_CALLBACK_PATH}`;
}

/** Back to the step or page the owner started from, against `appOrigin()` and never `request.url`. */
function land(returnTo: ReturnTo, locationId: string | undefined, outcome: CalendlyOutcome) {
  const res = NextResponse.redirect(new URL(calendlyReturnPath(returnTo, locationId, outcome), appOrigin()));
  res.cookies.set(CALENDLY_STATE_COOKIE, "", { ...sessionCookieOptions(0), path: CALENDLY_CALLBACK_PATH });
  return res;
}

/**
 * Start the connection, or finish it. The Calendly twin of the Google and
 * Microsoft routes.
 *
 * Without `state` this starts: the owner must be able to edit the venue, the
 * `booking.calendly` flag must be on, and the venue must not already have
 * Google Calendar or Outlook connected — Belline books into one place per
 * venue. With `state` Calendly has sent the owner back, and nothing is trusted
 * until the state checks out: the venue comes from the signed state, never the
 * URL.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  if (!state) {
    const returnTo: ReturnTo = url.searchParams.get("from") === "setup" ? "setup" : "calendars";
    const location = getLocation(url.searchParams.get("locationId") ?? "");
    if (!location || !canEditAgent(auth.user, location.id)) {
      return NextResponse.json({ error: "Not your venue." }, { status: 403 });
    }
    if (!flag("booking.calendly") || !credentialsConfigured()) {
      raiseException("calendly:not_configured", "Calendly connect opened while booking.calendly is off or no sealing key is set");
      return land(returnTo, location.id, "calendly_unavailable");
    }
    if (location.google || location.outlook) return land(returnTo, location.id, "calendly_in_use");
    const signed = signCalendlyState({ locationId: location.id, userId: auth.user.id, returnTo });
    const res = NextResponse.redirect(calendlyAuthUrl(signed.state, redirectUri(request)));
    res.cookies.set(CALENDLY_STATE_COOKIE, signed.nonce, { ...sessionCookieOptions(600), path: CALENDLY_CALLBACK_PATH });
    return res;
  }

  const jar = await cookies();
  const checked = verifyCalendlyState(state, { userId: auth.user.id, cookieNonce: jar.get(CALENDLY_STATE_COOKIE)?.value });
  if (!checked.ok) {
    customerError("calendly", `oauth state refused: ${checked.reason}`, "failed");
    return land(checked.returnTo ?? "calendars", undefined, "calendly_failed");
  }
  const location = getLocation(checked.locationId);
  if (!location || !canEditAgent(auth.user, location.id)) {
    return NextResponse.json({ error: "Not your venue." }, { status: 403 });
  }

  const oauthError = url.searchParams.get("error");
  const described = url.searchParams.get("error_description") ?? "";
  if (oauthError) {
    console.warn(`[calendly] ${location.name}: Calendly sent the owner back with error=${oauthError.slice(0, 60)} ${described.slice(0, 120)}`);
    if (oauthError === "access_denied") return land(checked.returnTo, location.id, "declined");
    customerError("calendly", `oauth returned ${oauthError}`, "refused", location.id);
    return land(checked.returnTo, location.id, "calendly_refused");
  }
  const code = url.searchParams.get("code");
  if (!code) return land(checked.returnTo, location.id, "calendly_failed");
  if (!flag("booking.calendly")) return land(checked.returnTo, location.id, "calendly_unavailable");
  if (location.google || location.outlook) return land(checked.returnTo, location.id, "calendly_in_use");

  try {
    upsertLocation(await completeCalendlyConnection(location, code, redirectUri(request), auth.user.id));
    // Nothing is copied out, unlike Google's and Outlook's connect: there is
    // nowhere in Calendly to copy a Belline booking to. The Calendars page now
    // shows what this account can and cannot do (`calendlyLimits`), which the
    // owner reads before choosing Calendly as their destination.
    return land(checked.returnTo, location.id, "connected");
  } catch (err) {
    if (err instanceof CalendlyScopeError) {
      customerError("calendly", err, "refused", location.id);
      return land(checked.returnTo, location.id, "calendly_refused");
    }
    if (err instanceof CalendlyNoEventTypesError) {
      customerError("calendly", err, "no_calendar", location.id);
      return land(checked.returnTo, location.id, "calendly_no_event_types");
    }
    if (err instanceof CalendlyConfigError) {
      // Our client id, secret, redirect address or scopes — not the owner.
      reportCalendlyMisconfigured(location, err);
      customerError("calendly", err, "not_configured", location.id);
      return land(checked.returnTo, location.id, "calendly_unavailable");
    }
    customerError("calendly", err, "failed", location.id);
    return land(checked.returnTo, location.id, "calendly_failed");
  }
}

/**
 * The event type picker: which Calendly event type each service books.
 *
 * Calendly's equivalent of Google's and Outlook's calendar picker, and rather
 * more load-bearing: a service with no event type cannot be booked at all, so
 * this is the page that decides whether Belline can take the venue's bookings.
 */
export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const body = (await request.json().catch(() => ({}))) as {
    locationId?: string;
    defaultEventType?: string;
    serviceEventTypes?: Record<string, string>;
  };
  const location = getLocation(String(body.locationId ?? ""));
  if (!location || !canEditAgent(auth.user, location.id)) {
    return NextResponse.json({ error: "Not your venue." }, { status: 403 });
  }
  if (!flag("booking.calendly") || !location.calendly) {
    return NextResponse.json({ error: "Connect Calendly first." }, { status: 409 });
  }

  const out = chooseCalendlyEventTypes(location, {
    defaultEventType: body.defaultEventType ? String(body.defaultEventType) : undefined,
    serviceEventTypes: body.serviceEventTypes && typeof body.serviceEventTypes === "object" ? body.serviceEventTypes : {},
  });
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: 422 });
  upsertLocation(out.location);
  return NextResponse.json({ ok: true });
}

/**
 * Disconnect. Belline's access is withdrawn at Calendly (it has a real revoke
 * endpoint, unlike Microsoft), the webhook Belline added is removed, the sealed
 * token and the link are dropped, and a venue that booked into Calendly goes
 * back to requests. Bookings already in the owner's Calendly stay: they are
 * theirs.
 */
export async function DELETE(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const { locationId } = (await request.json().catch(() => ({}))) as { locationId?: string };
  const location = locationId ? getLocation(locationId) : undefined;
  if (!location || !canEditAgent(auth.user, location.id)) {
    return NextResponse.json({ error: "Not your venue." }, { status: 403 });
  }

  upsertLocation(await disconnectCalendly(location));
  return NextResponse.json({ ok: true, said: CALENDLY_DISCONNECTED_TEXT });
}

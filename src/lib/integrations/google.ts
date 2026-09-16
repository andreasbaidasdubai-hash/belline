import type { Booking, Location } from "../types";
import { bookingEventId, overlapsBusy, type Busy, type CalendarConnector } from "./calendar-connector";
import { getLocation, listLocations, upsertLocation } from "../store";
import { signOAuthState, takeExpiredStates, verifyOAuthState, type ReturnTo, type StateCheck } from "./oauth-state";
import { describeBookingShort } from "../booking";
import { destinationOf, googleUsable } from "../booking/destination";
import { credentialsConfigured, openCredentials, sealCredentials } from "../db/credentials";
import { raiseException } from "../errors/customer";
import { openException } from "../exceptions";
import { flag } from "../flags";
import {
  GOOGLE_SCOPES,
  GoogleAuthError,
  GoogleConfigError,
  liveGoogleApi,
  missingScopes,
  zonedInstant,
  type GoogleApi,
  type GoogleCalendarEntry,
  type GoogleEvent,
} from "./google-api";
import { fakeGoogleApi } from "../testing/stubs";

export { googleUsable } from "../booking/destination";

/**
 * Google Calendar.
 *
 * Of the systems on the website this is the only one that can be built
 * without a commercial agreement: Fresha, SevenRooms, OpenTable and Treatwell
 * all issue credentials under contract, and no amount of code changes that.
 * Google is open, which makes it the integration that matters first — and for
 * a great many clinics and salons the diary really is a Google calendar.
 *
 * Two ways to use it, and the owner's destination decides which.
 *
 * - **Mirror** (destination `belline`): Belline's own diary decides, and each
 *   booking is copied out to where the team already looks. This is what it
 *   always did.
 * - **Two-way** (destination `google`, flag `booking.google`): busy times on
 *   the calendars the owner picked are read back and taken out of what Belline
 *   offers, and each booking is created in the calendar with an id derived
 *   from its idempotency key. Belline's own rules — hours, services, staff,
 *   notice — still decide what can be booked at all; the calendar can only
 *   take times away. See booking/google-provider.ts.
 *
 * The refresh token is the one secret here. It is sealed with CREDENTIALS_KEY
 * (AES-GCM, db/credentials.ts) before it touches the location record, and a
 * record written before that was true is sealed, or dropped, on boot.
 *
 * When Google stops accepting the token — revoked, expired, password changed —
 * the link is marked, the team gets an exception, the owner sees a banner, and
 * `takesRequestsOnly` flips the venue to requests until somebody reconnects.
 * Nothing is booked into a calendar Belline cannot see.
 */

export interface GoogleLink {
  /** The calendar bookings go into, and busy times are read from, for the whole venue. */
  calendarId: string;
  calendarName?: string;
  /** A staff member's own calendar, by staff id: busy there blocks only them. */
  staffCalendars?: Record<string, string>;
  /** The refresh token, sealed with CREDENTIALS_KEY. */
  sealedToken?: string;
  /**
   * Plaintext, from before tokens were sealed. Never written any more;
   * `sealLegacyGoogleTokens` seals or drops it on boot.
   */
  refreshToken?: string;
  /** What Google actually granted, space-separated as it returned it. */
  scope?: string;
  connectedAt: string;
  connectedBy: string;
  /** Our own sentence for the owner, never Google's text. */
  lastError?: string;
  lastSyncedAt?: string;
  /** Google stopped accepting the connection. The venue takes requests until it is reconnected. */
  expiredAt?: string;
  /**
   * Google refused because of Belline's own Google project (the Calendar API
   * not enabled, the client not recognised). Nothing the owner can do: the
   * venue takes requests, the team has an exception, and the sweep checks
   * again until Google answers.
   */
  misconfiguredAt?: string;
}

export const GOOGLE_EXPIRED_TEXT =
  "Google Calendar stopped letting Belline in, so bookings are taken as requests until you reconnect it.";
export const GOOGLE_MISCONFIGURED_TEXT =
  "Google Calendar is connected, but Google is not letting Belline use it yet because of a setting on Belline's side. The Belline team has been told. Bookings are taken as requests until it is fixed; you don't need to do anything.";
export const GOOGLE_ABANDONED_TEXT =
  "Your last try at connecting Google Calendar never came back from Google. If Google said access is blocked, or that the app has not been verified, your Google account is not on Belline's early-access list yet: tell the Belline team which Google address you used and we will add it, then connect again. If you simply closed the window, connect again whenever you like.";
export const WRITE_FAILED_TEXT =
  "Google Calendar did not accept the last booking change. The booking is safe in Belline, and Belline keeps trying.";

/** Kept for callers that only ask whether a connection can be offered. */
export function googleConfigured(): boolean {
  return flag("booking.google") && credentialsConfigured();
}

// ---------------------------------------------------------------------------
// Which API
// ---------------------------------------------------------------------------

const globalRef = globalThis as unknown as {
  __bellineGoogleApi?: GoogleApi | null;
  __bellineGoogleStub?: ReturnType<typeof fakeGoogleApi>;
  __bellineGoogleAccess?: Map<string, { token: string; until: number; sealed: string }>;
};

/** Tests inject a fake here. Null puts the default back. */
export function setGoogleApi(api: GoogleApi | null): void {
  globalRef.__bellineGoogleApi = api;
  globalRef.__bellineGoogleAccess?.clear();
}

/** The injected API, the stub under FLAG_STUBS, or Google itself. */
export function googleApi(): GoogleApi {
  if (globalRef.__bellineGoogleApi) return globalRef.__bellineGoogleApi;
  if (flag("stubs")) {
    globalRef.__bellineGoogleStub ??= fakeGoogleApi();
    return globalRef.__bellineGoogleStub.api;
  }
  return liveGoogleApi;
}

// ---------------------------------------------------------------------------
// OAuth state: signed, single use, bound to the browser and the user
// ---------------------------------------------------------------------------

export const STATE_COOKIE = "belline_google_state";

export type { ReturnTo, StateCheck } from "./oauth-state";

/**
 * The `state` Google hands back.
 *
 * It used to be the bare location id, which let anybody who could get an owner
 * to click a link attach their own Google account to that owner's venue. Now
 * it is signed, expires in ten minutes, names the user who started it, and
 * carries a nonce that is also set as a cookie and can be used once. The
 * mechanics are shared with Outlook: see oauth-state.ts.
 */
export function signState(input: { locationId: string; userId: string; returnTo: ReturnTo }, now = Date.now()): { state: string; nonce: string } {
  return signOAuthState("google", input, now);
}

/**
 * Connections started and never finished, once their ten minutes are up.
 *
 * While the Google project is in Testing mode, an owner whose Google account
 * is not on its test-users list is stopped on Google's own page ("Access
 * blocked … Error 403: access_denied") and is never sent back to Belline, so
 * the callback cannot see it. This is where it shows: a start with no return.
 * The venue is marked so the owner sees what to do, and the team gets an
 * exception, because closing the window looks the same from here.
 */
export function sweepAbandonedConnects(now = new Date()): number {
  const gone = takeExpiredStates("google", now);
  let raised = 0;
  for (const row of gone) {
    const location = getLocation(row.locationId);
    if (!location) continue;
    // Connected since: a later try went through.
    if (location.google && location.google.connectedAt >= row.createdAt && !location.google.expiredAt) continue;
    upsertLocation({ ...location, googleConnectAbandonedAt: row.createdAt });
    console.warn(`[google] ${location.name}: a connection started at ${row.createdAt} never came back from Google`);
    openException({
      tenantId: location.tenantId,
      locationId: location.id,
      kind: "google_connect_abandoned",
      reason:
        `The owner started connecting Google Calendar at ${row.createdAt} and never came back from Google. ` +
        "In Testing mode that is what an account missing from the OAuth consent screen's test users looks like: add their Google address " +
        "(Google Cloud, OAuth consent screen, Test users), then ask them to connect again. It is also what closing the window looks like.",
      context: { userId: row.userId },
      source: "system",
    });
    raised++;
  }
  return raised;
}

export function verifyState(state: string, opts: { userId: string; cookieNonce?: string; now?: number }): StateCheck {
  return verifyOAuthState("google", state, opts);
}

/**
 * Where Google sends the owner to approve.
 *
 * `access_type=offline` with `prompt=consent` is what actually returns a
 * refresh token — without both, the first connection works and every one
 * after it silently returns no refresh token at all.
 *
 * Under stubs there is no Google screen to visit: the URL comes straight back
 * with the stub's code, as if the owner had pressed Allow.
 */
export function authUrl(state: string, redirectUri: string): string {
  if (flag("stubs") && !globalRef.__bellineGoogleApi) {
    return `${redirectUri}?${new URLSearchParams({ state, code: "stub-code" })}`;
  }
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID ?? "",
    redirect_uri: redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    scope: GOOGLE_SCOPES.join(" "),
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export type Outcome = "connected" | "declined" | "google_unavailable" | "google_refused" | "google_failed" | "google_in_use";

/**
 * Where the owner lands after Google, by where they started. Never Google
 * again: a decline goes back to the step they came from, which is how the old
 * route's loop is gone.
 */
export function returnPath(returnTo: ReturnTo, locationId: string | undefined, outcome: Outcome): string {
  if (returnTo === "setup") return `/setup/bookings?google=${outcome}`;
  const loc = locationId ? `loc=${encodeURIComponent(locationId)}&` : "";
  if (outcome === "connected") return `/integrations?${loc}connected=1`;
  return `/integrations?${loc}error=${outcome === "declined" ? "google_declined" : outcome}`;
}

// ---------------------------------------------------------------------------
// The token
// ---------------------------------------------------------------------------

export function sealToken(refreshToken: string): string {
  return sealCredentials({ refreshToken });
}

function openToken(link: GoogleLink): string {
  if (!link.sealedToken) throw new GoogleAuthError("no sealed token on the link");
  return openCredentials(link.sealedToken).refreshToken;
}

/** The owner unticked one of the two permissions on Google's screen. */
export class GoogleScopeError extends Error {
  constructor(readonly missing: string[]) {
    super(`Google granted the connection without ${missing.join(", ")}`);
    this.name = "GoogleScopeError";
  }
}

/**
 * Finish OAuth. Returns the venue with the link on it; the caller saves it.
 *
 * Google lets an owner untick either permission and still press Continue. A
 * connection without both would fail on its first booking, so it is refused
 * here instead, the token handed back to Google, and the owner told to connect
 * again with both ticked.
 */
export async function completeConnection(location: Location, code: string, redirectUri: string, userId: string, now = new Date()): Promise<Location> {
  const { refreshToken, scope } = await googleApi().exchangeCode(code, redirectUri);
  const missing = missingScopes(scope);
  if (missing.length) {
    await googleApi()
      .revoke(refreshToken)
      .catch(() => {});
    throw new GoogleScopeError(missing);
  }
  const previous = location.google;
  const { refreshToken: _legacy, ...kept } = previous ?? ({} as Partial<GoogleLink>);
  const { googleConnectAbandonedAt: _abandoned, ...venue } = location;
  return {
    ...venue,
    google: {
      // Reconnecting keeps the calendars the owner already picked.
      calendarId: kept.calendarId ?? "primary",
      calendarName: kept.calendarName,
      staffCalendars: kept.staffCalendars,
      sealedToken: sealToken(refreshToken),
      scope,
      connectedAt: now.toISOString(),
      connectedBy: userId,
    },
  };
}

/**
 * Run `fn` with an access token.
 *
 * A token Google no longer accepts marks the link expired, raises one
 * exception for the team, and rethrows: the caller treats that as "cannot see
 * the calendar", and the next call finds the venue on requests.
 */
export async function withAccess<T>(location: Location, fn: (token: string, api: GoogleApi) => Promise<T>): Promise<T> {
  const link = location.google;
  if (!link) throw new GoogleAuthError("not connected");
  const api = googleApi();
  const cache = (globalRef.__bellineGoogleAccess ??= new Map());
  try {
    let hit = cache.get(location.id);
    if (!hit || hit.until < Date.now() || hit.sealed !== link.sealedToken) {
      const token = await api.accessToken(openToken(link));
      hit = { token, until: Date.now() + 45 * 60_000, sealed: link.sealedToken ?? "" };
      cache.set(location.id, hit);
    }
    try {
      return await fn(hit.token, api);
    } catch (err) {
      if (!(err instanceof GoogleAuthError)) throw err;
      // The cached token may simply have gone stale: one fresh try.
      cache.delete(location.id);
      const token = await api.accessToken(openToken(link));
      cache.set(location.id, { token, until: Date.now() + 45 * 60_000, sealed: link.sealedToken ?? "" });
      return await fn(token, api);
    }
  } catch (err) {
    if (err instanceof GoogleAuthError) markExpired(location.id, err.message);
    if (err instanceof GoogleConfigError) markMisconfigured(location.id, err);
    throw err;
  }
}

export function markExpired(locationId: string, detail = ""): void {
  globalRef.__bellineGoogleAccess?.delete(locationId);
  const location = getLocation(locationId);
  if (!location?.google || location.google.expiredAt) return;
  upsertLocation({ ...location, google: { ...location.google, expiredAt: new Date().toISOString(), lastError: GOOGLE_EXPIRED_TEXT } });
  raiseException(`google:expired:${locationId}`, `Google no longer accepts the connection for ${location.name}; bookings fall back to requests. ${detail}`);
  openException({
    tenantId: location.tenantId,
    locationId,
    kind: "google_token_expired",
    reason: `Google stopped accepting ${location.name}'s calendar connection (revoked, expired or password changed). The venue is on requests and the owner has a banner asking them to reconnect. ${detail}`.trim(),
    source: "system",
  });
}

/**
 * Google refused because of Belline's Google project. The venue goes to
 * requests (see `googleUsable`), the owner is told it is ours to fix, and the
 * team gets an exception naming the fix. `recheckMisconfigured` clears it.
 */
export function markMisconfigured(locationId: string, err: GoogleConfigError): void {
  globalRef.__bellineGoogleAccess?.delete(locationId);
  const location = getLocation(locationId);
  if (!location?.google || location.google.misconfiguredAt) return;
  upsertLocation({ ...location, google: { ...location.google, misconfiguredAt: new Date().toISOString(), lastError: GOOGLE_MISCONFIGURED_TEXT } });
  reportMisconfigured(location, err);
}

/** The team's side of a project problem: a log line and an exception naming the fix. */
export function reportMisconfigured(location: Location, err: GoogleConfigError): void {
  const locationId = location.id;
  const fix =
    err.reason === "api_disabled"
      ? "Enable the Google Calendar API on the Google Cloud project that owns GOOGLE_CLIENT_ID (APIs & Services, Library, Google Calendar API, Enable), wait a few minutes; the sweep clears this on its own."
      : "Check GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and the authorised redirect address in Google Cloud against the app's.";
  raiseException(`google:misconfigured:${locationId}`, `Google refused ${location.name}'s calendar because of the Google project (${err.reason}): ${err.message}`);
  openException({
    tenantId: location.tenantId,
    locationId,
    kind: "google_misconfigured",
    reason: `Google refused ${location.name}'s calendar because of Belline's Google project (${err.reason}). ${fix}`,
    context: { reason: err.reason },
    source: "system",
  });
}

/**
 * Ask Google again for every venue marked misconfigured, and clear the mark
 * where it now answers. Run by the sweep. Returns how many were cleared.
 */
export async function recheckMisconfigured(): Promise<number> {
  let cleared = 0;
  if (!flag("booking.google")) return 0;
  for (const location of listLocations({ includeInternal: true })) {
    const link = location.google;
    if (!link?.misconfiguredAt || link.expiredAt || !link.sealedToken) continue;
    try {
      const api = googleApi();
      const token = await api.accessToken(openToken(link));
      await api.listCalendars(token);
    } catch (err) {
      if (err instanceof GoogleAuthError) markExpired(location.id, err.message);
      continue;
    }
    const fresh = getLocation(location.id);
    if (!fresh?.google) continue;
    const { misconfiguredAt: _cleared, ...rest } = fresh.google;
    upsertLocation({ ...fresh, google: { ...rest, lastError: rest.lastError === GOOGLE_MISCONFIGURED_TEXT ? undefined : rest.lastError } });
    console.log(`[google] ${location.name}: Google answers again; the calendar is back in use`);
    cleared++;
  }
  return cleared;
}

/** A write Google refused: the owner sees our sentence on the connection, the log gets Google's. */
export function noteWriteFailure(locationId: string, raw: unknown): void {
  const location = getLocation(locationId);
  if (!location?.google) return;
  if (location.google.lastError !== WRITE_FAILED_TEXT) {
    upsertLocation({ ...location, google: { ...location.google, lastError: WRITE_FAILED_TEXT } });
  }
  console.warn(`[google] ${location.name}: ${raw instanceof Error ? raw.message : String(raw)}`);
}

/**
 * A write Google accepted. The warning goes only when it was the write warning
 * and nothing else at the venue is still failing: one booking getting through
 * does not mean another stuck one has.
 */
export function noteWriteSuccess(locationId: string, stillFailing: boolean, now = new Date()): void {
  const location = getLocation(locationId);
  if (!location?.google) return;
  const clear = location.google.lastError === WRITE_FAILED_TEXT && !stillFailing;
  upsertLocation({
    ...location,
    google: { ...location.google, lastSyncedAt: now.toISOString(), ...(clear ? { lastError: undefined } : {}) },
  });
}

/**
 * Seal any refresh token still stored in plain text.
 *
 * Without CREDENTIALS_KEY there is nothing to seal it with, so it is dropped:
 * a plain token in the location file is worse than asking an owner to
 * reconnect. The link is marked expired, which puts the venue on requests.
 */
export function sealLegacyGoogleTokens(): number {
  let changed = 0;
  for (const location of listLocations({ includeInternal: true, includeArchived: true })) {
    const link = location.google;
    if (!link?.refreshToken) continue;
    const { refreshToken, ...rest } = link;
    if (credentialsConfigured()) {
      upsertLocation({ ...location, google: { ...rest, sealedToken: sealToken(refreshToken) } });
    } else {
      upsertLocation({ ...location, google: { ...rest, expiredAt: new Date().toISOString(), lastError: GOOGLE_EXPIRED_TEXT } });
      raiseException(`google:unsealed:${location.id}`, `A plain Google token for ${location.name} was dropped: no key to seal it with. The owner has to reconnect.`);
    }
    changed++;
  }
  return changed;
}

/** Revoke at Google (best effort), drop the link, and stop sending bookings there. */
export async function disconnectGoogle(location: Location, now = new Date()): Promise<Location> {
  const link = location.google;
  if (link?.sealedToken) {
    try {
      await googleApi().revoke(openToken(link));
    } catch (err) {
      // The link goes either way; the owner can also remove Belline in their Google account.
      console.warn(`[google] revoke failed for ${location.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  globalRef.__bellineGoogleAccess?.delete(location.id);
  const { google: _dropped, ...rest } = location;
  const o = rest.onboarding;
  if (o?.destination?.kind === "google") {
    return { ...rest, onboarding: { ...o, destination: { kind: "requests", setAt: now.toISOString() } } };
  }
  return rest;
}

// ---------------------------------------------------------------------------
// Calendars and busy times
// ---------------------------------------------------------------------------

export async function listCalendarsFor(location: Location): Promise<GoogleCalendarEntry[]> {
  return withAccess(location, (token, api) => api.listCalendars(token));
}

/**
 * Save the owner's picks, checked against what their account can write to.
 * Returns an owner-facing sentence when a pick is not one of theirs.
 */
export async function chooseCalendars(
  location: Location,
  input: { calendarId: string; staffCalendars?: Record<string, string> },
): Promise<{ ok: true; location: Location } | { ok: false; error: string }> {
  if (!location.google) return { ok: false, error: "Connect Google Calendar first." };
  const calendars = await listCalendarsFor(location);
  const byId = new Map(calendars.map((c) => [c.id, c]));
  const venueCal = byId.get(input.calendarId);
  if (!venueCal) return { ok: false, error: "That calendar is not one your Google account can add events to." };
  const staffIds = new Set((location.salon?.staff ?? []).map((s) => s.id));
  const staffCalendars: Record<string, string> = {};
  for (const [staffId, calendarId] of Object.entries(input.staffCalendars ?? {})) {
    if (!calendarId) continue;
    if (!staffIds.has(staffId)) return { ok: false, error: "That person is not on your team list." };
    if (!byId.has(calendarId)) return { ok: false, error: "One of those calendars is not one your Google account can add events to." };
    staffCalendars[staffId] = calendarId;
  }
  return {
    ok: true,
    location: { ...location, google: { ...location.google, calendarId: venueCal.id, calendarName: venueCal.name, staffCalendars } },
  };
}

/** The calendar a booking for this person goes into. */
export function calendarFor(link: GoogleLink, staffId?: string): string {
  return (staffId && link.staffCalendars?.[staffId]) || link.calendarId;
}

export type { Busy } from "./calendar-connector";

/**
 * Busy intervals, per calendar, for one local day (and the small hours after
 * it, where a late sitting ends).
 *
 * Events Belline wrote are skipped: its own diary already holds them, and
 * counting them again would make one table's booking block every other table.
 * So are events the owner marked as "free".
 */
export async function busyFor(location: Location, date: string): Promise<Busy> {
  const link = location.google!;
  const calendars = [...new Set([link.calendarId, ...Object.values(link.staffCalendars ?? {})])];
  const timeMin = new Date(zonedInstant(date, 0, location.timezone)).toISOString();
  const timeMax = new Date(zonedInstant(date, 36 * 60, location.timezone)).toISOString();
  return withAccess(location, async (token, api) => {
    const out: Busy = new Map();
    for (const calendarId of calendars) {
      const events = await api.listEvents(token, calendarId, timeMin, timeMax);
      out.set(
        calendarId,
        events
          .filter((e) => !e.transparent && !e.bellineBookingId)
          .map((e) => [Date.parse(e.start), Date.parse(e.end)] as [number, number]),
      );
    }
    return out;
  });
}

/** Is this interval taken on the venue's calendar, or on this person's own? */
export function isBusy(location: Location, busy: Busy, slot: { date: string; startMin: number; endMin: number; staffId?: string }): boolean {
  const link = location.google!;
  const from = zonedInstant(slot.date, slot.startMin, location.timezone);
  const to = zonedInstant(slot.date, slot.endMin, location.timezone);
  return overlapsBusy(busy, new Set([link.calendarId, calendarFor(link, slot.staffId)]), from, to);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * A Google event id is an event key (calendar-connector.ts): Google lets the
 * caller choose the id, and an insert with an id that exists is refused with
 * 409, so the same key arriving twice can only ever make one event.
 */
export { bookingEventId, eventIdFor } from "./calendar-connector";

/** A local wall-clock time in the venue's own zone, as Google wants it. */
function isoLocal(date: string, minutes: number): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCMinutes(minutes);
  return day.toISOString().slice(0, 19);
}

export function eventFor(location: Location, booking: Booking, id: string): GoogleEvent {
  const twoWay = destinationOf(location) === "google";
  return {
    id,
    summary: `${booking.guestName} — ${describeBookingShort(location, booking)}`,
    description: [
      `Booked through Belline (${booking.source}).`,
      booking.guestPhone ? `Phone: ${booking.guestPhone}` : null,
      booking.notes ? `Note: ${booking.notes}` : null,
      `Reference: ${booking.ref}`,
      "",
      twoWay
        ? "To change or cancel this booking, do it in Belline, so the customer's record stays right."
        : "Belline owns availability. Changing this event does not change the booking.",
    ]
      .filter((line) => line !== null)
      .join("\n"),
    start: { dateTime: isoLocal(booking.date, booking.startMin), timeZone: location.timezone },
    end: { dateTime: isoLocal(booking.date, booking.endMin), timeZone: location.timezone },
    status: booking.status === "confirmed" ? "confirmed" : "cancelled",
    // Tagged, so reading busy times back can skip what Belline wrote itself.
    extendedProperties: { private: { bellineBookingId: booking.id } },
  };
}

/** Google, as the shared provider and sync see it (calendar-connector.ts). */
export const googleConnector: CalendarConnector = {
  kind: "google",
  name: "Google Calendar",
  tag: "google",
  failedException: "google_sync_failed",
  linked: (location) => Boolean(location.google),
  usable: (location) => googleUsable(location),
  calendarFor: (location, staffId) => calendarFor(location.google!, staffId),
  keyOf: (booking) => booking.calendarEventId ?? bookingEventId(booking),
  refFields: (key) => ({ calendarEventId: key }),
  async put(location, booking, calendarId, key) {
    await withAccess(location, (token, api) => api.putEvent(token, calendarId, eventFor(location, booking, key)));
    return key;
  },
  async insert(location, booking, calendarId, key) {
    await withAccess(location, (token, api) => api.insertEvent(token, calendarId, eventFor(location, booking, key)));
    return key;
  },
  async remove(location, _booking, ref) {
    await withAccess(location, (token, api) => api.cancelEvent(token, ref.calendarId, ref.eventId));
  },
  busyFor: (location, date) => busyFor(location, date),
  isBusy: (location, busy, slot) => isBusy(location, busy, slot),
  waiting: (err) => err instanceof GoogleAuthError || err instanceof GoogleConfigError,
  noteWriteFailure: (locationId, raw) => noteWriteFailure(locationId, raw),
  noteWriteSuccess: (locationId, stillFailing, now) => noteWriteSuccess(locationId, stillFailing, now),
};

/** What the dashboard shows about the connection. Our sentences only. */
export function connectionState(location: Location): {
  connected: boolean;
  healthy: boolean;
  expired: boolean;
  detail: string;
} {
  const link = location.google;
  if (!link) {
    return {
      connected: false,
      healthy: false,
      expired: false,
      detail: flag("booking.google") ? "Not connected." : "Google Calendar isn't available on this account yet.",
    };
  }
  if (link.expiredAt || !link.sealedToken) {
    return { connected: true, healthy: false, expired: true, detail: GOOGLE_EXPIRED_TEXT };
  }
  if (link.misconfiguredAt) return { connected: true, healthy: false, expired: false, detail: GOOGLE_MISCONFIGURED_TEXT };
  if (link.lastError) return { connected: true, healthy: false, expired: false, detail: link.lastError };
  const where = link.calendarName ? ` to ${link.calendarName}` : "";
  return {
    connected: true,
    healthy: true,
    expired: false,
    detail: link.lastSyncedAt
      ? `Connected${where}. Last wrote ${new Date(link.lastSyncedAt).toLocaleString()}`
      : `Connected${where}. Nothing written yet.`,
  };
}

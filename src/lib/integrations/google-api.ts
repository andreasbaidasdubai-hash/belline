/**
 * The handful of Google calls Belline makes, behind one interface.
 *
 * Kept apart from google.ts so the connection logic (sealed tokens, expiry,
 * fallback to requests) can be tested against a fake with the same shape, and
 * so nothing in a check script can reach Google by accident: the fake in
 * testing/stubs.ts implements this, and the real one is only used when nobody
 * injected anything.
 *
 * Scopes, exactly, and why these two:
 *
 * - `calendar.events` — create and cancel the events Belline books, and list
 *   events on the calendars the owner picked so busy times can be read.
 * - `calendar.calendarlist.readonly` — the names of the owner's calendars, for
 *   the picker. Nothing else about them.
 *
 * Not `calendar.freebusy`: free/busy answers "busy" without saying by what, so
 * Belline's own table bookings would block every other table at the same
 * time. Listing events lets Belline skip its own (tagged with a private
 * property) and anything the owner marked as "free". Not `calendar` either:
 * Belline never changes a calendar's settings or sharing.
 */

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
] as const;

/**
 * The instant (epoch ms) of a local wall-clock time in an IANA zone.
 *
 * Belline stores a booking as a local date and minutes from midnight; Google
 * answers in instants. Two passes of the zone's offset settle the answer,
 * including across a daylight-saving change on the day.
 */
export function zonedInstant(date: string, minutes: number, timeZone: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d, 0, minutes);
  const offset = (at: number) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(at));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - at;
  };
  const first = wall - offset(wall);
  return wall - offset(first);
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const API = "https://www.googleapis.com/calendar/v3";

/** Google no longer accepts the saved connection: revoked, expired or the password changed. */
export class GoogleAuthError extends Error {
  constructor(message = "Google no longer accepts the saved connection.") {
    super(message);
    this.name = "GoogleAuthError";
  }
}

/** Anything else Google refused or failed at. The message is for the log, never a screen. */
export class GoogleApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GoogleApiError";
  }
}

/**
 * Google refuses because of how the Google Cloud project is set up, not
 * because of anything the owner did: the Calendar API is not enabled on the
 * project (403 accessNotConfigured / SERVICE_DISABLED), or the client id,
 * secret or redirect address are not the ones Google has (invalid_client,
 * unauthorized_client, redirect_uri_mismatch). Only Belline can fix these;
 * reconnecting does not help.
 */
export class GoogleConfigError extends Error {
  constructor(
    readonly reason: "api_disabled" | "client",
    message: string,
  ) {
    super(message);
    this.name = "GoogleConfigError";
  }
}

/** The permissions a working connection needs. Google lets an owner untick either on its screen. */
export function missingScopes(granted: string): string[] {
  const have = new Set(granted.split(/\s+/).filter(Boolean));
  return GOOGLE_SCOPES.filter((s) => !have.has(s));
}

/**
 * Turn a Calendar API failure into the error Belline acts on. Exported for the
 * tests, which feed it the bodies Google actually sends.
 */
export function googleFailure(status: number, text: string, what: string): Error {
  let reasons: string[] = [];
  let message = "";
  try {
    const data = JSON.parse(text) as {
      error?: { message?: string; status?: string; errors?: { reason?: string }[]; details?: { reason?: string }[] };
    };
    message = data.error?.message ?? "";
    reasons = [
      ...(data.error?.errors ?? []).map((e) => e.reason ?? ""),
      ...(data.error?.details ?? []).map((d) => d.reason ?? ""),
    ];
  } catch {
    message = text;
  }
  const short = `${what}: ${status} ${reasons.filter(Boolean).join(",")} ${message}`.slice(0, 300);
  if (status === 401) return new GoogleAuthError(short);
  if (status === 403) {
    if (reasons.some((r) => r === "accessNotConfigured" || r === "SERVICE_DISABLED") || /has not been used in project|it is disabled/i.test(message)) {
      return new GoogleConfigError("api_disabled", short);
    }
    // The owner unticked a permission on Google's screen, or withdrew it since:
    // only reconnecting fixes it, the same as a revoked token.
    if (reasons.some((r) => r === "insufficientPermissions" || r === "ACCESS_TOKEN_SCOPE_INSUFFICIENT")) {
      return new GoogleAuthError(short);
    }
  }
  return new GoogleApiError(status, short);
}

/** The token endpoint's `error` codes that mean the project, not the owner. */
const CLIENT_ERRORS = new Set(["invalid_client", "unauthorized_client", "redirect_uri_mismatch"]);

export interface GoogleCalendarEntry {
  id: string;
  name: string;
  primary: boolean;
}

/** An event reduced to what availability needs. Times are RFC 3339 instants. */
export interface GoogleBusyEvent {
  id: string;
  start: string;
  end: string;
  /** "Show me as free" in Google. Never blocks a time. */
  transparent?: boolean;
  /** Set on events Belline wrote. Belline's own diary already counts those. */
  bellineBookingId?: string;
}

export interface GoogleEvent {
  id: string;
  summary: string;
  description: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  status: "confirmed" | "cancelled";
  extendedProperties: { private: { bellineBookingId: string } };
}

export interface GoogleApi {
  /** Finish OAuth. Throws when Google returns no refresh token. */
  exchangeCode(code: string, redirectUri: string): Promise<{ refreshToken: string; scope: string }>;
  /** Throws GoogleAuthError when the refresh token is no longer good. */
  accessToken(refreshToken: string): Promise<string>;
  listCalendars(token: string): Promise<GoogleCalendarEntry[]>;
  listEvents(token: string, calendarId: string, timeMin: string, timeMax: string): Promise<GoogleBusyEvent[]>;
  /** Create with a caller-chosen id. An id that already exists is not an error: `created` is false. */
  insertEvent(token: string, calendarId: string, event: GoogleEvent): Promise<{ id: string; created: boolean }>;
  /** Create or replace by id. */
  putEvent(token: string, calendarId: string, event: GoogleEvent): Promise<void>;
  /** An event already gone counts as cancelled. */
  cancelEvent(token: string, calendarId: string, eventId: string): Promise<void>;
  revoke(refreshToken: string): Promise<void>;
}

function clientId(): string {
  return process.env.GOOGLE_CLIENT_ID ?? "";
}
function clientSecret(): string {
  return process.env.GOOGLE_CLIENT_SECRET ?? "";
}

async function body(res: Response): Promise<string> {
  return (await res.text().catch(() => "")).slice(0, 300);
}

async function call(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (res.status === 401 || res.status === 403) throw googleFailure(res.status, await body(res), path.split("?")[0]);
  return res;
}

/** The real thing. Only reached when nothing was injected and stubs are off. */
export const liveGoogleApi: GoogleApi = {
  async exchangeCode(code, redirectUri) {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId(),
        client_secret: clientSecret(),
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    const data = (await res.json().catch(() => ({}))) as { refresh_token?: string; scope?: string; error?: string };
    if (data.error && CLIENT_ERRORS.has(data.error)) throw new GoogleConfigError("client", `token exchange: ${data.error}`);
    if (!res.ok || !data.refresh_token) {
      throw new GoogleApiError(res.status, `token exchange: ${data.error ?? "no refresh token returned"}`);
    }
    return { refreshToken: data.refresh_token, scope: data.scope ?? "" };
  },

  async accessToken(refreshToken) {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: clientId(),
        client_secret: clientSecret(),
        grant_type: "refresh_token",
      }),
    });
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
    if (data.error && CLIENT_ERRORS.has(data.error)) throw new GoogleConfigError("client", `refresh: ${data.error}`);
    if (data.error === "invalid_grant" || res.status === 401) throw new GoogleAuthError(`refresh: ${data.error ?? res.status}`);
    if (!res.ok || !data.access_token) throw new GoogleApiError(res.status, `refresh: ${data.error ?? "no access token"}`);
    return data.access_token;
  },

  async listCalendars(token) {
    const res = await call(token, "/users/me/calendarList?minAccessRole=writer&fields=items(id,summary,primary)");
    if (!res.ok) throw googleFailure(res.status, await body(res), "calendarList");
    const data = (await res.json()) as { items?: { id: string; summary?: string; primary?: boolean }[] };
    return (data.items ?? []).map((c) => ({ id: c.id, name: c.summary ?? c.id, primary: Boolean(c.primary) }));
  },

  async listEvents(token, calendarId, timeMin, timeMax) {
    const params = new URLSearchParams({
      timeMin,
      timeMax,
      singleEvents: "true",
      maxResults: "250",
      fields: "items(id,status,transparency,start,end,extendedProperties)",
    });
    const res = await call(token, `/calendars/${encodeURIComponent(calendarId)}/events?${params}`);
    if (!res.ok) throw googleFailure(res.status, await body(res), "events.list");
    type Item = {
      id: string;
      status?: string;
      transparency?: string;
      start?: { dateTime?: string; date?: string };
      end?: { dateTime?: string; date?: string };
      extendedProperties?: { private?: { bellineBookingId?: string } };
    };
    const data = (await res.json()) as { items?: Item[] };
    return (data.items ?? [])
      .filter((e) => e.status !== "cancelled")
      .map((e) => ({
        id: e.id,
        // An all-day event has a date and no time: busy from its first midnight
        // to its last, in UTC, which errs towards not offering the day.
        start: e.start?.dateTime ?? `${e.start?.date}T00:00:00Z`,
        end: e.end?.dateTime ?? `${e.end?.date}T00:00:00Z`,
        transparent: e.transparency === "transparent",
        bellineBookingId: e.extendedProperties?.private?.bellineBookingId,
      }));
  },

  async insertEvent(token, calendarId, event) {
    const res = await call(token, `/calendars/${encodeURIComponent(calendarId)}/events`, {
      method: "POST",
      body: JSON.stringify(event),
    });
    // 409: an event with this id exists, which is the idempotency key doing its job.
    if (res.status === 409) return { id: event.id, created: false };
    if (!res.ok) throw googleFailure(res.status, await body(res), "events.insert");
    return { id: event.id, created: true };
  },

  async putEvent(token, calendarId, event) {
    const res = await call(token, `/calendars/${encodeURIComponent(calendarId)}/events/${event.id}`, {
      method: "PUT",
      body: JSON.stringify(event),
    });
    if (res.status === 404) {
      await liveGoogleApi.insertEvent(token, calendarId, event);
      return;
    }
    if (!res.ok) throw googleFailure(res.status, await body(res), "events.update");
  },

  async cancelEvent(token, calendarId, eventId) {
    const res = await call(token, `/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`, { method: "DELETE" });
    if (res.status === 404 || res.status === 410) return;
    if (!res.ok) throw googleFailure(res.status, await body(res), "events.delete");
  },

  async revoke(refreshToken) {
    await fetch(`${REVOKE_URL}?${new URLSearchParams({ token: refreshToken })}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
  },
};

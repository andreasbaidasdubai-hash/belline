import type { Location } from "../types";
import { getLocation, listLocations, upsertLocation } from "../store";
import { credentialsConfigured, openCredentials, sealCredentials } from "../db/credentials";
import { raiseException } from "../errors/customer";
import { openException } from "../exceptions";
import { flag } from "../flags";
import { appOrigin } from "../origin";
import {
  MICROSOFT_AUTHORITY,
  MICROSOFT_SCOPES,
  MicrosoftAuthError,
  MicrosoftConfigError,
  liveMicrosoftApi,
  type MicrosoftApi,
  type OutlookCalendarEntry,
} from "./microsoft-api";
import { signOAuthState, takeExpiredStates, verifyOAuthState, type ReturnTo, type StateCheck } from "./oauth-state";
import { fakeMicrosoftApi } from "../testing/stubs";

/**
 * Outlook: a Microsoft 365 (work or school) or Outlook.com calendar.
 *
 * Built the way Google Calendar is (integrations/google.ts), and shares its
 * pieces: the signed OAuth state (oauth-state.ts), the sealed token
 * (db/credentials.ts), the booking sync with its retries and exceptions
 * (calendar-sync.ts) and the provider that takes busy times out of Belline's
 * own availability (booking/calendar-provider.ts). What is different is
 * Microsoft:
 *
 * - **Refresh tokens rotate.** Every refresh may return a new refresh token.
 *   The old one is not revoked, so two refreshes racing are safe, but a token
 *   is good for 90 days from its own issue and the newest must be kept, or a
 *   venue that books every day would still be cut off three months after it
 *   connected. The new one is sealed and stored as it arrives.
 * - **Tokens idle out.** A refresh token unused for 90 days expires, so the
 *   sweep refreshes a quiet venue's token well before then.
 * - **There is no revoke endpoint** for one refresh token. Disconnecting drops
 *   Belline's sealed copy; the owner removes Belline in their Microsoft account
 *   to withdraw the permission itself, and the page says so.
 * - **Organisations decide who may approve an app.** Belline's app is
 *   multi-tenant and not publisher-verified, and most Microsoft 365
 *   organisations do not let staff approve such an app themselves: the owner
 *   is stopped at "Need admin approval". That is said plainly, the team gets an
 *   exception with the approval link for the IT admin, and the venue takes
 *   requests meanwhile.
 *
 * Two ways to use it, as with Google, chosen by the owner's destination:
 * mirror (destination `belline`, bookings copied out) or two-way (destination
 * `outlook`, flag `booking.outlook`: busy times read back, bookings created in
 * the calendar).
 */

export interface OutlookLink {
  /** The calendar bookings go into, and busy times are read from, for the whole venue. Graph's id. */
  calendarId: string;
  calendarName?: string;
  /** A staff member's own calendar, by staff id: busy there blocks only them. */
  staffCalendars?: Record<string, string>;
  /** The newest refresh token, sealed with CREDENTIALS_KEY. */
  sealedToken?: string;
  /** What Microsoft granted, space-separated as it returned it. */
  scope?: string;
  connectedAt: string;
  connectedBy: string;
  /** When a refresh last succeeded. The sweep keeps a quiet venue's token from idling out. */
  refreshedAt?: string;
  /** Our own sentence for the owner, never Microsoft's text. */
  lastError?: string;
  lastSyncedAt?: string;
  /** Microsoft stopped accepting the connection. The venue takes requests until it is reconnected. */
  expiredAt?: string;
  /** Microsoft refused because of Belline's own app registration. Ours to fix; the sweep checks again. */
  misconfiguredAt?: string;
}

export const OUTLOOK_EXPIRED_TEXT =
  "Outlook stopped letting Belline in, so bookings are taken as requests until you reconnect it.";
export const OUTLOOK_MISCONFIGURED_TEXT =
  "Outlook is connected, but Microsoft is not letting Belline use it yet because of a setting on Belline's side. The Belline team has been told. Bookings are taken as requests until it is fixed; you don't need to do anything.";
export const OUTLOOK_ABANDONED_TEXT =
  "Your last try at connecting Outlook never came back from Microsoft. If Microsoft said you need admin approval, your organisation only lets its IT admin approve apps like Belline: ask your IT admin to approve Belline (the Belline team can send them the link), then connect again. If you simply closed the window, connect again whenever you like.";
export const OUTLOOK_WRITE_FAILED_TEXT =
  "Outlook did not accept the last booking change. The booking is safe in Belline, and Belline keeps trying.";

/** Kept for callers that only ask whether a connection can be offered. */
export function outlookConfigured(): boolean {
  return flag("booking.outlook") && credentialsConfigured();
}

// ---------------------------------------------------------------------------
// Which API
// ---------------------------------------------------------------------------

type AccessHit = { token: string; until: number; sealed: string };

const globalRef = globalThis as unknown as {
  __bellineMicrosoftApi?: MicrosoftApi | null;
  __bellineMicrosoftStub?: ReturnType<typeof fakeMicrosoftApi>;
  __bellineOutlookAccess?: Map<string, AccessHit>;
};

/** Tests inject a fake here. Null puts the default back. */
export function setMicrosoftApi(api: MicrosoftApi | null): void {
  globalRef.__bellineMicrosoftApi = api;
  globalRef.__bellineOutlookAccess?.clear();
}

/** The injected API, the stub under FLAG_STUBS, or Microsoft itself. */
export function microsoftApi(): MicrosoftApi {
  if (globalRef.__bellineMicrosoftApi) return globalRef.__bellineMicrosoftApi;
  if (flag("stubs")) {
    globalRef.__bellineMicrosoftStub ??= fakeMicrosoftApi();
    return globalRef.__bellineMicrosoftStub.api;
  }
  return liveMicrosoftApi;
}

const accessCache = () => (globalRef.__bellineOutlookAccess ??= new Map());

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

export const OUTLOOK_STATE_COOKIE = "belline_outlook_state";
export const OUTLOOK_CALLBACK_PATH = "/api/integrations/microsoft";

export function signOutlookState(input: { locationId: string; userId: string; returnTo: ReturnTo }, now = Date.now()) {
  return signOAuthState("outlook", input, now);
}

export function verifyOutlookState(state: string, opts: { userId: string; cookieNonce?: string; now?: number }): StateCheck {
  return verifyOAuthState("outlook", state, opts);
}

/**
 * Where Microsoft sends the owner to approve.
 *
 * `prompt=select_account` because the commonest wrong turn is the wrong
 * account: an owner signed in to a personal Outlook.com in the same browser as
 * the salon's Microsoft 365 account. `offline_access` in the scopes is what
 * returns a refresh token; Microsoft needs no `prompt=consent` for that.
 *
 * Under stubs there is no Microsoft screen: the URL comes straight back with
 * the stub's code, as if the owner had pressed Accept.
 */
export function outlookAuthUrl(state: string, redirectUri: string): string {
  if (flag("stubs") && !globalRef.__bellineMicrosoftApi) {
    return `${redirectUri}?${new URLSearchParams({ state, code: "stub-code" })}`;
  }
  const params = new URLSearchParams({
    client_id: process.env.MICROSOFT_CLIENT_ID ?? "",
    response_type: "code",
    redirect_uri: redirectUri,
    response_mode: "query",
    scope: MICROSOFT_SCOPES.join(" "),
    prompt: "select_account",
    state,
  });
  return `${MICROSOFT_AUTHORITY}/authorize?${params}`;
}

/**
 * The link an organisation's IT admin opens to approve Belline for everyone
 * there. `organizations` lets Microsoft pick the admin's own tenant. Goes to
 * the team in an exception; never shown on a public page.
 */
export function adminConsentUrl(): string {
  const params = new URLSearchParams({
    client_id: process.env.MICROSOFT_CLIENT_ID ?? "",
    scope: MICROSOFT_SCOPES.filter((s) => s !== "offline_access").map((s) => `https://graph.microsoft.com/${s}`).join(" "),
    redirect_uri: `${appOrigin()}${OUTLOOK_CALLBACK_PATH}`,
  });
  return `https://login.microsoftonline.com/organizations/v2.0/adminconsent?${params}`;
}

export type OutlookOutcome =
  | "connected"
  | "declined"
  | "outlook_unavailable"
  | "outlook_refused"
  | "outlook_failed"
  | "outlook_in_use";

/** Where the owner lands after Microsoft, by where they started. Never Microsoft again. */
export function outlookReturnPath(returnTo: ReturnTo, locationId: string | undefined, outcome: OutlookOutcome): string {
  if (returnTo === "setup") return `/setup/bookings?outlook=${outcome}`;
  const loc = locationId ? `loc=${encodeURIComponent(locationId)}&` : "";
  if (outcome === "connected") return `/integrations?${loc}connected=1`;
  return `/integrations?${loc}error=${outcome === "declined" ? "outlook_declined" : outcome}`;
}

/**
 * Connections started and never finished, once their ten minutes are up.
 *
 * An owner whose organisation needs admin approval is stopped on Microsoft's
 * "Need admin approval" page, and may never press the link that returns to
 * Belline. So this is where most of those show: a start with no return. The
 * venue is marked so the owner sees what to do, and the team gets an exception
 * with the approval link, because closing the window looks the same from here.
 */
export function sweepAbandonedOutlookConnects(now = new Date()): number {
  const gone = takeExpiredStates("outlook", now);
  let raised = 0;
  for (const row of gone) {
    const location = getLocation(row.locationId);
    if (!location) continue;
    if (location.outlook && location.outlook.connectedAt >= row.createdAt && !location.outlook.expiredAt) continue;
    upsertLocation({ ...location, outlookConnectAbandonedAt: row.createdAt });
    console.warn(`[outlook] ${location.name}: a connection started at ${row.createdAt} never came back from Microsoft`);
    openException({
      tenantId: location.tenantId,
      locationId: location.id,
      kind: "outlook_connect_abandoned",
      reason:
        `The owner started connecting Outlook at ${row.createdAt} and never came back from Microsoft. ` +
        "For a work or school account that is usually Microsoft's \"Need admin approval\" page: Belline's app is not publisher-verified, " +
        "and most Microsoft 365 organisations only let an IT admin approve such an app. Ask the owner, and send their IT admin this approval link: " +
        `${adminConsentUrl()} . Once the admin has approved, the owner connects again. It is also what closing the window looks like.`,
      context: { userId: row.userId },
      source: "system",
    });
    raised++;
  }
  return raised;
}

// ---------------------------------------------------------------------------
// The token
// ---------------------------------------------------------------------------

export function sealOutlookToken(refreshToken: string): string {
  return sealCredentials({ refreshToken });
}

function openToken(link: OutlookLink): string {
  if (!link.sealedToken) throw new MicrosoftAuthError("no sealed token on the link");
  return openCredentials(link.sealedToken).refreshToken;
}

/** Calendars.ReadWrite is the one permission the connection cannot work without. */
export function missingOutlookScopes(granted: string): string[] {
  // Microsoft may name a Graph scope bare or as its full URI, and in any case.
  const have = new Set(
    granted
      .split(/\s+/)
      .filter(Boolean)
      .map((s) => s.replace(/^https:\/\/graph\.microsoft\.com\//i, "").toLowerCase()),
  );
  return ["Calendars.ReadWrite"].filter((s) => !have.has(s.toLowerCase()));
}

/** Microsoft granted the connection without calendar access. */
export class OutlookScopeError extends Error {
  constructor(readonly missing: string[]) {
    super(`Microsoft granted the connection without ${missing.join(", ")}`);
    this.name = "OutlookScopeError";
  }
}

/** The account connected has no calendar Belline can add events to. */
export class OutlookNoCalendarError extends Error {
  constructor(message = "the account has no calendar Belline can write to") {
    super(message);
    this.name = "OutlookNoCalendarError";
  }
}

/**
 * Finish OAuth. Returns the venue with the link on it; the caller saves it.
 *
 * The calendars are read with the fresh access token before anything is
 * stored: an account that cannot show Belline a calendar it may write to is
 * refused here rather than connected and then failing on its first booking.
 */
export async function completeOutlookConnection(
  location: Location,
  code: string,
  redirectUri: string,
  userId: string,
  now = new Date(),
): Promise<Location> {
  const api = microsoftApi();
  const tokens = await api.exchangeCode(code, redirectUri);
  const missing = missingOutlookScopes(tokens.scope);
  if (missing.length) throw new OutlookScopeError(missing);
  const calendars = await api.listCalendars(tokens.accessToken);
  if (calendars.length === 0) throw new OutlookNoCalendarError();

  const previous = location.outlook;
  const kept = previous && calendars.find((c) => c.id === previous.calendarId);
  const chosen = kept ?? calendars.find((c) => c.primary) ?? calendars[0];
  const staffCalendars = Object.fromEntries(
    Object.entries(previous?.staffCalendars ?? {}).filter(([, id]) => calendars.some((c) => c.id === id)),
  );
  const sealedToken = sealOutlookToken(tokens.refreshToken);
  accessCache().set(location.id, { token: tokens.accessToken, until: Date.now() + Math.max(60, tokens.expiresIn - 300) * 1000, sealed: sealedToken });
  const { outlookConnectAbandonedAt: _abandoned, ...venue } = location;
  return {
    ...venue,
    outlook: {
      // Reconnecting keeps the calendars the owner already picked, where they still exist.
      calendarId: chosen.id,
      calendarName: chosen.name,
      staffCalendars,
      sealedToken,
      scope: tokens.scope,
      connectedAt: now.toISOString(),
      connectedBy: userId,
      refreshedAt: now.toISOString(),
    },
  };
}

/**
 * A fresh access token, keeping whatever refresh token Microsoft hands back.
 *
 * The refresh token is read from the store, not from the caller's copy of the
 * venue: after a rotation an older copy holds a token that still works but is
 * older than it needs to be. A new refresh token is stored only over the one
 * it replaced — if somebody reconnected in the meantime, theirs stands.
 */
async function refreshAccess(locationId: string, fallback: OutlookLink | undefined, api: MicrosoftApi): Promise<AccessHit> {
  const link = getLocation(locationId)?.outlook ?? fallback;
  if (!link) throw new MicrosoftAuthError("not connected");
  const old = openToken(link);
  const tokens = await api.refresh(old);
  const now = new Date();
  let sealed = link.sealedToken ?? "";
  const fresh = getLocation(locationId);
  const rotated = Boolean(tokens.refreshToken && tokens.refreshToken !== old);
  const stale = !link.refreshedAt || now.getTime() - Date.parse(link.refreshedAt) > 24 * 60 * 60_000;
  if (fresh?.outlook && fresh.outlook.sealedToken === link.sealedToken && (rotated || stale)) {
    if (rotated) sealed = sealOutlookToken(tokens.refreshToken);
    upsertLocation({ ...fresh, outlook: { ...fresh.outlook, sealedToken: sealed, refreshedAt: now.toISOString() } });
  } else if (fresh?.outlook?.sealedToken) {
    sealed = fresh.outlook.sealedToken;
  }
  const hit = { token: tokens.accessToken, until: Date.now() + Math.max(60, tokens.expiresIn - 300) * 1000, sealed };
  accessCache().set(locationId, hit);
  return hit;
}

/**
 * Run `fn` with an access token.
 *
 * A token Microsoft no longer accepts marks the link expired, raises one
 * exception for the team, and rethrows: the caller treats that as "cannot see
 * the calendar", and the next call finds the venue on requests.
 */
export async function withOutlookAccess<T>(location: Location, fn: (token: string, api: MicrosoftApi) => Promise<T>): Promise<T> {
  const api = microsoftApi();
  const cache = accessCache();
  try {
    const stored = getLocation(location.id)?.outlook ?? location.outlook;
    if (!stored) throw new MicrosoftAuthError("not connected");
    let hit = cache.get(location.id);
    if (!hit || hit.until < Date.now() || hit.sealed !== stored.sealedToken) hit = await refreshAccess(location.id, stored, api);
    try {
      return await fn(hit.token, api);
    } catch (err) {
      if (!(err instanceof MicrosoftAuthError)) throw err;
      // The cached token may simply have gone stale: one fresh try.
      cache.delete(location.id);
      const again = await refreshAccess(location.id, stored, api);
      return await fn(again.token, api);
    }
  } catch (err) {
    if (err instanceof MicrosoftAuthError) markOutlookExpired(location.id, err.message);
    if (err instanceof MicrosoftConfigError) markOutlookMisconfigured(location.id, err);
    throw err;
  }
}

export function markOutlookExpired(locationId: string, detail = "", ownerText = OUTLOOK_EXPIRED_TEXT): void {
  accessCache().delete(locationId);
  const location = getLocation(locationId);
  if (!location?.outlook || location.outlook.expiredAt) return;
  upsertLocation({ ...location, outlook: { ...location.outlook, expiredAt: new Date().toISOString(), lastError: ownerText } });
  raiseException(`outlook:expired:${locationId}`, `Microsoft no longer accepts the connection for ${location.name}; bookings fall back to requests. ${detail}`);
  openException({
    tenantId: location.tenantId,
    locationId,
    kind: "outlook_token_expired",
    reason: `Microsoft stopped accepting ${location.name}'s Outlook connection (revoked, idle for 90 days, consent withdrawn or sign-in policy changed). The venue is on requests and the owner has a banner asking them to reconnect. ${detail}`.trim(),
    source: "system",
  });
}

export function markOutlookMisconfigured(locationId: string, err: MicrosoftConfigError): void {
  accessCache().delete(locationId);
  const location = getLocation(locationId);
  if (!location?.outlook || location.outlook.misconfiguredAt) return;
  upsertLocation({ ...location, outlook: { ...location.outlook, misconfiguredAt: new Date().toISOString(), lastError: OUTLOOK_MISCONFIGURED_TEXT } });
  reportOutlookMisconfigured(location, err);
}

/** The team's side of an app-registration problem: a log line and an exception naming the fix. */
export function reportOutlookMisconfigured(location: Location, err: MicrosoftConfigError): void {
  const fix: Record<MicrosoftConfigError["reason"], string> = {
    client:
      "Microsoft does not recognise MICROSOFT_CLIENT_ID. Check it is the Application (client) ID of the Entra app registration, and that its supported account types include other organisations and personal Microsoft accounts.",
    secret:
      "MICROSOFT_CLIENT_SECRET is wrong or has expired. Create a new client secret under Certificates & secrets in the Entra app registration and set its Value (not its Secret ID) in Railway; the sweep clears the venue on its own.",
    redirect: `The redirect address is not registered. Add ${appOrigin()}${OUTLOOK_CALLBACK_PATH} under Authentication, Web, in the Entra app registration.`,
  };
  raiseException(`outlook:misconfigured:${location.id}`, `Microsoft refused ${location.name}'s Outlook because of Belline's app registration (${err.reason}, AADSTS${err.code}): ${err.message}`);
  openException({
    tenantId: location.tenantId,
    locationId: location.id,
    kind: "outlook_misconfigured",
    reason: `Microsoft refused ${location.name}'s Outlook because of Belline's Entra app registration (AADSTS${err.code || "?"}). ${fix[err.reason]}`,
    context: { reason: err.reason, code: err.code },
    source: "system",
  });
}

/** Ask Microsoft again for every venue marked misconfigured, and clear the mark where it now answers. */
export async function recheckOutlookMisconfigured(): Promise<number> {
  if (!flag("booking.outlook")) return 0;
  let cleared = 0;
  for (const location of listLocations({ includeInternal: true })) {
    const link = location.outlook;
    if (!link?.misconfiguredAt || link.expiredAt || !link.sealedToken) continue;
    try {
      const api = microsoftApi();
      const hit = await refreshAccess(location.id, link, api);
      await api.listCalendars(hit.token);
    } catch (err) {
      if (err instanceof MicrosoftAuthError) markOutlookExpired(location.id, err.message);
      continue;
    }
    const fresh = getLocation(location.id);
    if (!fresh?.outlook) continue;
    const { misconfiguredAt: _cleared, ...rest } = fresh.outlook;
    upsertLocation({ ...fresh, outlook: { ...rest, lastError: rest.lastError === OUTLOOK_MISCONFIGURED_TEXT ? undefined : rest.lastError } });
    console.log(`[outlook] ${location.name}: Microsoft answers again; the calendar is back in use`);
    cleared++;
  }
  return cleared;
}

/** What the dashboard shows about the connection. Our sentences only. */
export function outlookConnectionState(location: Location): { connected: boolean; healthy: boolean; expired: boolean; detail: string } {
  const link = location.outlook;
  if (!link) {
    return {
      connected: false,
      healthy: false,
      expired: false,
      detail: flag("booking.outlook") ? "Not connected." : "Outlook isn't available on this account yet.",
    };
  }
  if (link.expiredAt || !link.sealedToken) return { connected: true, healthy: false, expired: true, detail: link.lastError ?? OUTLOOK_EXPIRED_TEXT };
  if (link.misconfiguredAt) return { connected: true, healthy: false, expired: false, detail: OUTLOOK_MISCONFIGURED_TEXT };
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

// ---------------------------------------------------------------------------
// Calendars
// ---------------------------------------------------------------------------

export async function listOutlookCalendarsFor(location: Location): Promise<OutlookCalendarEntry[]> {
  return withOutlookAccess(location, (token, api) => api.listCalendars(token));
}

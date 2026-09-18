import crypto from "node:crypto";
import type { Booking, Location } from "../types";
import { getLocation, listBookings, listLocations, saveBooking, upsertLocation } from "../store";
import { calendlyUsable } from "../booking/destination";
import { credentialsConfigured, openCredentials, sealCredentials } from "../db/credentials";
import { raiseException } from "../errors/customer";
import { openException } from "../exceptions";
import { flag } from "../flags";
import { appOrigin } from "../origin";
import { signOAuthState, takeExpiredStates, verifyOAuthState, type ReturnTo, type StateCheck } from "./oauth-state";
import {
  CALENDLY_AUTH,
  CALENDLY_SCOPES,
  CALENDLY_WEBHOOK_EVENTS,
  CalendlyApiError,
  CalendlyAuthError,
  CalendlyConfigError,
  CalendlyPlanError,
  CalendlyRateLimitError,
  CalendlyTimeTakenError,
  liveCalendlyApi,
  type CalendlyApi,
  type CalendlyEventType,
  type CalendlyInvitee,
  type CalendlySlot,
} from "./calendly-api";
import { fakeCalendlyApi } from "../testing/stubs";

export { calendlyUsable } from "../booking/destination";

/**
 * Calendly: the third calendar, and the one that is not a calendar.
 *
 * Built the way Google Calendar (integrations/google.ts) and Outlook
 * (integrations/outlook.ts) are, and sharing their pieces: the signed OAuth
 * state (oauth-state.ts), the sealed token (db/credentials.ts), the same
 * expired/misconfigured marks, the same fallback to requests, the same
 * exceptions for the team. What is different is Calendly itself, and the
 * difference is not a detail — it decides what Belline may promise.
 *
 * **Google and Outlook hand Belline a diary.** Belline's own rules decide what
 * can be booked, the calendar's busy times take options away, and a booking is
 * an event of any length at any minute.
 *
 * **Calendly hands Belline a booking page.** The owner's *event types* decide
 * everything: each has a fixed length, its own availability, its own buffers
 * and notice, its own daily cap. Belline can ask which times an event type has
 * open and can create an invitee at one of them. It cannot invent a time, a
 * length, or an appointment that is not one of the owner's event types.
 *
 * So there is no mirror mode. A venue on Belline's own diary gains nothing by
 * connecting Calendly, because there is nowhere to copy a booking *to*; the
 * routes refuse it and the page says so. Calendly is a destination or nothing.
 *
 * What Belline can promise through Calendly, and what it cannot, is worked out
 * for a specific account by `calendlyLimits` and shown **at connect time**, on
 * the Calendars page, before the owner chooses it. The list is not decoration:
 *
 * - **A booking needs an email address.** Calendly's `POST /invitees` will not
 *   take a booking without one, and it is the address the confirmation, the
 *   reschedule link and the cancellation link all go to. A caller who will not
 *   give an address cannot be booked into Calendly, so a Calendly venue always
 *   asks for one (`needsGuestEmail` in booking/destination.ts).
 * - **Every service needs an event type.** A service whose length matches no
 *   event type cannot be booked at all. The owner maps them on the Calendars
 *   page, and anything unmapped is named there rather than failing on a call.
 * - **A pooled event type has no named person.** `round_robin` and `collective`
 *   event types let Calendly choose the host, so Belline must not promise a
 *   caller a particular person; `staffSelection` is false for those accounts.
 * - **Bookings are capped by Calendly, not by Belline.** `POST /invitees` is
 *   limited per user: 10 a minute, 50 an hour and 100 a day on a paid
 *   non-enterprise plan, and five a day on a trial. A venue over that is told,
 *   the caller is told, and the team gets an exception.
 * - **A Free Calendly plan cannot take API bookings at all.** It can be
 *   connected and read; it cannot be booked into.
 * - **There is no reschedule.** Calendly has no endpoint that moves a booking,
 *   so a move is a new booking followed by a cancellation of the old one — in
 *   that order, so a failure leaves the guest with the time they already had.
 *   The guest gets two Calendly emails, and it costs two of the daily bookings.
 * - **A reschedule made on Calendly's side is a cancel and a create.** There is
 *   no `invitee.rescheduled` webhook, so Belline matches the pair by hand and
 *   says "cancelled" where it cannot.
 *
 * The refresh token is sealed with CREDENTIALS_KEY before it touches the
 * location record, exactly as Google's and Outlook's are. Calendly rotates it
 * on every refresh, like Microsoft, so the newest is stored as it arrives — and
 * unlike Microsoft, Calendly has a real revoke endpoint, so disconnecting
 * actually withdraws Belline's access rather than only forgetting it.
 */

/** One of the owner's event types, as Belline stores it for the picker. */
export interface CalendlyEventTypeRef {
  uri: string;
  name: string;
  /** Minutes. Calendly's, and not negotiable. */
  duration: number;
  active: boolean;
  /** `solo`, `round_robin`, `collective`. A pool means Calendly picks the host. */
  poolingType?: string;
  schedulingUrl?: string;
}

export interface CalendlyLink {
  /** The connected user, as a URI. Their event types are the ones Belline reads. */
  owner: string;
  ownerName?: string;
  ownerEmail?: string;
  /** Their organisation, as a URI. Webhooks and the booking look-up are scoped to it. */
  organization: string;
  /** Their public booking page, for the connect screen. */
  schedulingUrl?: string;
  /** The Calendly account's own zone. Invitees are created in the venue's, not this. */
  calendlyTimezone?: string;
  /** The newest refresh token, sealed with CREDENTIALS_KEY. */
  sealedToken?: string;
  /** What Calendly granted, space-separated. `default` on an application registered before scopes. */
  scope?: string;
  /** The owner's event types as last read. Refreshed on every visit to the Calendars page. */
  eventTypes?: CalendlyEventTypeRef[];
  eventTypesReadAt?: string;
  /** Which event type each Belline service books. Anything unmapped cannot be booked. */
  serviceEventTypes?: Record<string, string>;
  /** The event type a venue with no services (a restaurant, a one-thing business) books. */
  defaultEventType?: string;
  /** The `invitee.created` / `invitee.canceled` subscription, and its signing key, sealed. */
  webhook?: { uri: string; sealedSigningKey?: string; createdAt: string };
  /** Set when Calendly would not take a webhook subscription: Belline cannot see outside changes. */
  webhookFailedAt?: string;
  connectedAt: string;
  connectedBy: string;
  /** When a refresh last succeeded. Calendly's access token lasts two hours. */
  refreshedAt?: string;
  /** Our own sentence for the owner, never Calendly's text. */
  lastError?: string;
  lastSyncedAt?: string;
  /** Calendly stopped accepting the connection. The venue takes requests until it is reconnected. */
  expiredAt?: string;
  /** Calendly refused because of Belline's own OAuth application. Ours to fix; the sweep checks again. */
  misconfiguredAt?: string;
  /** Calendly refused a booking because of the owner's plan. Only they can change it. */
  planBlockedAt?: string;
}

export const CALENDLY_EXPIRED_TEXT =
  "Calendly stopped letting Belline in, so bookings are taken as requests until you reconnect it.";
export const CALENDLY_MISCONFIGURED_TEXT =
  "Calendly is connected, but Calendly is not letting Belline use it yet because of a setting on Belline's side. The Belline team has been told. Bookings are taken as requests until it is fixed; you don't need to do anything.";
export const CALENDLY_ABANDONED_TEXT =
  "Your last try at connecting Calendly never came back from Calendly. If you simply closed the window, connect again whenever you like. If Calendly said the application is not authorised, tell the Belline team which Calendly account you used.";
export const CALENDLY_PLAN_TEXT =
  "Calendly will not let Belline make bookings on your current Calendly plan. Reading your times works; booking does not. Belline takes booking requests for your team until your Calendly plan includes the scheduling API, and nothing is lost in the meantime.";
export const CALENDLY_RATE_TEXT =
  "Calendly would not take any more bookings today: it limits how many an account can take through an app. Belline is taking booking requests for your team instead, and it will book again when Calendly allows it.";
export const CALENDLY_WRITE_FAILED_TEXT =
  "Calendly did not accept the last booking change. The booking is safe in Belline, and Belline keeps trying.";
export const CALENDLY_NO_EVENT_TYPES_TEXT =
  "That Calendly account has no bookable event types, so there is nothing for Belline to book. Create at least one event type in Calendly — the length of a typical appointment — and connect again.";
export const CALENDLY_DISCONNECTED_TEXT =
  "Disconnected. Belline's access has been withdrawn at Calendly, and the webhook it added has been removed. Bookings already in your Calendly stay there.";
export const CALENDLY_WEBHOOK_FAILED_TEXT =
  "Belline could not subscribe to your Calendly's changes, so a booking cancelled or moved on Calendly's own page will not reach Belline on its own. The times Belline offers still come live from Calendly, so it will not double-book; but a cancellation you make in Calendly should also be made in Belline.";

/** Kept for callers that only ask whether a connection can be offered. */
export function calendlyConfigured(): boolean {
  return flag("booking.calendly") && credentialsConfigured();
}

// ---------------------------------------------------------------------------
// Which API
// ---------------------------------------------------------------------------

type AccessHit = { token: string; until: number; sealed: string };

const globalRef = globalThis as unknown as {
  __bellineCalendlyApi?: CalendlyApi | null;
  __bellineCalendlyStub?: ReturnType<typeof fakeCalendlyApi>;
  __bellineCalendlyAccess?: Map<string, AccessHit>;
};

/** Tests inject a fake here. Null puts the default back. */
export function setCalendlyApi(api: CalendlyApi | null): void {
  globalRef.__bellineCalendlyApi = api;
  globalRef.__bellineCalendlyAccess?.clear();
}

/** The injected API, the stub under FLAG_STUBS, or Calendly itself. */
export function calendlyApi(): CalendlyApi {
  if (globalRef.__bellineCalendlyApi) return globalRef.__bellineCalendlyApi;
  if (flag("stubs")) {
    globalRef.__bellineCalendlyStub ??= fakeCalendlyApi();
    return globalRef.__bellineCalendlyStub.api;
  }
  return liveCalendlyApi;
}

const accessCache = () => (globalRef.__bellineCalendlyAccess ??= new Map());

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

export const CALENDLY_STATE_COOKIE = "belline_calendly_state";
export const CALENDLY_CALLBACK_PATH = "/api/integrations/calendly";
export const CALENDLY_WEBHOOK_PATH = "/api/webhooks/calendly";

export function signCalendlyState(input: { locationId: string; userId: string; returnTo: ReturnTo }, now = Date.now()) {
  return signOAuthState("calendly", input, now);
}

export function verifyCalendlyState(state: string, opts: { userId: string; cookieNonce?: string; now?: number }): StateCheck {
  return verifyOAuthState("calendly", state, opts);
}

/**
 * Where Calendly sends the owner to approve.
 *
 * Calendly's authorize endpoint takes `client_id`, `response_type=code`,
 * `redirect_uri` and, on an application registered with scopes, `scope`. There
 * is no `access_type` or `prompt`: Calendly returns a refresh token every time.
 *
 * Under stubs there is no Calendly screen to visit: the URL comes straight back
 * with the stub's code, as if the owner had pressed Connect.
 */
export function calendlyAuthUrl(state: string, redirectUri: string): string {
  if (flag("stubs") && !globalRef.__bellineCalendlyApi) {
    return `${redirectUri}?${new URLSearchParams({ state, code: "stub-code" })}`;
  }
  const params = new URLSearchParams({
    client_id: process.env.CALENDLY_CLIENT_ID ?? "",
    response_type: "code",
    redirect_uri: redirectUri,
    scope: CALENDLY_SCOPES.join(" "),
    state,
  });
  return `${CALENDLY_AUTH}/oauth/authorize?${params}`;
}

export type CalendlyOutcome =
  | "connected"
  | "declined"
  | "calendly_unavailable"
  | "calendly_refused"
  | "calendly_failed"
  | "calendly_in_use"
  | "calendly_no_event_types";

/** Where the owner lands after Calendly, by where they started. Never Calendly again. */
export function calendlyReturnPath(returnTo: ReturnTo, locationId: string | undefined, outcome: CalendlyOutcome): string {
  if (returnTo === "setup") return `/setup/bookings?calendly=${outcome}`;
  const loc = locationId ? `loc=${encodeURIComponent(locationId)}&` : "";
  if (outcome === "connected") return `/calendars?${loc}connected=1`;
  return `/calendars?${loc}error=${outcome === "declined" ? "calendly_declined" : outcome}`;
}

/** Connections started and never finished, once their ten minutes are up. */
export function sweepAbandonedCalendlyConnects(now = new Date()): number {
  const gone = takeExpiredStates("calendly", now);
  let raised = 0;
  for (const row of gone) {
    const location = getLocation(row.locationId);
    if (!location) continue;
    if (location.calendly && location.calendly.connectedAt >= row.createdAt && !location.calendly.expiredAt) continue;
    upsertLocation({ ...location, calendlyConnectAbandonedAt: row.createdAt });
    console.warn(`[calendly] ${location.name}: a connection started at ${row.createdAt} never came back from Calendly`);
    openException({
      tenantId: location.tenantId,
      locationId: location.id,
      kind: "calendly_connect_abandoned",
      reason:
        `The owner started connecting Calendly at ${row.createdAt} and never came back. ` +
        "Usually they closed the window. It is also what Calendly shows when the OAuth application's redirect address does not match " +
        `the one Belline sent (${appOrigin()}${CALENDLY_CALLBACK_PATH}) — check that on the application in Calendly's developer portal before contacting the owner.`,
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

export function sealCalendlyToken(refreshToken: string): string {
  return sealCredentials({ refreshToken });
}

function openToken(link: CalendlyLink): string {
  if (!link.sealedToken) throw new CalendlyAuthError("no sealed token on the link");
  return openCredentials(link.sealedToken).refreshToken;
}

/**
 * Which of the five scopes Calendly did not grant.
 *
 * `default` is what an application registered before Calendly had scopes is
 * granted, and it covers everything the user can reach, so it satisfies all of
 * them. An application registered with scopes returns them by name.
 */
export function missingCalendlyScopes(granted: string): string[] {
  const have = new Set(granted.split(/\s+/).filter(Boolean).map((s) => s.toLowerCase()));
  if (have.has("default")) return [];
  return CALENDLY_SCOPES.filter((s) => !have.has(s.toLowerCase()));
}

/** Calendly granted the connection without one of the permissions Belline needs. */
export class CalendlyScopeError extends Error {
  constructor(readonly missing: string[]) {
    super(`Calendly granted the connection without ${missing.join(", ")}`);
    this.name = "CalendlyScopeError";
  }
}

/** The account connected has nothing bookable: no active event type at all. */
export class CalendlyNoEventTypesError extends Error {
  constructor(message = "the Calendly account has no active event type") {
    super(message);
    this.name = "CalendlyNoEventTypesError";
  }
}

const asRef = (e: CalendlyEventType): CalendlyEventTypeRef => ({
  uri: e.uri,
  name: e.name,
  duration: e.duration,
  active: e.active,
  poolingType: e.poolingType,
  schedulingUrl: e.schedulingUrl,
});

/**
 * Finish OAuth. Returns the venue with the link on it; the caller saves it.
 *
 * The event types are read with the fresh access token before anything is
 * stored: an account with nothing bookable is refused here rather than
 * connected and then failing on its first call. The webhook is subscribed in
 * the same breath, and a webhook Calendly will not take is recorded rather than
 * pretended — see `CALENDLY_WEBHOOK_FAILED_TEXT`.
 */
export async function completeCalendlyConnection(
  location: Location,
  code: string,
  redirectUri: string,
  userId: string,
  now = new Date(),
): Promise<Location> {
  const api = calendlyApi();
  const tokens = await api.exchangeCode(code, redirectUri);
  const missing = missingCalendlyScopes(tokens.scope);
  if (missing.length) {
    await api.revoke(tokens.refreshToken).catch(() => {});
    throw new CalendlyScopeError(missing);
  }
  const me = await api.me(tokens.accessToken);
  const owner = tokens.owner || me.uri;
  const organization = tokens.organization || me.organization;
  const eventTypes = (await api.listEventTypes(tokens.accessToken, owner)).filter((e) => e.active).map(asRef);
  if (eventTypes.length === 0) throw new CalendlyNoEventTypesError();

  const previous = location.calendly;
  // Reconnecting keeps the service mapping, for event types that still exist.
  const alive = new Set(eventTypes.map((e) => e.uri));
  const serviceEventTypes = Object.fromEntries(
    Object.entries(previous?.serviceEventTypes ?? {}).filter(([, uri]) => alive.has(uri)),
  );
  const defaultEventType =
    previous?.defaultEventType && alive.has(previous.defaultEventType) ? previous.defaultEventType : eventTypes[0].uri;

  const sealedToken = sealCalendlyToken(tokens.refreshToken);
  accessCache().set(location.id, {
    token: tokens.accessToken,
    until: Date.now() + Math.max(60, tokens.expiresIn - 300) * 1000,
    sealed: sealedToken,
  });

  const subscription = await subscribeWebhook(api, tokens.accessToken, { owner, organization }, location, now);

  const { calendlyConnectAbandonedAt: _abandoned, ...venue } = location;
  return {
    ...venue,
    calendly: {
      owner,
      ownerName: me.name || undefined,
      ownerEmail: me.email || undefined,
      organization,
      schedulingUrl: me.schedulingUrl || undefined,
      calendlyTimezone: me.timezone || undefined,
      sealedToken,
      scope: tokens.scope,
      eventTypes,
      eventTypesReadAt: now.toISOString(),
      serviceEventTypes,
      defaultEventType,
      ...subscription,
      connectedAt: now.toISOString(),
      connectedBy: userId,
      refreshedAt: now.toISOString(),
    },
  };
}

/**
 * Subscribe to `invitee.created` and `invitee.canceled` for this account.
 *
 * Belline asks for `organization` scope, so a booking made by anyone in the
 * owner's Calendly organisation is seen, and falls back to `user` scope when
 * Calendly refuses — a member without admin rights may only subscribe to their
 * own. A subscription Calendly will not take at all is recorded as failed, not
 * hidden: `CALENDLY_WEBHOOK_FAILED_TEXT` then says exactly what Belline cannot
 * see, on the Calendars page.
 *
 * The signing key is shown once, on creation, so it is sealed straight away
 * with CREDENTIALS_KEY like every other secret here.
 */
async function subscribeWebhook(
  api: CalendlyApi,
  accessToken: string,
  who: { owner: string; organization: string },
  location: Location,
  now: Date,
): Promise<Pick<CalendlyLink, "webhook" | "webhookFailedAt">> {
  const url = `${appOrigin()}${CALENDLY_WEBHOOK_PATH}/${encodeURIComponent(location.id)}`;
  for (const scope of ["organization", "user"] as const) {
    try {
      // A subscription left behind by an earlier connection would be a second
      // delivery of everything, so it goes before a new one is made.
      const existing = await api.listWebhooks(accessToken, who.organization, scope, who.owner).catch(() => []);
      for (const hook of existing.filter((h) => h.callbackUrl === url)) {
        await api.deleteWebhook(accessToken, hook.uri).catch(() => {});
      }
      const made = await api.createWebhook(accessToken, {
        url,
        events: [...CALENDLY_WEBHOOK_EVENTS],
        organization: who.organization,
        user: who.owner,
        scope,
      });
      return {
        webhook: {
          uri: made.uri,
          sealedSigningKey: made.signingKey ? sealCredentials({ refreshToken: made.signingKey }) : undefined,
          createdAt: now.toISOString(),
        },
      };
    } catch (err) {
      console.warn(`[calendly] ${location.name}: ${scope}-scope webhook refused: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.warn(`[calendly] ${location.name}: no webhook subscription; changes made in Calendly will not reach Belline`);
  return { webhookFailedAt: now.toISOString() };
}

/**
 * A fresh access token, keeping whatever refresh token Calendly hands back.
 *
 * Calendly rotates the refresh token on every refresh, as Microsoft does, so
 * the token is read from the store rather than the caller's copy of the venue,
 * and a new one is stored only over the one it replaced.
 */
async function refreshAccess(locationId: string, fallback: CalendlyLink | undefined, api: CalendlyApi, now = new Date()): Promise<AccessHit> {
  const link = getLocation(locationId)?.calendly ?? fallback;
  if (!link) throw new CalendlyAuthError("not connected");
  const old = openToken(link);
  const tokens = await api.refresh(old);
  let sealed = link.sealedToken ?? "";
  const fresh = getLocation(locationId);
  const rotated = Boolean(tokens.refreshToken && tokens.refreshToken !== old);
  if (fresh?.calendly && fresh.calendly.sealedToken === link.sealedToken) {
    if (rotated) sealed = sealCalendlyToken(tokens.refreshToken);
    upsertLocation({ ...fresh, calendly: { ...fresh.calendly, sealedToken: sealed, refreshedAt: now.toISOString() } });
  } else if (fresh?.calendly?.sealedToken) {
    sealed = fresh.calendly.sealedToken;
  }
  const hit = { token: tokens.accessToken, until: Date.now() + Math.max(60, tokens.expiresIn - 300) * 1000, sealed };
  accessCache().set(locationId, hit);
  return hit;
}

/**
 * Run `fn` with an access token.
 *
 * A token Calendly no longer accepts marks the link expired, raises one
 * exception for the team, and rethrows: the caller treats that as "cannot see
 * the calendar", and the next call finds the venue on requests.
 */
export async function withCalendlyAccess<T>(location: Location, fn: (token: string, api: CalendlyApi, link: CalendlyLink) => Promise<T>): Promise<T> {
  const api = calendlyApi();
  const cache = accessCache();
  try {
    const stored = getLocation(location.id)?.calendly ?? location.calendly;
    if (!stored) throw new CalendlyAuthError("not connected");
    let hit = cache.get(location.id);
    if (!hit || hit.until < Date.now() || hit.sealed !== stored.sealedToken) hit = await refreshAccess(location.id, stored, api);
    try {
      return await fn(hit.token, api, stored);
    } catch (err) {
      if (!(err instanceof CalendlyAuthError)) throw err;
      // The cached token may simply have gone stale: one fresh try.
      cache.delete(location.id);
      const again = await refreshAccess(location.id, stored, api);
      return await fn(again.token, api, stored);
    }
  } catch (err) {
    if (err instanceof CalendlyAuthError) markCalendlyExpired(location.id, err.message);
    if (err instanceof CalendlyConfigError) markCalendlyMisconfigured(location.id, err);
    throw err;
  }
}

export function markCalendlyExpired(locationId: string, detail = "", ownerText = CALENDLY_EXPIRED_TEXT): void {
  accessCache().delete(locationId);
  const location = getLocation(locationId);
  if (!location?.calendly || location.calendly.expiredAt) return;
  upsertLocation({ ...location, calendly: { ...location.calendly, expiredAt: new Date().toISOString(), lastError: ownerText } });
  raiseException(`calendly:expired:${locationId}`, `Calendly no longer accepts the connection for ${location.name}; bookings fall back to requests. ${detail}`);
  openException({
    tenantId: location.tenantId,
    locationId,
    kind: "calendly_token_expired",
    reason: `Calendly stopped accepting ${location.name}'s connection (the owner removed Belline in Calendly's Integrations, or the account changed). The venue is on requests and the owner has a banner asking them to reconnect. ${detail}`.trim(),
    source: "system",
  });
}

export function markCalendlyMisconfigured(locationId: string, err: CalendlyConfigError): void {
  accessCache().delete(locationId);
  const location = getLocation(locationId);
  if (!location?.calendly || location.calendly.misconfiguredAt) return;
  upsertLocation({ ...location, calendly: { ...location.calendly, misconfiguredAt: new Date().toISOString(), lastError: CALENDLY_MISCONFIGURED_TEXT } });
  reportCalendlyMisconfigured(location, err);
}

/** The team's side of an application problem: a log line and an exception naming the fix. */
export function reportCalendlyMisconfigured(location: Location, err: CalendlyConfigError): void {
  const fix: Record<CalendlyConfigError["reason"], string> = {
    client: "Calendly does not recognise CALENDLY_CLIENT_ID. Check it against the OAuth application in Calendly's developer portal (developer.calendly.com, My apps).",
    secret: "CALENDLY_CLIENT_SECRET is wrong. Read it again from the OAuth application in Calendly's developer portal; the secret is shown when the application is created.",
    redirect: `The redirect address is not registered. Add ${appOrigin()}${CALENDLY_CALLBACK_PATH} to the OAuth application's redirect URIs in Calendly's developer portal.`,
    scope: `Calendly refused one of the scopes Belline asks for. The application must be registered with ${CALENDLY_SCOPES.join(", ")}, or with no scopes at all (which grants 'default').`,
  };
  raiseException(`calendly:misconfigured:${location.id}`, `Calendly refused ${location.name} because of Belline's OAuth application (${err.reason}): ${err.message}`);
  openException({
    tenantId: location.tenantId,
    locationId: location.id,
    kind: "calendly_misconfigured",
    reason: `Calendly refused ${location.name} because of Belline's OAuth application (${err.reason}). ${fix[err.reason]}`,
    context: { reason: err.reason },
    source: "system",
  });
}

/**
 * Calendly refused a booking because of the owner's plan. Only they can change
 * it, so it is said to them plainly, the venue goes to requests, and the team
 * is told once so somebody can help rather than wait for a complaint.
 */
export function markCalendlyPlanBlocked(locationId: string, detail = ""): void {
  const location = getLocation(locationId);
  if (!location?.calendly || location.calendly.planBlockedAt) return;
  upsertLocation({ ...location, calendly: { ...location.calendly, planBlockedAt: new Date().toISOString(), lastError: CALENDLY_PLAN_TEXT } });
  openException({
    tenantId: location.tenantId,
    locationId,
    kind: "calendly_plan_blocked",
    reason:
      `Calendly refused a booking for ${location.name} because of the owner's Calendly plan: creating an invitee through the API needs a paid Calendly plan. ` +
      `The venue is on requests and the owner has been told. Contact them about their Calendly subscription. ${detail}`.trim(),
    source: "system",
  });
}

/** Ask Calendly again for every venue marked misconfigured, and clear the mark where it now answers. */
export async function recheckCalendlyMisconfigured(): Promise<number> {
  if (!flag("booking.calendly")) return 0;
  let cleared = 0;
  for (const location of listLocations({ includeInternal: true })) {
    const link = location.calendly;
    if (!link?.misconfiguredAt || link.expiredAt || !link.sealedToken) continue;
    try {
      const api = calendlyApi();
      const hit = await refreshAccess(location.id, link, api);
      await api.me(hit.token);
    } catch (err) {
      if (err instanceof CalendlyAuthError) markCalendlyExpired(location.id, err.message);
      continue;
    }
    const fresh = getLocation(location.id);
    if (!fresh?.calendly) continue;
    const { misconfiguredAt: _cleared, ...rest } = fresh.calendly;
    upsertLocation({ ...fresh, calendly: { ...rest, lastError: rest.lastError === CALENDLY_MISCONFIGURED_TEXT ? undefined : rest.lastError } });
    console.log(`[calendly] ${location.name}: Calendly answers again; the connection is back in use`);
    cleared++;
  }
  return cleared;
}

// ---------------------------------------------------------------------------
// What this account can and cannot do
// ---------------------------------------------------------------------------

/** One thing Belline cannot promise through this Calendly account, in the owner's words. */
export interface CalendlyLimit {
  /** `blocking` stops bookings entirely; `narrowing` only makes them smaller. */
  severity: "blocking" | "narrowing";
  text: string;
}

/**
 * What Belline can and cannot do through *this* Calendly account.
 *
 * Shown on the Calendars page the moment it is connected, and before the owner
 * can choose Calendly as their destination — the point being that a customer's
 * Calendly setup decides what the product can promise, and they must read that
 * at connect time rather than meet it on a call three weeks later.
 */
export function calendlyLimits(location: Location): { ok: boolean; limits: CalendlyLimit[] } {
  const link = location.calendly;
  if (!link) return { ok: false, limits: [{ severity: "blocking", text: "Calendly is not connected." }] };
  const limits: CalendlyLimit[] = [];
  const types = (link.eventTypes ?? []).filter((e) => e.active);

  if (types.length === 0) {
    limits.push({ severity: "blocking", text: CALENDLY_NO_EVENT_TYPES_TEXT });
  }
  if (link.planBlockedAt) {
    limits.push({ severity: "blocking", text: CALENDLY_PLAN_TEXT });
  }

  const services = location.salon?.services ?? [];
  const unmapped = services.filter((s) => !eventTypeUriFor(link, s.id));
  if (services.length > 0 && unmapped.length > 0) {
    limits.push({
      severity: "blocking",
      text:
        `Calendly books its own event types, not free time, so every service needs one. ` +
        `${unmapped.map((s) => s.name).join(", ")} ${unmapped.length === 1 ? "has" : "have"} no Calendly event type yet, ` +
        "so Belline cannot book " + (unmapped.length === 1 ? "it" : "them") + ". Choose one for each below, or add a matching event type in Calendly.",
    });
  }
  // A mapping whose lengths disagree is not wrong, but the customer is told the
  // Calendly length, because that is the one they will actually get.
  for (const service of services) {
    const uri = eventTypeUriFor(link, service.id);
    const type = types.find((t) => t.uri === uri);
    if (!type || type.duration === service.durationMin) continue;
    limits.push({
      severity: "narrowing",
      text: `${service.name} is ${service.durationMin} minutes in Belline but its Calendly event type "${type.name}" is ${type.duration}. Calendly's length is the one the customer gets.`,
    });
  }

  const used = new Set(
    services.length > 0 ? services.map((s) => eventTypeUriFor(link, s.id)).filter(Boolean) : [link.defaultEventType].filter(Boolean),
  );
  const pooled = types.filter((t) => used.has(t.uri) && t.poolingType && t.poolingType !== "solo");
  if (pooled.length > 0) {
    limits.push({
      severity: "narrowing",
      text:
        `${pooled.map((t) => `"${t.name}"`).join(", ")} ${pooled.length === 1 ? "is a shared event type" : "are shared event types"} in Calendly, ` +
        "so Calendly chooses who takes the appointment. Belline will not promise a customer a particular person for " +
        (pooled.length === 1 ? "it" : "them") + ".",
    });
  }

  limits.push({
    severity: "narrowing",
    text: "Calendly needs an email address for every booking, so Belline always asks for one and reads it back. A customer who will not give an address is taken as a request for your team.",
  });
  limits.push({
    severity: "narrowing",
    text: "Calendly has no way to move a booking, so Belline moves one by making the new time and then cancelling the old. The customer gets two emails from Calendly.",
  });
  limits.push({
    severity: "narrowing",
    text: "Calendly limits how many bookings an app may make for your account — about a hundred a day on a paid plan. Past that Belline takes requests for your team until the next day, and tells you.",
  });
  // A subscription Calendly refused, or one Belline cannot check the signature
  // of, comes to the same thing for the owner: a change made in Calendly will
  // not reach Belline on its own. Said once, in their words.
  if (link.webhookFailedAt || !calendlyWebhookReadable(location)) {
    limits.push({ severity: "narrowing", text: CALENDLY_WEBHOOK_FAILED_TEXT });
  }

  return { ok: !limits.some((l) => l.severity === "blocking"), limits };
}

/** The event type this service books, or the venue's default where it has no services. */
export function eventTypeUriFor(link: CalendlyLink, serviceId?: string): string | undefined {
  if (serviceId && link.serviceEventTypes?.[serviceId]) return link.serviceEventTypes[serviceId];
  if (serviceId) return undefined;
  return link.defaultEventType;
}

/** The event type a booking of these services would use, or null when there is no one answer. */
export function eventTypeForServices(link: CalendlyLink, serviceIds?: readonly string[]): CalendlyEventTypeRef | null {
  const types = link.eventTypes ?? [];
  const ids = serviceIds?.filter(Boolean) ?? [];
  // Calendly books one event type at a time. Two services in one appointment
  // is not something Calendly can express, so it is refused rather than
  // half-booked; the caller is told and the team takes it as a request.
  if (ids.length > 1) return null;
  const uri = eventTypeUriFor(link, ids[0]);
  return types.find((t) => t.uri === uri && t.active) ?? null;
}

/** Can a caller ask for a particular person? Only where every event type in use is solo. */
export function calendlyStaffSelection(location: Location): boolean {
  const link = location.calendly;
  if (!link) return false;
  const types = link.eventTypes ?? [];
  const used = new Set(
    (location.salon?.services ?? []).map((s) => eventTypeUriFor(link, s.id)).filter(Boolean as unknown as (v: string | undefined) => v is string),
  );
  if (used.size === 0 && link.defaultEventType) used.add(link.defaultEventType);
  if (used.size === 0) return false;
  return [...used].every((uri) => {
    const type = types.find((t) => t.uri === uri);
    return Boolean(type && (!type.poolingType || type.poolingType === "solo"));
  });
}

/** Save the owner's picks, checked against the event types their account actually has. */
export function chooseCalendlyEventTypes(
  location: Location,
  input: { defaultEventType?: string; serviceEventTypes?: Record<string, string> },
): { ok: true; location: Location } | { ok: false; error: string } {
  const link = location.calendly;
  if (!link) return { ok: false, error: "Connect Calendly first." };
  const byUri = new Map((link.eventTypes ?? []).filter((e) => e.active).map((e) => [e.uri, e]));
  const serviceIds = new Set((location.salon?.services ?? []).map((s) => s.id));
  const serviceEventTypes: Record<string, string> = {};
  for (const [serviceId, uri] of Object.entries(input.serviceEventTypes ?? {})) {
    if (!uri) continue;
    if (!serviceIds.has(serviceId)) return { ok: false, error: "That service is not on your list." };
    if (!byUri.has(uri)) return { ok: false, error: "One of those is not a bookable event type in your Calendly." };
    serviceEventTypes[serviceId] = uri;
  }
  const defaultEventType = input.defaultEventType || link.defaultEventType;
  if (defaultEventType && !byUri.has(defaultEventType)) {
    return { ok: false, error: "That is not a bookable event type in your Calendly." };
  }
  return { ok: true, location: { ...location, calendly: { ...link, serviceEventTypes, defaultEventType } } };
}

/** Read the owner's event types again and store them. Run whenever the Calendars page loads. */
export async function refreshCalendlyEventTypes(location: Location, now = new Date()): Promise<Location> {
  const types = await withCalendlyAccess(location, (token, api, link) => api.listEventTypes(token, link.owner));
  const active = types.filter((t) => t.active).map(asRef);
  const fresh = getLocation(location.id);
  if (!fresh?.calendly) return location;
  const alive = new Set(active.map((t) => t.uri));
  return upsertLocation({
    ...fresh,
    calendly: {
      ...fresh.calendly,
      eventTypes: active,
      eventTypesReadAt: now.toISOString(),
      serviceEventTypes: Object.fromEntries(Object.entries(fresh.calendly.serviceEventTypes ?? {}).filter(([, uri]) => alive.has(uri))),
      defaultEventType:
        fresh.calendly.defaultEventType && alive.has(fresh.calendly.defaultEventType) ? fresh.calendly.defaultEventType : active[0]?.uri,
    },
  });
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/**
 * The times Calendly has open for this event type between two instants.
 *
 * These are not "busy times taken away from Belline's rules", as Google's and
 * Outlook's are. They are Calendly's own answer, already accounting for the
 * owner's linked calendars, their buffers, their minimum notice and their daily
 * caps — which is better than anything Belline could work out, and the reason
 * this adapter reads them rather than reconstructing them.
 *
 * Calendly refuses a window longer than seven days or starting in the past, so
 * a window that has already begun is moved to now; a window wholly in the past
 * has nothing open and is answered without asking.
 */
export async function calendlyOpenTimes(location: Location, eventTypeUri: string, from: Date, to: Date, now = new Date()): Promise<CalendlySlot[]> {
  const start = from.getTime() <= now.getTime() ? new Date(now.getTime() + 60_000) : from;
  if (start.getTime() >= to.getTime()) return [];
  return withCalendlyAccess(location, (token, api) => api.availableTimes(token, eventTypeUri, start.toISOString(), to.toISOString()));
}

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------

/**
 * Book somebody into Calendly, once.
 *
 * Calendly has no idempotency key on `POST /invitees`, so the same booking
 * arriving twice would be two invitees and two confirmation emails. The look-up
 * before the create is the idempotency: an invitee with this email on this
 * event at this instant is this booking, whoever made it.
 *
 * The look-up is done again when the create itself fails in a way that could
 * have landed — a timeout, a 5xx — because a create whose answer was lost is
 * indistinguishable from one that never happened, and only Calendly knows.
 */
export async function bookCalendlyInvitee(
  location: Location,
  input: { eventType: string; startTime: string; name: string; email: string; timezone: string; phone?: string },
): Promise<CalendlyInvitee> {
  return withCalendlyAccess(location, async (token, api, link) => {
    const already = await api
      .findInvitee(token, { organization: link.organization, email: input.email, startTime: input.startTime })
      .catch(() => null);
    if (already) return already;
    try {
      return await api.createInvitee(token, {
        eventType: input.eventType,
        startTime: input.startTime,
        name: input.name,
        email: input.email,
        timezone: input.timezone,
        textReminderNumber: input.phone,
      });
    } catch (err) {
      if (err instanceof CalendlyTimeTakenError || err instanceof CalendlyPlanError || err instanceof CalendlyRateLimitError) throw err;
      // It may have landed with only the answer lost. Ask Calendly.
      const found = await api
        .findInvitee(token, { organization: link.organization, email: input.email, startTime: input.startTime })
        .catch(() => null);
      if (found) return found;
      throw err;
    }
  });
}

/** Cancel the Calendly event behind a booking. Already gone counts as cancelled. */
export async function cancelCalendlyEvent(location: Location, eventUri: string, reason: string): Promise<void> {
  await withCalendlyAccess(location, (token, api) => api.cancelEvent(token, eventUri, reason));
}

/** A write Calendly refused: the owner sees our sentence on the connection, the log gets Calendly's. */
export function noteCalendlyWriteFailure(locationId: string, raw: unknown, ownerText = CALENDLY_WRITE_FAILED_TEXT): void {
  const location = getLocation(locationId);
  if (!location?.calendly) return;
  if (location.calendly.lastError !== ownerText) {
    upsertLocation({ ...location, calendly: { ...location.calendly, lastError: ownerText } });
  }
  console.warn(`[calendly] ${location.name}: ${raw instanceof Error ? raw.message : String(raw)}`);
}

/** A write Calendly accepted. The warning goes only when nothing else at the venue is still failing. */
export function noteCalendlyWriteSuccess(locationId: string, stillFailing: boolean, now = new Date()): void {
  const location = getLocation(locationId);
  if (!location?.calendly) return;
  const clear = location.calendly.lastError === CALENDLY_WRITE_FAILED_TEXT && !stillFailing;
  upsertLocation({ ...location, calendly: { ...location.calendly, lastSyncedAt: now.toISOString(), ...(clear ? { lastError: undefined } : {}) } });
}

/**
 * A booking whose Calendly side did not happen, and must.
 *
 * Only cancellations land here. A *booking* that Calendly refuses is refused to
 * the caller at the time — no time was promised, so there is nothing to retry —
 * but a cancellation is different: the guest has already been told the
 * appointment is gone, and an event left standing in Calendly means the owner
 * keeps a slot for somebody who is not coming. So the booking keeps a mark, the
 * sweep retries it with the same back-off the calendars use, and a second
 * failure opens `calendly_cancel_failed` for the team.
 */
const BACKOFF_MIN = [1, 5, 15, 60, 180, 360];
/** A second failure in a row is the team's to look at; the first may be a blip. */
export const CALENDLY_EXCEPTION_AFTER = 2;

export function markCalendlyCancelPending(booking: Booking, now = new Date()): Booking {
  const sync = booking.calendarSync;
  const attempts = (sync?.provider === "calendly" ? sync.attempts : 0) + 1;
  const wait = BACKOFF_MIN[Math.min(attempts, BACKOFF_MIN.length) - 1];
  return saveBooking({
    ...booking,
    calendarSync: {
      state: "failed",
      provider: "calendly",
      attempts,
      lastError: "Calendly has not taken this cancellation yet. Belline tries again on its own.",
      lastTriedAt: now.toISOString(),
      nextAttemptAt: new Date(now.getTime() + wait * 60_000).toISOString(),
    },
  });
}

/**
 * Every cancellation Calendly has not taken yet, whose back-off has passed.
 * Run from the sweep beside the calendars' own retries.
 */
export async function retryCalendlyCancellations(now = new Date()): Promise<{ attempted: number; done: number; failed: number }> {
  const out = { attempted: 0, done: 0, failed: 0 };
  if (!flag("booking.calendly")) return out;
  const due = listBookings().filter((b) => {
    const s = b.calendarSync;
    if (s?.provider !== "calendly" || s.state === "synced") return false;
    return !s.nextAttemptAt || Date.parse(s.nextAttemptAt) <= now.getTime();
  });
  for (const booking of due) {
    const location = getLocation(booking.locationId);
    const eventUri = booking.calendarEventId;
    if (!location?.calendly || !eventUri) {
      const { calendarSync: _gone, ...rest } = booking;
      saveBooking(rest);
      continue;
    }
    if (!calendlyUsable(location)) continue;
    out.attempted++;
    try {
      await cancelCalendlyEvent(location, eventUri, booking.cancelReason ?? "Cancelled in Belline");
      saveBooking({ ...booking, calendarSync: { state: "synced", provider: "calendly", attempts: 0, syncedAt: now.toISOString() } });
      noteCalendlyWriteSuccess(location.id, false, now);
      out.done++;
    } catch (err) {
      const saved = markCalendlyCancelPending(booking, now);
      const attempts = saved.calendarSync?.attempts ?? 1;
      noteCalendlyWriteFailure(location.id, err);
      out.failed++;
      if (attempts >= CALENDLY_EXCEPTION_AFTER) {
        openException({
          tenantId: location.tenantId,
          locationId: location.id,
          kind: "calendly_cancel_failed",
          reason:
            `Booking ${booking.ref} was cancelled in Belline and the customer told, but Calendly has refused the cancellation ${attempts} times. ` +
            `The slot is still held in the owner's Calendly. Cancel it there by hand if this does not clear. Latest: ${err instanceof Error ? err.message : String(err)}`,
          context: { bookingId: booking.id },
          source: "system",
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/**
 * Is this the signature Calendly would have sent for this body?
 *
 * `Calendly-Webhook-Signature: t=<unix>,v1=<hex>`, where v1 is HMAC-SHA256 of
 * `<t>.<body>` under the subscription's signing key. The timestamp is checked
 * as well, so a payload somebody kept a copy of cannot be replayed later.
 */
export const WEBHOOK_TOLERANCE_SEC = 180;

export function verifyCalendlySignature(header: string | null, rawBody: string, signingKey: string, now = Date.now()): boolean {
  if (!header || !signingKey) return false;
  const parts = Object.fromEntries(
    header
      .split(",")
      .map((p) => p.trim().split("="))
      .filter((p) => p.length === 2) as [string, string][],
  );
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1 || !/^\d+$/.test(t)) return false;
  if (Math.abs(now / 1000 - Number(t)) > WEBHOOK_TOLERANCE_SEC) return false;
  const expected = crypto.createHmac("sha256", signingKey).update(`${t}.${rawBody}`).digest("hex");
  const given = Buffer.from(v1, "hex");
  const want = Buffer.from(expected, "hex");
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

/**
 * The signing key to check this venue's deliveries against, or null when
 * Belline holds none and must refuse them.
 *
 * Calendly issues a webhook signing key **per OAuth application**, shown once
 * when the application is created in the developer portal and never again, so
 * for most deployments it is an environment variable
 * (`CALENDLY_WEBHOOK_SIGNING_KEY`) rather than something the connect flow can
 * learn. Where a `POST /webhook_subscriptions` does hand one back, that one is
 * this subscription's and is preferred: it is narrower.
 *
 * With neither, every delivery is refused. An unsigned cancellation is a
 * request from anybody who can guess a URL, and the page says plainly what
 * Belline then cannot see rather than quietly trusting it.
 */
export function calendlySigningKey(location: Location, env: Record<string, string | undefined> = process.env): string | null {
  const sealed = location.calendly?.webhook?.sealedSigningKey;
  if (sealed) {
    try {
      return openCredentials(sealed).refreshToken;
    } catch {
      // Sealed with a key this deployment no longer has: fall through.
    }
  }
  return (env.CALENDLY_WEBHOOK_SIGNING_KEY ?? "").trim() || null;
}

/** Can Belline check a delivery for this venue at all? */
export function calendlyWebhookReadable(location: Location, env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(location.calendly?.webhook && calendlySigningKey(location, env));
}

export interface CalendlyWebhookPayload {
  event?: string;
  payload?: {
    uri?: string;
    email?: string;
    name?: string;
    status?: string;
    cancel_url?: string;
    reschedule_url?: string;
    /** Calendly sets these on the *new* invitee of a reschedule. */
    rescheduled?: boolean;
    old_invitee?: string;
    new_invitee?: string;
    scheduled_event?: { uri?: string; start_time?: string; end_time?: string; status?: string };
  };
}

export type WebhookOutcome =
  | { applied: "cancelled"; bookingId: string }
  | { applied: "rescheduled_elsewhere"; bookingId: string }
  | { applied: "unknown_booking" }
  | { applied: "ignored"; why: string };

/**
 * What a `invitee.created` or `invitee.canceled` from Calendly means for
 * Belline's own record.
 *
 * `invitee.canceled` is the one that matters: a customer who cancels on
 * Calendly's page, or an owner who cancels in Calendly, must not still be
 * expected in Belline. The booking is found by the Calendly event URI Belline
 * stored when it made it, and cancelled here too.
 *
 * `invitee.created` is mostly Belline's own booking coming back, and is
 * ignored. The one case it is not ignored is a **reschedule**: Calendly has no
 * `invitee.rescheduled` event, so a move made on Calendly's side arrives as a
 * cancellation of the old invitee followed by a creation carrying
 * `rescheduled: true` and `old_invitee`. Belline cannot move its own booking
 * from that — the new invitee's event is a different event, at a time Belline's
 * rules never approved — so it records the new time on the booking's notes and
 * leaves it cancelled, and the dashboard says so. Pretending the booking moved
 * would be worse than saying plainly that it did not.
 */
export function applyCalendlyWebhook(location: Location, body: CalendlyWebhookPayload, now = new Date()): WebhookOutcome {
  const kind = body.event ?? "";
  const eventUri = body.payload?.scheduled_event?.uri ?? "";
  if (kind !== "invitee.canceled" && kind !== "invitee.created") return { applied: "ignored", why: `not a subscribed event: ${kind.slice(0, 40)}` };
  if (!eventUri) return { applied: "ignored", why: "no scheduled event on the payload" };

  const booking = listBookings({ locationId: location.id }).find((b) => b.calendarEventId === eventUri);

  if (kind === "invitee.created") {
    // Belline's own booking arriving back, or somebody booking the owner's
    // public Calendly page — which Belline has no record of and does not
    // invent one for. Only a reschedule of a booking Belline made is news.
    const old = body.payload?.old_invitee;
    if (!body.payload?.rescheduled || !old) return { applied: "ignored", why: "a booking Belline did not make" };
    const moved = listBookings({ locationId: location.id }).find((b) => b.calendlyInvitee === old);
    if (!moved) return { applied: "unknown_booking" };
    const at = body.payload?.scheduled_event?.start_time ?? "";
    saveBooking({
      ...moved,
      notes: [moved.notes, `Moved in Calendly to ${at || "another time"}. Belline's record was cancelled; the customer has Calendly's confirmation.`]
        .filter(Boolean)
        .join(" — ")
        .slice(0, 1000),
    });
    console.warn(`[calendly] ${location.name}: booking ${moved.ref} was moved on Calendly's side to ${at}; Belline cannot follow it`);
    return { applied: "rescheduled_elsewhere", bookingId: moved.id };
  }

  if (!booking) return { applied: "unknown_booking" };
  if (booking.status === "cancelled") return { applied: "ignored", why: "already cancelled in Belline" };
  saveBooking({
    ...booking,
    status: "cancelled",
    cancelledAt: now.toISOString(),
    cancelReason: "Cancelled in Calendly",
    // The Calendly side is already gone; nothing to retry.
    calendarSync: { state: "synced", provider: "calendly", attempts: 0, syncedAt: now.toISOString() },
  });
  console.log(`[calendly] ${location.name}: booking ${booking.ref} was cancelled in Calendly`);
  return { applied: "cancelled", bookingId: booking.id };
}

// ---------------------------------------------------------------------------
// The dashboard, and disconnecting
// ---------------------------------------------------------------------------

/** What the dashboard shows about the connection. Our sentences only. */
export function calendlyConnectionState(location: Location): { connected: boolean; healthy: boolean; expired: boolean; detail: string } {
  const link = location.calendly;
  if (!link) {
    return {
      connected: false,
      healthy: false,
      expired: false,
      detail: flag("booking.calendly") ? "Not connected." : "Calendly isn't available on this account yet.",
    };
  }
  if (link.expiredAt || !link.sealedToken) return { connected: true, healthy: false, expired: true, detail: link.lastError ?? CALENDLY_EXPIRED_TEXT };
  if (link.misconfiguredAt) return { connected: true, healthy: false, expired: false, detail: CALENDLY_MISCONFIGURED_TEXT };
  if (link.planBlockedAt) return { connected: true, healthy: false, expired: false, detail: CALENDLY_PLAN_TEXT };
  if (link.lastError) return { connected: true, healthy: false, expired: false, detail: link.lastError };
  const who = link.ownerName ? ` as ${link.ownerName}` : "";
  return {
    connected: true,
    healthy: true,
    expired: false,
    detail: link.lastSyncedAt
      ? `Connected${who}. Last booked ${new Date(link.lastSyncedAt).toLocaleString()}`
      : `Connected${who}. Nothing booked yet.`,
  };
}

/**
 * Disconnect: withdraw Belline's access at Calendly, remove the webhook it
 * added, drop the sealed token and the link, and send a venue that booked into
 * Calendly back to requests. Unlike Microsoft, Calendly has a revoke endpoint,
 * so this really does end the access rather than only forgetting it. Bookings
 * already in the owner's Calendly stay: they are the venue's.
 */
export async function disconnectCalendly(location: Location, now = new Date()): Promise<Location> {
  const link = location.calendly;
  if (link?.sealedToken) {
    try {
      const api = calendlyApi();
      if (link.webhook?.uri) {
        const hit = await refreshAccess(location.id, link, api, now);
        await api.deleteWebhook(hit.token, link.webhook.uri).catch(() => {});
      }
      await api.revoke(openToken(link));
    } catch (err) {
      // The link goes either way; the owner can also remove Belline in their
      // Calendly account, under Integrations.
      console.warn(`[calendly] revoke failed for ${location.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  accessCache().delete(location.id);
  const { calendly: _dropped, calendlyConnectAbandonedAt: _abandoned, ...rest } = location;
  const o = rest.onboarding;
  if (o?.destination?.kind === "calendly") {
    return { ...rest, onboarding: { ...o, destination: { kind: "requests", setAt: now.toISOString() } } };
  }
  return rest;
}

/** Re-exported so callers do not reach past this module into the API layer. */
export { CalendlyApiError, CalendlyAuthError, CalendlyConfigError, CalendlyPlanError, CalendlyRateLimitError, CalendlyTimeTakenError };

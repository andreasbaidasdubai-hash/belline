/**
 * The handful of Calendly calls Belline makes, behind one interface.
 *
 * The third of its kind, after google-api.ts and microsoft-api.ts, and kept
 * apart from calendly.ts for the same reasons: the connection logic (sealed
 * and rotating tokens, expiry, fallback to requests) is tested against a fake
 * with this shape (testing/stubs.ts), and nothing in a check script can reach
 * Calendly by accident.
 *
 * **Calendly is not a calendar.** That one sentence decides the whole adapter.
 * Google and Outlook hand Belline a diary it may read busy times out of and
 * write an event of any length into, at any minute it likes. Calendly hands
 * Belline a *booking page*: a set of **event types**, each with its own fixed
 * duration, its own availability rules, its own buffers and notice, and its own
 * questions. Belline can ask which times an event type has open, and it can
 * create an **invitee** at one of those times. It cannot invent a time, invent
 * a length, or write anything that is not a booking of an event type.
 *
 * So there is no `CalendarConnector` here (calendar-connector.ts). Calendly
 * cannot mirror Belline's own diary — there is nothing to mirror it into — and
 * a venue that keeps its book in Belline gets nothing from connecting it. It is
 * a booking *destination* or it is nothing, and booking/calendly-provider.ts is
 * where that lives.
 *
 * Scopes, exactly, and why these five (developer.calendly.com/scopes):
 *
 * - `event_types:read` — the owner's event types, and the times each has open
 *   (`/event_types`, `/event_type_available_times`). This is the availability.
 * - `availability:read` — the owner's own working hours, so the connect screen
 *   can say what Belline will and will not offer.
 * - `scheduled_events:read` — what is already booked, so a booking whose answer
 *   was lost is found again rather than made twice. Calendly has no idempotency
 *   key on a create; this read is the idempotency.
 * - `scheduled_events:write` — create the invitee, and cancel it.
 * - `webhooks:write` — subscribe to `invitee.created` and `invitee.canceled`,
 *   so a customer who cancels on Calendly's own page is not still expected.
 *
 * Not `event_types:write`: Belline never creates or edits the owner's event
 * types. Their booking page is theirs, and an adapter that quietly rewrote it
 * would be the worst kind of surprise. Not `scheduling_links:write` or
 * `shares:write` either: a single-use link is something a human clicks, and a
 * caller on the phone cannot.
 *
 * An older Calendly OAuth application, registered before scopes existed, is
 * granted `default` — full access to everything the user can reach. Belline
 * asks for the five by name anyway, and `missingCalendlyScopes` accepts
 * `default` as covering them, so the same code works on either registration.
 */

export const CALENDLY_SCOPES = [
  "event_types:read",
  "availability:read",
  "scheduled_events:read",
  "scheduled_events:write",
  "webhooks:write",
] as const;

export const CALENDLY_AUTH = "https://auth.calendly.com";
const TOKEN_URL = `${CALENDLY_AUTH}/oauth/token`;
const REVOKE_URL = `${CALENDLY_AUTH}/oauth/revoke`;
export const CALENDLY_API = "https://api.calendly.com";

/**
 * Calendly's availability endpoint takes a window of at most seven days
 * (`/event_type_available_times`), and the start may not be in the past.
 * Belline asks one local day at a time, so this is only ever a guard.
 */
export const AVAILABILITY_WINDOW_DAYS = 7;

/**
 * Calendly no longer accepts the saved connection: the refresh token was
 * revoked, the user removed Belline, or the account was closed. The owner
 * reconnects; nothing Belline does fixes it.
 */
export class CalendlyAuthError extends Error {
  constructor(message = "Calendly no longer accepts the saved connection.") {
    super(message);
    this.name = "CalendlyAuthError";
  }
}

/** Anything else Calendly refused or failed at. The message is for the log, never a screen. */
export class CalendlyApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CalendlyApiError";
  }
}

/**
 * Calendly refuses because of how Belline's own OAuth application is
 * registered, not because of anything the owner did: the client id is not one
 * Calendly knows, the secret is wrong, or the redirect address on the
 * application does not match the one Belline sent. Only Belline can fix these,
 * and reconnecting does not help.
 */
export class CalendlyConfigError extends Error {
  constructor(
    readonly reason: "client" | "secret" | "redirect" | "scope",
    message: string,
  ) {
    super(message);
    this.name = "CalendlyConfigError";
  }
}

/**
 * The owner's Calendly account cannot do what was asked because of their plan.
 *
 * Creating an invitee through the API — the Scheduling API, `POST /invitees` —
 * needs a paid Calendly plan. A Free account can be connected, and Belline can
 * read its event types and its open times, but it cannot book. That is said at
 * connect time rather than discovered by a customer on the phone.
 */
export class CalendlyPlanError extends Error {
  constructor(message = "This Calendly plan cannot take bookings through the API.") {
    super(message);
    this.name = "CalendlyPlanError";
  }
}

/**
 * Calendly refused because the account has made too many bookings.
 *
 * Calendly rate-limits `POST /invitees` per user, and the ceiling is low enough
 * to matter to a real business: on a paid non-enterprise plan 10 a minute, 50
 * an hour and **100 a day**; on a trial, five a day. Enterprise is 500 a minute.
 * Everything else is 500 a minute on a paid plan and 50 on Free.
 *
 * `retryAfterSec` is Calendly's `X-RateLimit-Reset` where it sent one. A daily
 * cap is not something waiting a minute fixes, so the caller is told plainly
 * and the team gets an exception; see calendly.ts.
 */
export class CalendlyRateLimitError extends Error {
  constructor(
    readonly retryAfterSec: number | undefined,
    readonly daily: boolean,
    message: string,
  ) {
    super(message);
    this.name = "CalendlyRateLimitError";
  }
}

/** The time asked for is not one Calendly has open any more. Somebody else took it. */
export class CalendlyTimeTakenError extends Error {
  constructor(message = "That time is no longer open in Calendly.") {
    super(message);
    this.name = "CalendlyTimeTakenError";
  }
}

export interface CalendlyTokens {
  accessToken: string;
  /** Calendly issues a new refresh token on every refresh; the newest must be kept. */
  refreshToken: string;
  /** What was granted, space-separated as Calendly returned it. `default` on a pre-scopes application. */
  scope: string;
  /** Seconds the access token lasts. Calendly's is two hours. */
  expiresIn: number;
  /** The user this token belongs to, as a URI. */
  owner: string;
  /** Their organisation, as a URI. Webhooks are subscribed against it. */
  organization: string;
}

export interface CalendlyUser {
  uri: string;
  name: string;
  email: string;
  /** Their public booking page. */
  schedulingUrl: string;
  timezone: string;
  /** The organisation the token's owner belongs to. */
  organization: string;
}

/**
 * One of the owner's event types: a named, fixed-length appointment kind.
 *
 * `poolingType` is what makes staff selection possible or impossible. A solo
 * event type belongs to one host, so booking it books that person. A
 * `round_robin` or `collective` one is a pool: Calendly picks who, and Belline
 * must not promise a caller a particular person.
 */
export interface CalendlyEventType {
  uri: string;
  name: string;
  /** Minutes. Calendly's, and not negotiable. */
  duration: number;
  active: boolean;
  /** A hidden event type, bookable only by its direct link. Belline can still book it. */
  secret: boolean;
  /** `solo`, `round_robin`, `collective`, or absent on an older account. */
  poolingType?: string;
  /** `null` for a pooled type; otherwise the host's user URI. */
  owner?: string;
  schedulingUrl: string;
  /** Where the appointment happens, in Calendly's words, for the connect screen. */
  kind?: string;
}

/** One time Calendly has open for an event type. */
export interface CalendlySlot {
  /** ISO instant, UTC, as Calendly returns it. */
  startTime: string;
  /** How many more invitees this time can still take. A one-to-one type says 1. */
  inviteesRemaining: number;
  schedulingUrl: string;
}

/** An invitee Belline created, or found again. */
export interface CalendlyInvitee {
  /** The invitee's own URI. */
  uri: string;
  /** The scheduled event it belongs to. This is what a cancellation names. */
  eventUri: string;
  email: string;
  name: string;
  startTime: string;
  /** Set once it has been cancelled, on either side. */
  canceled?: boolean;
}

export interface CalendlyWebhook {
  uri: string;
  callbackUrl: string;
  events: string[];
  /** Calendly generates one per webhook for an OAuth application, and shows it once. */
  signingKey?: string;
}

export interface CalendlyApi {
  /** Finish OAuth. Throws when Calendly returns no refresh token. */
  exchangeCode(code: string, redirectUri: string): Promise<CalendlyTokens>;
  /** Throws CalendlyAuthError when the refresh token is no longer good. */
  refresh(refreshToken: string): Promise<CalendlyTokens>;
  /** Withdraw Belline's access at Calendly. Already gone counts as revoked. */
  revoke(token: string): Promise<void>;
  /** Who the token belongs to. The first call after a connection, as Calendly's own guide says. */
  me(accessToken: string): Promise<CalendlyUser>;
  /** This user's event types, active ones first. */
  listEventTypes(accessToken: string, userUri: string): Promise<CalendlyEventType[]>;
  /** Times this event type has open in [start, end). At most seven days. */
  availableTimes(accessToken: string, eventTypeUri: string, start: string, end: string): Promise<CalendlySlot[]>;
  /**
   * Book somebody in. Calendly has no idempotency key, so the caller looks
   * first with `findInvitee` — see calendly.ts, where that pairing lives.
   */
  createInvitee(
    accessToken: string,
    input: { eventType: string; startTime: string; name: string; email: string; timezone: string; textReminderNumber?: string; notes?: string },
  ): Promise<CalendlyInvitee>;
  /**
   * An invitee this email already has on this event type at this instant, or
   * null. How a create whose answer was lost is found rather than repeated.
   */
  findInvitee(accessToken: string, opts: { organization: string; email: string; startTime: string }): Promise<CalendlyInvitee | null>;
  /** Cancel the scheduled event. Already cancelled counts as cancelled. */
  cancelEvent(accessToken: string, eventUri: string, reason: string): Promise<void>;
  /** Webhook subscriptions this organisation has pointed at Belline. */
  listWebhooks(accessToken: string, organization: string, scope: "organization" | "user", userUri?: string): Promise<CalendlyWebhook[]>;
  createWebhook(
    accessToken: string,
    input: { url: string; events: string[]; organization: string; user?: string; scope: "organization" | "user" },
  ): Promise<CalendlyWebhook>;
  /** Already gone counts as deleted. */
  deleteWebhook(accessToken: string, webhookUri: string): Promise<void>;
}

/** The webhook events Belline subscribes to. Calendly has no `invitee.rescheduled`. */
export const CALENDLY_WEBHOOK_EVENTS = ["invitee.created", "invitee.canceled"] as const;

function clientId(): string {
  return process.env.CALENDLY_CLIENT_ID ?? "";
}
function clientSecret(): string {
  return process.env.CALENDLY_CLIENT_SECRET ?? "";
}

async function body(res: Response): Promise<string> {
  return (await res.text().catch(() => "")).slice(0, 600);
}

interface TokenErrorBody {
  error?: string;
  error_description?: string;
}

/**
 * Turn a token endpoint failure into the error Belline acts on. Exported for
 * the tests, which feed it the bodies Calendly actually sends. `grant` says
 * whether the grant was a refresh token (a refused one means reconnect) or an
 * authorization code (a refused one means try again).
 */
export function tokenFailure(status: number, data: TokenErrorBody, grant: "code" | "refresh"): Error {
  const short = `token ${grant}: ${status} ${data.error ?? ""} ${data.error_description ?? ""}`.slice(0, 300);
  const described = `${data.error ?? ""} ${data.error_description ?? ""}`.toLowerCase();
  if (data.error === "invalid_client" || status === 401) {
    return new CalendlyConfigError(described.includes("secret") ? "secret" : "client", short);
  }
  if (described.includes("redirect")) return new CalendlyConfigError("redirect", short);
  if (described.includes("scope")) return new CalendlyConfigError("scope", short);
  // A code that was already redeemed is the owner double-clicking, not a dead
  // grant: only a refused *refresh* token means the connection has to be remade.
  if (grant === "refresh" && (data.error === "invalid_grant" || status === 400)) return new CalendlyAuthError(short);
  return new CalendlyApiError(status, short);
}

/**
 * A Calendly API failure, as the error Belline acts on. Exported for the tests.
 *
 * Calendly answers 403 for both "your plan does not include this" and "your
 * token may not do this", and the two want opposite handling — one is the
 * owner's subscription and the other is a reconnect — so the body's `title` and
 * `message` are read rather than the status alone.
 */
export function apiFailure(status: number, text: string, what: string, headers?: Headers): Error {
  let title = "";
  let message = "";
  try {
    const data = JSON.parse(text) as { title?: string; message?: string; details?: { message?: string }[] };
    title = data.title ?? "";
    message = data.message ?? data.details?.[0]?.message ?? "";
  } catch {
    message = text;
  }
  const short = `${what}: ${status} ${title} ${message}`.slice(0, 300);
  const said = `${title} ${message}`.toLowerCase();

  if (status === 429) {
    const reset = Number(headers?.get("x-ratelimit-reset") ?? "");
    // Calendly's own wording for the create-invitee ceilings. A day is not
    // something a retry in a minute fixes, and the two are told apart here.
    const daily = /per day|daily/.test(said);
    return new CalendlyRateLimitError(Number.isFinite(reset) && reset > 0 ? reset : undefined, daily, short);
  }
  if (status === 403 && /plan|subscription|upgrade|not available on|paid/.test(said)) return new CalendlyPlanError(short);
  if (status === 401) return new CalendlyAuthError(short);
  if (status === 403) return new CalendlyAuthError(short);
  // A time that went while the caller was deciding. Calendly answers 400 or 422
  // with its own wording; either way there is nothing wrong with the connection.
  if ((status === 400 || status === 422) && /no longer available|not available|already been scheduled|invalid start time|spot/.test(said)) {
    return new CalendlyTimeTakenError(short);
  }
  return new CalendlyApiError(status, short);
}

async function token(params: Record<string, string>, grant: "code" | "refresh"): Promise<CalendlyTokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId(), client_secret: clientSecret(), ...params }),
  });
  const data = (await res.json().catch(() => ({}))) as TokenErrorBody & {
    access_token?: string;
    refresh_token?: string;
    scope?: string;
    expires_in?: number;
    owner?: string;
    organization?: string;
  };
  if (!res.ok || data.error) throw tokenFailure(res.status, data, grant);
  if (!data.access_token) throw new CalendlyApiError(res.status, `token ${grant}: no access token returned`);
  if (!data.refresh_token) throw new CalendlyApiError(res.status, `token ${grant}: no refresh token returned`);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    scope: data.scope ?? "",
    expiresIn: Number(data.expires_in ?? 7200),
    owner: data.owner ?? "",
    organization: data.organization ?? "",
  };
}

export async function callCalendly(accessToken: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(path.startsWith("https://") ? path : `${CALENDLY_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

const asEventType = (e: Record<string, unknown>): CalendlyEventType => ({
  uri: String(e.uri ?? ""),
  name: String(e.name ?? "Appointment"),
  duration: Number(e.duration ?? 0),
  active: e.active !== false,
  secret: Boolean(e.secret),
  poolingType: typeof e.pooling_type === "string" ? e.pooling_type : undefined,
  owner: typeof (e.profile as { owner?: string } | undefined)?.owner === "string" ? (e.profile as { owner: string }).owner : undefined,
  schedulingUrl: String(e.scheduling_url ?? ""),
  kind: typeof e.kind === "string" ? e.kind : undefined,
});

/** Walk Calendly's `pagination.next_page` up to a cap, so one huge account cannot hold a caller. */
async function pages<T>(accessToken: string, first: string, what: string, take: (row: Record<string, unknown>) => T, cap = 10): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined = first;
  for (let page = 0; next && page < cap; page++) {
    const res: Response = await callCalendly(accessToken, next);
    if (!res.ok) throw apiFailure(res.status, await body(res), what, res.headers);
    const data = (await res.json()) as { collection?: Record<string, unknown>[]; pagination?: { next_page?: string | null } };
    for (const row of data.collection ?? []) out.push(take(row));
    next = data.pagination?.next_page ?? undefined;
  }
  return out;
}

/** The real thing. Only reached when nothing was injected and stubs are off. */
export const liveCalendlyApi: CalendlyApi = {
  exchangeCode(code, redirectUri) {
    return token({ code, redirect_uri: redirectUri, grant_type: "authorization_code" }, "code");
  },

  refresh(refreshToken) {
    return token({ refresh_token: refreshToken, grant_type: "refresh_token" }, "refresh");
  },

  async revoke(tokenValue) {
    const res = await fetch(REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId(), client_secret: clientSecret(), token: tokenValue }),
    });
    // Calendly answers 200 for a token it has already forgotten, and 400 for
    // one it never knew. Neither is a reason to keep the link.
    if (!res.ok && res.status !== 400) throw apiFailure(res.status, await body(res), "revoke", res.headers);
  },

  async me(accessToken) {
    const res = await callCalendly(accessToken, "/users/me");
    if (!res.ok) throw apiFailure(res.status, await body(res), "users.me", res.headers);
    const r = ((await res.json()) as { resource?: Record<string, unknown> }).resource ?? {};
    return {
      uri: String(r.uri ?? ""),
      name: String(r.name ?? ""),
      email: String(r.email ?? ""),
      schedulingUrl: String(r.scheduling_url ?? ""),
      timezone: String(r.timezone ?? "UTC"),
      organization: String(r.current_organization ?? ""),
    };
  },

  async listEventTypes(accessToken, userUri) {
    const params = new URLSearchParams({ user: userUri, count: "100" });
    const all = await pages(accessToken, `/event_types?${params}`, "event_types", asEventType);
    return all.sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
  },

  async availableTimes(accessToken, eventTypeUri, start, end) {
    const params = new URLSearchParams({ event_type: eventTypeUri, start_time: start, end_time: end });
    const res = await callCalendly(accessToken, `/event_type_available_times?${params}`);
    if (!res.ok) throw apiFailure(res.status, await body(res), "event_type_available_times", res.headers);
    const data = (await res.json()) as { collection?: Record<string, unknown>[] };
    return (data.collection ?? [])
      .filter((s) => s.status === undefined || s.status === "available")
      .map((s) => ({
        startTime: String(s.start_time ?? ""),
        inviteesRemaining: Number(s.invitees_remaining ?? 1),
        schedulingUrl: String(s.scheduling_url ?? ""),
      }));
  },

  async createInvitee(accessToken, input) {
    const res = await callCalendly(accessToken, "/invitees", {
      method: "POST",
      body: JSON.stringify({
        event_type: input.eventType,
        start_time: input.startTime,
        invitee: {
          name: input.name,
          email: input.email,
          timezone: input.timezone,
          ...(input.textReminderNumber ? { text_reminder_number: input.textReminderNumber } : {}),
        },
      }),
    });
    if (!res.ok) throw apiFailure(res.status, await body(res), "invitees.create", res.headers);
    const r = ((await res.json()) as { resource?: Record<string, unknown> }).resource ?? {};
    return {
      uri: String(r.uri ?? ""),
      eventUri: String(r.event ?? ""),
      email: String(r.email ?? input.email),
      name: String(r.name ?? input.name),
      startTime: input.startTime,
    };
  },

  async findInvitee(accessToken, { organization, email, startTime }) {
    // A one-second window either side: Calendly stores the instant it was given.
    const at = Date.parse(startTime);
    const params = new URLSearchParams({
      organization,
      invitee_email: email,
      min_start_time: new Date(at - 1000).toISOString(),
      max_start_time: new Date(at + 1000).toISOString(),
      status: "active",
      count: "20",
    });
    const res = await callCalendly(accessToken, `/scheduled_events?${params}`);
    if (!res.ok) throw apiFailure(res.status, await body(res), "scheduled_events", res.headers);
    const data = (await res.json()) as { collection?: Record<string, unknown>[] };
    for (const event of data.collection ?? []) {
      const eventUri = String(event.uri ?? "");
      if (!eventUri) continue;
      const uuid = eventUri.split("/").pop() ?? "";
      const inv = await callCalendly(accessToken, `/scheduled_events/${encodeURIComponent(uuid)}/invitees?email=${encodeURIComponent(email)}&count=10`);
      if (!inv.ok) continue;
      const rows = ((await inv.json()) as { collection?: Record<string, unknown>[] }).collection ?? [];
      const found = rows.find((i) => String(i.email ?? "").toLowerCase() === email.toLowerCase() && i.status !== "canceled");
      if (found) {
        return {
          uri: String(found.uri ?? ""),
          eventUri,
          email,
          name: String(found.name ?? ""),
          startTime: String(event.start_time ?? startTime),
        };
      }
    }
    return null;
  },

  async cancelEvent(accessToken, eventUri, reason) {
    const uuid = eventUri.split("/").pop() ?? "";
    const res = await callCalendly(accessToken, `/scheduled_events/${encodeURIComponent(uuid)}/cancellation`, {
      method: "POST",
      body: JSON.stringify({ reason: reason.slice(0, 200) }),
    });
    if (res.ok || res.status === 404) return;
    const text = await body(res);
    // Calendly refuses a second cancellation of the same event; that is the
    // outcome Belline wanted, so it is not a failure.
    if (/already canceled|already cancelled/i.test(text)) return;
    throw apiFailure(res.status, text, "scheduled_events.cancellation", res.headers);
  },

  async listWebhooks(accessToken, organization, scope, userUri) {
    const params = new URLSearchParams({ organization, scope, count: "100" });
    if (scope === "user" && userUri) params.set("user", userUri);
    return pages(accessToken, `/webhook_subscriptions?${params}`, "webhook_subscriptions", (w) => ({
      uri: String(w.uri ?? ""),
      callbackUrl: String(w.callback_url ?? ""),
      events: Array.isArray(w.events) ? (w.events as string[]) : [],
    }));
  },

  async createWebhook(accessToken, input) {
    const res = await callCalendly(accessToken, "/webhook_subscriptions", {
      method: "POST",
      body: JSON.stringify({
        url: input.url,
        events: input.events,
        organization: input.organization,
        ...(input.scope === "user" && input.user ? { user: input.user } : {}),
        scope: input.scope,
      }),
    });
    if (!res.ok) throw apiFailure(res.status, await body(res), "webhook_subscriptions.create", res.headers);
    const r = ((await res.json()) as { resource?: Record<string, unknown> }).resource ?? {};
    return {
      uri: String(r.uri ?? ""),
      callbackUrl: String(r.callback_url ?? input.url),
      events: Array.isArray(r.events) ? (r.events as string[]) : input.events,
      // Shown once, on creation, and never again.
      signingKey: typeof r.signing_key === "string" ? r.signing_key : undefined,
    };
  },

  async deleteWebhook(accessToken, webhookUri) {
    const uuid = webhookUri.split("/").pop() ?? "";
    const res = await callCalendly(accessToken, `/webhook_subscriptions/${encodeURIComponent(uuid)}`, { method: "DELETE" });
    if (res.status === 404 || res.ok) return;
    throw apiFailure(res.status, await body(res), "webhook_subscriptions.delete", res.headers);
  },
};

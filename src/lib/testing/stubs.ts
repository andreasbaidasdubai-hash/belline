import { createHmac, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { assertStubsSafe, stubsRequested } from "../flags";
import type { EmailMessage } from "../providers/email";
import type { ModelCall } from "../prospect";
import type { Graph, GraphReply } from "../whatsapp-provision";
import {
  GOOGLE_SCOPES,
  GoogleApiError,
  GoogleAuthError,
  googleFailure,
  zonedInstant,
  type GoogleApi,
  type GoogleCalendarEntry,
  type GoogleEvent,
} from "../integrations/google-api";
import {
  graphFailure,
  tokenFailure,
  type MicrosoftApi,
  type OutlookCalendarEntry,
  type TokenErrorBody,
} from "../integrations/microsoft-api";

/**
 * Fake providers for local end-to-end runs.
 *
 * Every outside service the self-serve journey touches has a stand-in here:
 * the model, the Twilio number pool, Meta's Graph API, Stripe, Google
 * Calendar and the mailer. Each one records what it was asked, so a test can
 * assert on the conversation rather than on a mock's return value.
 *
 * Loaded only through `installStubs()`, which checks `FLAG_STUBS=on` is safe
 * here (never production, never next to a real database) and then puts a
 * guard on `fetch`: while stubs are on, a request to any host that is not
 * this machine throws. A stub that forgot to intercept something fails
 * loudly instead of reaching a real provider.
 */

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\]|::1|[\w-]+\.localhost)$/i;

export class BlockedFetchError extends Error {
  constructor(readonly host: string) {
    super(`Stub mode blocked an outbound request to ${host}. Use a stub provider instead.`);
    this.name = "BlockedFetchError";
  }
}

const globalRef = globalThis as unknown as {
  __bellineStubFetch?: { original: typeof fetch; blocked: string[] };
};

function hostOf(input: string | URL | Request): string {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  try {
    return new URL(raw).hostname;
  } catch {
    // A relative URL has no host of its own; it can only mean this server.
    return "localhost";
  }
}

/** Wrap `fetch` so only local hosts are reachable. Idempotent. */
export function installFetchGuard(): void {
  if (globalRef.__bellineStubFetch) return;
  const original = globalThis.fetch;
  const state = { original, blocked: [] as string[] };
  globalRef.__bellineStubFetch = state;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const host = hostOf(input);
    if (!LOCAL.test(host)) {
      state.blocked.push(host);
      throw new BlockedFetchError(host);
    }
    return original(input, init);
  }) as typeof fetch;
}

/** Hosts the guard refused, oldest first. */
export function blockedFetches(): string[] {
  return [...(globalRef.__bellineStubFetch?.blocked ?? [])];
}

/** Put the real `fetch` back. Tests only. */
export function removeFetchGuard(): void {
  const state = globalRef.__bellineStubFetch;
  if (!state) return;
  globalThis.fetch = state.original;
  globalRef.__bellineStubFetch = undefined;
}

/**
 * Turn stub mode on for this process.
 *
 * Throws when `FLAG_STUBS=on` is unsafe here. Returns false and changes
 * nothing when stubs were not asked for.
 */
export function installStubs(env: Record<string, string | undefined> = process.env): boolean {
  if (!stubsRequested(env)) return false;
  assertStubsSafe(env);
  installFetchGuard();
  return true;
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export type ModelReply = Awaited<ReturnType<ModelCall>>;
type ModelParams = Parameters<ModelCall>[0];

/**
 * A scripted model. Replies are handed out in order; a function reply sees
 * the request, so a test can answer based on what was asked.
 */
export function fakeModel(script: (ModelReply | ((params: ModelParams) => ModelReply))[]) {
  const calls: ModelParams[] = [];
  const call: ModelCall = async (params) => {
    calls.push(params);
    const next = script[calls.length - 1];
    if (!next) throw new Error(`The fake model has no scripted reply for call ${calls.length}.`);
    return typeof next === "function" ? next(params) : next;
  };
  return { call, calls };
}

/** A model reply that calls one tool with `input`. */
export function toolReply(name: string, input: unknown): ModelReply {
  return { content: [{ type: "tool_use", input, ...{ name, id: `toolu_stub_${randomUUID()}` } }] };
}

// ---------------------------------------------------------------------------
// Meta Graph
// ---------------------------------------------------------------------------

/**
 * Meta's Graph API for number provisioning. Adding a number returns an id,
 * the code `123456` verifies and anything else is refused the way Meta
 * refuses it. `respond` overrides any path.
 */
export function fakeGraph(respond: (path: string, body: Record<string, unknown>) => GraphReply | undefined = () => undefined) {
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  const gets: string[] = [];
  /** Meta's display-name review per number id. PENDING_REVIEW until a test says otherwise. */
  const names = new Map<string, string>();
  let getReply: GraphReply | undefined;
  let seq = 0;
  const graph: Graph = {
    async get(p) {
      gets.push(p);
      if (getReply) return getReply;
      return { ok: true, status: 200, body: { id: p, name_status: names.get(p) ?? "PENDING_REVIEW", code_verification_status: "VERIFIED" } };
    },
    async post(p, body) {
      posts.push({ path: p, body });
      const custom = respond(p, body);
      if (custom) return custom;
      if (p.endsWith("/verify_code")) {
        return body.code === "123456"
          ? { ok: true, status: 200, body: { success: true } }
          : { ok: false, status: 400, body: { error: { message: "Invalid code", code: 136025 } } };
      }
      if (p.endsWith("/phone_numbers")) return { ok: true, status: 200, body: { id: `stub_phone_${++seq}` } };
      return { ok: true, status: 200, body: { success: true } };
    },
  };
  return {
    graph,
    posts,
    gets,
    /** Meta finishing its review of a number's name: "APPROVED" or "DECLINED". */
    setNameStatus(phoneNumberId: string, status: string): void {
      names.set(phoneNumberId, status);
    },
    /** Make every read answer this, e.g. an expired token. Undefined restores. */
    failGets(reply: GraphReply | undefined): void {
      getReply = reply;
    },
  };
}

const graphRef = globalThis as unknown as { __bellineStubGraph?: ReturnType<typeof fakeGraph> };

/** One fake Graph for the whole stubbed server, so the routes and the job see the same numbers. */
export function stubGraph(): ReturnType<typeof fakeGraph> {
  graphRef.__bellineStubGraph ??= fakeGraph();
  return graphRef.__bellineStubGraph;
}

// ---------------------------------------------------------------------------
// Twilio number pool
// ---------------------------------------------------------------------------

/** Pre-bought numbers. A claim is atomic within the process; none left is null. */
export function fakeNumberPool(numbers: readonly string[]) {
  const free = [...numbers];
  const assigned = new Map<string, string>();
  const voiceUrls = new Map<string, string>();
  return {
    claim(locationId: string, voiceUrl: string): string | null {
      const existing = assigned.get(locationId);
      if (existing) return existing;
      const number = free.shift();
      if (!number) return null;
      assigned.set(locationId, number);
      voiceUrls.set(number, voiceUrl);
      return number;
    },
    release(locationId: string): void {
      const number = assigned.get(locationId);
      if (!number) return;
      assigned.delete(locationId);
      voiceUrls.delete(number);
      free.push(number);
    },
    assigned,
    voiceUrls,
    get freeCount() {
      return free.length;
    },
  };
}

/** `STUB_POOL=+97140000001,+97140000002` as a list. */
export function stubPoolFromEnv(env: Record<string, string | undefined> = process.env): string[] {
  return (env.STUB_POOL ?? "").split(",").map((n) => n.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------

/**
 * Checkout and webhooks. The checkout URL points back at this server, and
 * `signWebhook` produces a genuine `Stripe-Signature` header, so the real
 * webhook route verifies it with the real library.
 */
export function fakeStripe(origin: string) {
  const sessions: { id: string; url: string; params: Record<string, unknown> }[] = [];
  return {
    checkout: {
      sessions: {
        async create(params: Record<string, unknown>) {
          const id = `cs_test_stub_${randomUUID().replace(/-/g, "")}`;
          const session = { id, url: `${origin.replace(/\/+$/, "")}/__stub/stripe/checkout?session=${id}`, params };
          sessions.push(session);
          return { id, url: session.url, object: "checkout.session" as const };
        },
      },
    },
    sessions,
  };
}

export function signWebhook(payload: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

// ---------------------------------------------------------------------------
// Google Calendar
// ---------------------------------------------------------------------------

export interface StubEvent {
  id: string;
  start: string;
  end: string;
  summary?: string;
  status?: string;
  transparent?: boolean;
  bellineBookingId?: string;
}

/** Busy blocks and events per calendar. Writing the same event id twice replaces it. */
export function fakeGoogleCalendar() {
  const events = new Map<string, Map<string, StubEvent>>();
  const busy = new Map<string, { start: string; end: string }[]>();
  const of = (calendarId: string) => {
    if (!events.has(calendarId)) events.set(calendarId, new Map());
    return events.get(calendarId)!;
  };
  return {
    addBusy(calendarId: string, start: string, end: string): void {
      busy.set(calendarId, [...(busy.get(calendarId) ?? []), { start, end }]);
    },
    async freeBusy(calendarId: string, from: string, to: string) {
      const confirmed = [...of(calendarId).values()]
        .filter((e) => e.status !== "cancelled")
        .map(({ start, end }) => ({ start, end }));
      return [...(busy.get(calendarId) ?? []), ...confirmed].filter((b) => b.start < to && b.end > from);
    },
    async upsertEvent(calendarId: string, event: StubEvent): Promise<StubEvent> {
      of(calendarId).set(event.id, event);
      return event;
    },
    events(calendarId: string): StubEvent[] {
      return [...of(calendarId).values()];
    },
    /** Busy blocks and live events overlapping the window, the way events.list returns them. */
    listEvents(calendarId: string, from: string, to: string): StubEvent[] {
      const lo = Date.parse(from);
      const hi = Date.parse(to);
      const blocks = (busy.get(calendarId) ?? []).map((b, i) => ({ id: `busy${i}`, ...b }));
      const live = [...of(calendarId).values()].filter((e) => e.status !== "cancelled");
      return [...blocks, ...live].filter((e) => Date.parse(e.start) < hi && Date.parse(e.end) > lo);
    },
  };
}

/**
 * The whole Google API Belline uses, on top of `fakeGoogleCalendar`.
 *
 * The code `stub-code` connects; any other is refused. `expire()` makes Google
 * stop accepting every refresh token, the way a revoked or expired one fails.
 * `calls` records each method, so a test can assert nothing was written.
 */
export function fakeGoogleApi(opts: { calendars?: GoogleCalendarEntry[] } = {}) {
  const calendar = fakeGoogleCalendar();
  const calls: { method: keyof GoogleApi; calendarId?: string; id?: string }[] = [];
  const tokens = new Set<string>();
  const revoked: string[] = [];
  let expired = false;
  let seq = 0;
  const calendars = opts.calendars ?? [{ id: "primary", name: "Main calendar", primary: true }];

  const toStub = (event: GoogleEvent): StubEvent => {
    const at = (t: { dateTime: string; timeZone: string }) => {
      const [date, clock] = t.dateTime.split("T");
      const [h, m] = clock.split(":").map(Number);
      return new Date(zonedInstant(date, h * 60 + m, t.timeZone)).toISOString();
    };
    return {
      id: event.id,
      start: at(event.start),
      end: at(event.end),
      summary: event.summary,
      status: event.status,
      bellineBookingId: event.extendedProperties.private.bellineBookingId,
    };
  };
  let apiDisabled = false;
  let grantedScope = GOOGLE_SCOPES.join(" ");
  const access = (token: string) => {
    if (expired || !token.startsWith("stub-access-") || !tokens.has(token.slice("stub-access-".length))) {
      throw new GoogleAuthError("stub: token refused");
    }
    // What Google answers when the Calendar API is not enabled on the project,
    // through the same classifier the live client uses.
    if (apiDisabled) {
      throw googleFailure(
        403,
        JSON.stringify({
          error: {
            code: 403,
            message: "Google Calendar API has not been used in project 000000000000 before or it is disabled.",
            errors: [{ domain: "usageLimits", reason: "accessNotConfigured" }],
            status: "PERMISSION_DENIED",
            details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED" }],
          },
        }),
        "stub",
      );
    }
  };
  /** Failures queued by `failNext`, per method. */
  const failures = new Map<keyof GoogleApi, { times: number; afterWrite: boolean }>();
  /** Throws when a failure is queued for this method. `wrote` says whether the write already happened. */
  const trip = (method: keyof GoogleApi, wrote: boolean) => {
    const f = failures.get(method);
    if (!f || f.times <= 0 || f.afterWrite !== wrote) return;
    f.times--;
    throw new GoogleApiError(503, `stub: ${method} failed${wrote ? " after the write landed" : ""}`);
  };

  const api: GoogleApi = {
    async exchangeCode(code) {
      calls.push({ method: "exchangeCode" });
      if (code !== "stub-code") throw new GoogleApiError(400, "stub: invalid_grant");
      const refreshToken = `stub-refresh-${++seq}-${randomUUID()}`;
      tokens.add(refreshToken);
      return { refreshToken, scope: grantedScope };
    },
    async accessToken(refreshToken) {
      calls.push({ method: "accessToken" });
      if (expired || !tokens.has(refreshToken)) throw new GoogleAuthError("stub: invalid_grant");
      return `stub-access-${refreshToken}`;
    },
    async listCalendars(token) {
      access(token);
      calls.push({ method: "listCalendars" });
      return calendars;
    },
    async listEvents(token, calendarId, timeMin, timeMax) {
      access(token);
      calls.push({ method: "listEvents", calendarId });
      return calendar.listEvents(calendarId, timeMin, timeMax);
    },
    async insertEvent(token, calendarId, event) {
      access(token);
      calls.push({ method: "insertEvent", calendarId, id: event.id });
      if (calendar.events(calendarId).some((e) => e.id === event.id)) return { id: event.id, created: false };
      await calendar.upsertEvent(calendarId, toStub(event));
      return { id: event.id, created: true };
    },
    async putEvent(token, calendarId, event) {
      access(token);
      calls.push({ method: "putEvent", calendarId, id: event.id });
      trip("putEvent", false);
      await calendar.upsertEvent(calendarId, toStub(event));
      trip("putEvent", true);
    },
    async cancelEvent(token, calendarId, eventId) {
      access(token);
      calls.push({ method: "cancelEvent", calendarId, id: eventId });
      trip("cancelEvent", false);
      const existing = calendar.events(calendarId).find((e) => e.id === eventId);
      if (existing) await calendar.upsertEvent(calendarId, { ...existing, status: "cancelled" });
      trip("cancelEvent", true);
    },
    async revoke(refreshToken) {
      calls.push({ method: "revoke" });
      tokens.delete(refreshToken);
      revoked.push(refreshToken);
    },
  };

  return {
    api,
    calendar,
    calls,
    revoked,
    expire(): void {
      expired = true;
    },
    restore(): void {
      expired = false;
    },
    /**
     * The next `times` calls to `method` fail with a 503. With `afterWrite` the
     * write lands first and only the answer is lost, the way a dropped
     * connection looks from Belline's side.
     */
    failNext(method: "putEvent" | "cancelEvent", times = 1, opts: { afterWrite?: boolean } = {}): void {
      failures.set(method, { times, afterWrite: Boolean(opts.afterWrite) });
    },
    /** The Calendar API switched off on the project: every calendar call is refused with 403 accessNotConfigured. */
    disableApi(): void {
      apiDisabled = true;
    },
    enableApi(): void {
      apiDisabled = false;
    },
    /** What the owner leaves ticked on Google's screen. Defaults to both. */
    grant(scopes: readonly string[] = GOOGLE_SCOPES): void {
      grantedScope = scopes.join(" ");
    },
  };
}

// ---------------------------------------------------------------------------
// Microsoft (token endpoint and Graph)
// ---------------------------------------------------------------------------

/**
 * The Microsoft identity platform and the Graph calls Belline makes.
 *
 * The code `stub-code` connects; any other is refused as Microsoft refuses a
 * spent code. Every refresh hands back a new refresh token, as Microsoft does.
 * By default the old one keeps working, as Microsoft's does; `revokeOnRotate()`
 * makes a used refresh token stop working, which is how a test proves Belline
 * stored the new one rather than getting lucky with the old.
 *
 * Failures are fed through the same classifiers the live client uses
 * (`tokenFailure`, `graphFailure`), with the bodies Microsoft sends.
 */
export function fakeMicrosoftApi(opts: { calendars?: OutlookCalendarEntry[] } = {}) {
  const calls: { method: keyof MicrosoftApi; calendarId?: string; id?: string }[] = [];
  /** Refresh tokens Microsoft would accept. */
  const live = new Set<string>();
  /** Every refresh token ever issued, in order. */
  const issued: string[] = [];
  let seq = 0;
  let expired = false;
  let revokeOnRotate = false;
  let grantedScope = "Calendars.ReadWrite User.Read profile openid email";
  let calendars = opts.calendars ?? [{ id: "AAMkAD-default", name: "Calendar", primary: true }];
  let tokenError: { status: number; body: TokenErrorBody } | null = null;

  const issue = () => {
    const token = `stub-ms-refresh-${++seq}-${randomUUID()}`;
    live.add(token);
    issued.push(token);
    return token;
  };
  const access = (token: string) => {
    if (expired || !token.startsWith("stub-ms-access-") || !live.has(token.slice("stub-ms-access-".length).split("#")[0])) {
      throw graphFailure(401, JSON.stringify({ error: { code: "InvalidAuthenticationToken", message: "Access token has expired or is not yet valid." } }), "stub");
    }
  };

  const api: MicrosoftApi = {
    async exchangeCode(code) {
      calls.push({ method: "exchangeCode" });
      if (tokenError) throw tokenFailure(tokenError.status, tokenError.body, "code");
      if (code !== "stub-code") {
        throw tokenFailure(400, { error: "invalid_grant", error_description: "AADSTS54005: OAuth2 Authorization code was already redeemed.", error_codes: [54005] }, "code");
      }
      const refreshToken = issue();
      return { accessToken: `stub-ms-access-${refreshToken}`, refreshToken, scope: grantedScope, expiresIn: 3600 };
    },
    async refresh(refreshToken) {
      calls.push({ method: "refresh" });
      if (tokenError) throw tokenFailure(tokenError.status, tokenError.body, "refresh");
      if (expired || !live.has(refreshToken)) {
        throw tokenFailure(
          400,
          { error: "invalid_grant", error_description: "AADSTS700082: The refresh token has expired due to inactivity.", error_codes: [700082] },
          "refresh",
        );
      }
      const next = issue();
      if (revokeOnRotate) live.delete(refreshToken);
      return { accessToken: `stub-ms-access-${next}`, refreshToken: next, scope: grantedScope, expiresIn: 3600 };
    },
    async listCalendars(token) {
      access(token);
      calls.push({ method: "listCalendars" });
      return calendars;
    },
  };

  return {
    api,
    calls,
    issued,
    /** Microsoft stops accepting every refresh token and access token. */
    expire(): void {
      expired = true;
    },
    restore(): void {
      expired = false;
    },
    /** A used refresh token stops working once a new one is issued. */
    revokeOnRotate(on = true): void {
      revokeOnRotate = on;
    },
    /** Is this refresh token one Microsoft would still accept? */
    accepts(refreshToken: string): boolean {
      return live.has(refreshToken) && !expired;
    },
    /** What Microsoft reports as granted. */
    grant(scope: string): void {
      grantedScope = scope;
    },
    setCalendars(list: OutlookCalendarEntry[]): void {
      calendars = list;
    },
    /** Every token request fails with this body until cleared with null. */
    failTokens(reply: { status: number; body: TokenErrorBody } | null): void {
      tokenError = reply;
    },
  };
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

/** Writes each message as one line of `outbox.ndjson`. Never reaches Resend. */
export function stubMailer(dataDir: string) {
  const file = path.join(dataDir, "outbox.ndjson");
  return {
    file,
    async send(message: EmailMessage): Promise<{ sent: boolean; reason?: string }> {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...message })}\n`);
      return { sent: true };
    },
    read(): (EmailMessage & { at: string })[] {
      if (!fs.existsSync(file)) return [];
      return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    },
  };
}

// ---------------------------------------------------------------------------
// Stripe checkout, across the app
// ---------------------------------------------------------------------------

/**
 * The checkout route and /__stub/stripe/checkout run in different module
 * graphs under Next, so a stubbed session is written beside the data rather
 * than held in memory.
 */
function stubDataDir(): string {
  // Read at call time, not import time: a check sets DATA_DIR after importing this.
  return path.resolve(process.env.DATA_DIR ?? path.join(process.cwd(), "data"));
}

function stubSessionsFile(): string {
  return path.join(stubDataDir(), "stub-stripe-sessions.json");
}

export interface StubCheckoutSession {
  id: string;
  url: string;
  params: Record<string, unknown>;
}

export function stubCheckoutSession(origin: string, params: Record<string, unknown>): StubCheckoutSession {
  const stripe = fakeStripe(origin);
  const id = `cs_test_stub_${randomUUID().replace(/-/g, "")}`;
  const session = { id, url: `${origin.replace(/\/+$/, "")}/__stub/stripe/checkout?session=${id}`, params };
  stripe.sessions.push(session);
  let all: StubCheckoutSession[] = [];
  try {
    all = JSON.parse(fs.readFileSync(stubSessionsFile(), "utf8")) as StubCheckoutSession[];
  } catch {
    all = [];
  }
  fs.mkdirSync(stubDataDir(), { recursive: true });
  fs.writeFileSync(stubSessionsFile(), JSON.stringify([...all, session], null, 2));
  return session;
}

export function readStubCheckoutSession(id: string): StubCheckoutSession | undefined {
  try {
    return (JSON.parse(fs.readFileSync(stubSessionsFile(), "utf8")) as StubCheckoutSession[]).find((s) => s.id === id);
  } catch {
    return undefined;
  }
}

/** The `checkout.session.completed` event Stripe would send for a paid stub session. */
export function stubCompletedEvent(session: StubCheckoutSession, created = Math.floor(Date.now() / 1000)): string {
  const suffix = session.id.slice(-12);
  const params = session.params as { metadata?: Record<string, string>; client_reference_id?: string; success_url?: string };
  return JSON.stringify({
    id: `evt_stub_${suffix}`,
    object: "event",
    type: "checkout.session.completed",
    created,
    data: {
      object: {
        id: session.id,
        object: "checkout.session",
        mode: "subscription",
        customer: `cus_stub_${suffix}`,
        subscription: `sub_stub_${suffix}`,
        client_reference_id: params.client_reference_id ?? null,
        metadata: params.metadata ?? {},
      },
    },
  });
}

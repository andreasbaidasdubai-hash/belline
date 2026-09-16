/**
 * The handful of Microsoft calls Belline makes, behind one interface.
 *
 * The Outlook twin of google-api.ts, kept apart from outlook.ts for the same
 * reasons: the connection logic (sealed and rotating tokens, expiry, fallback
 * to requests) is tested against a fake with this shape (testing/stubs.ts),
 * and nothing in a check script can reach Microsoft by accident.
 *
 * One app registration for every kind of account: the `common` endpoint takes
 * work and school accounts from any Microsoft Entra tenant and personal
 * Microsoft accounts (Outlook.com, Hotmail, Live).
 *
 * Scopes, exactly, and why these three:
 *
 * - `Calendars.ReadWrite` — list the owner's calendars for the picker, read the
 *   events on the ones they pick so busy times can be taken out, and create,
 *   change and delete the events Belline books.
 * - `offline_access` — a refresh token, so Belline can keep the calendar in
 *   step when the owner is not signed in. Without it every booking would need
 *   the owner at a browser.
 * - `User.Read` — the minimum sign-in permission Microsoft pairs with any
 *   delegated Graph scope. Belline reads nothing with it.
 *
 * Not `Calendars.Read.Shared` or `MailboxSettings`: Belline never reads
 * somebody else's calendar or changes the mailbox. And not free/busy through
 * `getSchedule`: like Google's free/busy it says "busy" without saying by
 * what, so Belline's own table bookings would block every other table at the
 * same time. Listing the events (calendarView) lets Belline skip its own,
 * tagged with a private extended property, and anything shown as free.
 */

export const MICROSOFT_SCOPES = ["offline_access", "User.Read", "Calendars.ReadWrite"] as const;

export const MICROSOFT_AUTHORITY = "https://login.microsoftonline.com/common/oauth2/v2.0";
const TOKEN_URL = `${MICROSOFT_AUTHORITY}/token`;
const GRAPH = "https://graph.microsoft.com/v1.0";

/** Microsoft no longer accepts the saved connection: revoked, expired, consent withdrawn. The owner reconnects. */
export class MicrosoftAuthError extends Error {
  constructor(message = "Microsoft no longer accepts the saved connection.") {
    super(message);
    this.name = "MicrosoftAuthError";
  }
}

/** Anything else Microsoft refused or failed at. The message is for the log, never a screen. */
export class MicrosoftApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "MicrosoftApiError";
  }
}

/**
 * Microsoft refuses because of how Belline's Entra app registration is set
 * up, not because of anything the owner did: the client id is not one
 * Microsoft knows (AADSTS700016), the secret is wrong or has expired
 * (AADSTS7000215, AADSTS7000222), or the redirect address is not registered
 * (AADSTS50011). Only Belline can fix these; reconnecting does not help.
 */
export class MicrosoftConfigError extends Error {
  constructor(
    readonly reason: "client" | "secret" | "redirect",
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MicrosoftConfigError";
  }
}

/** The AADSTS number in an error description, as a string, or "". */
export function aadstsCode(text: string | undefined): string {
  return /AADSTS(\d+)/.exec(text ?? "")?.[1] ?? "";
}

const CONFIG_CODES: Record<string, MicrosoftConfigError["reason"]> = {
  "700016": "client", // application not found in the directory
  "7000215": "secret", // invalid client secret
  "7000222": "secret", // client secret expired
  "7000218": "secret", // no client secret sent
  "50011": "redirect", // redirect URI not registered
  "500113": "redirect", // no reply address registered
  "900971": "redirect", // no reply address provided
};

/** Token-endpoint `error` codes that mean refresh token or grant is no good any more. */
const GRANT_CODES = new Set([
  "70000", // invalid grant
  "70008", // expired
  "700082", // expired through inactivity (90 days)
  "50173", // grant revoked, e.g. the password changed
  "50076", // multi-factor sign-in required again
  "50078",
  "50079",
  "50097", // device authentication required
]);

export interface TokenErrorBody {
  error?: string;
  error_description?: string;
  error_codes?: number[];
}

/**
 * Turn a token endpoint failure into the error Belline acts on. Exported for
 * the tests, which feed it the bodies Microsoft actually sends. `grant` says
 * whether the grant was a refresh token (a refused one means reconnect) or an
 * authorization code (a refused one means try again).
 */
export function tokenFailure(status: number, data: TokenErrorBody, grant: "code" | "refresh"): Error {
  const code = aadstsCode(data.error_description) || String(data.error_codes?.[0] ?? "");
  const short = `token ${grant}: ${status} ${data.error ?? ""} AADSTS${code}`.slice(0, 300);
  const config = CONFIG_CODES[code];
  if (config) return new MicrosoftConfigError(config, code, short);
  if (data.error === "invalid_client" || data.error === "unauthorized_client") return new MicrosoftConfigError("client", code, short);
  if (grant === "refresh" && (data.error === "invalid_grant" || data.error === "interaction_required" || GRANT_CODES.has(code))) {
    return new MicrosoftAuthError(short);
  }
  return new MicrosoftApiError(status, short);
}

/** A Graph failure, as the error Belline acts on. Exported for the tests. */
export function graphFailure(status: number, text: string, what: string): Error {
  let code = "";
  let message = "";
  try {
    const data = JSON.parse(text) as { error?: { code?: string; message?: string } };
    code = data.error?.code ?? "";
    message = data.error?.message ?? "";
  } catch {
    message = text;
  }
  const short = `${what}: ${status} ${code} ${message}`.slice(0, 300);
  // Token no good, or a permission withdrawn since: only reconnecting fixes either.
  if (status === 401 || status === 403) return new MicrosoftAuthError(short);
  return new MicrosoftApiError(status, short);
}

export interface MicrosoftTokens {
  accessToken: string;
  /** Microsoft may hand back a new one on every refresh; the old one keeps working until it expires. */
  refreshToken: string;
  /** What was granted, space-separated as Microsoft returned it. */
  scope: string;
  /** Seconds the access token lasts. */
  expiresIn: number;
}

export interface OutlookCalendarEntry {
  id: string;
  name: string;
  primary: boolean;
}

export interface MicrosoftApi {
  /** Finish OAuth. Throws when Microsoft returns no refresh token. */
  exchangeCode(code: string, redirectUri: string): Promise<MicrosoftTokens>;
  /** Throws MicrosoftAuthError when the refresh token is no longer good. */
  refresh(refreshToken: string): Promise<MicrosoftTokens>;
  /** The calendars this account can add events to. */
  listCalendars(accessToken: string): Promise<OutlookCalendarEntry[]>;
}

function clientId(): string {
  return process.env.MICROSOFT_CLIENT_ID ?? "";
}
function clientSecret(): string {
  return process.env.MICROSOFT_CLIENT_SECRET ?? "";
}

async function body(res: Response): Promise<string> {
  return (await res.text().catch(() => "")).slice(0, 600);
}

async function token(params: Record<string, string>, grant: "code" | "refresh"): Promise<MicrosoftTokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId(),
      client_secret: clientSecret(),
      scope: MICROSOFT_SCOPES.join(" "),
      ...params,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as TokenErrorBody & {
    access_token?: string;
    refresh_token?: string;
    scope?: string;
    expires_in?: number;
  };
  if (!res.ok || data.error) throw tokenFailure(res.status, data, grant);
  if (!data.access_token) throw new MicrosoftApiError(res.status, `token ${grant}: no access token returned`);
  if (grant === "code" && !data.refresh_token) throw new MicrosoftApiError(res.status, "token code: no refresh token returned");
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? params.refresh_token ?? "",
    scope: data.scope ?? "",
    expiresIn: Number(data.expires_in ?? 3600),
  };
}

export async function graph(accessToken: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(path.startsWith("https://") ? path : `${GRAPH}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      // Every time Graph hands back comes in UTC, so no zone names need mapping.
      Prefer: 'outlook.timezone="UTC"',
      ...(init.headers ?? {}),
    },
  });
}

/** The real thing. Only reached when nothing was injected and stubs are off. */
export const liveMicrosoftApi: MicrosoftApi = {
  exchangeCode(code, redirectUri) {
    return token({ code, redirect_uri: redirectUri, grant_type: "authorization_code" }, "code");
  },

  refresh(refreshToken) {
    return token({ refresh_token: refreshToken, grant_type: "refresh_token" }, "refresh");
  },

  async listCalendars(accessToken) {
    const res = await graph(accessToken, "/me/calendars?$select=id,name,canEdit,isDefaultCalendar&$top=100");
    if (!res.ok) throw graphFailure(res.status, await body(res), "calendars");
    const data = (await res.json()) as { value?: { id: string; name?: string; canEdit?: boolean; isDefaultCalendar?: boolean }[] };
    return (data.value ?? [])
      .filter((c) => c.canEdit !== false)
      .map((c) => ({ id: c.id, name: c.name ?? "Calendar", primary: Boolean(c.isDefaultCalendar) }));
  },
};

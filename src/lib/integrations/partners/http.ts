import { PartnerNotConnected, type PartnerFacts, type PartnerId, partnerEnvKey } from "./contract";

/**
 * The one way a partner request leaves this process.
 *
 * Nothing here has ever run against a real partner, because no partner has
 * issued Belline a key. That is exactly why it is written in one place and
 * kept small: the day a key arrives, what has to be true is a base URL, a
 * header and a path per call, and none of it is scattered through six files.
 *
 * Rules it enforces, whatever the adapter above it asks for:
 *
 * - **No key, no request.** A missing credential throws `PartnerNotConnected`
 *   before any socket is opened, so a misconfigured deployment cannot quietly
 *   send a guest's name and telephone number to an endpoint that will refuse it.
 * - **A partner is never allowed to hang up a call.** Every request carries a
 *   timeout; a partner that does not answer in time is a partner that cannot be
 *   reached, and the agent takes a message.
 * - **Nothing personal in a URL.** Guest details go in bodies. A partner's own
 *   ids may be path segments; a name or a telephone number never is.
 * - **429 is not a failure to retry in a conversation.** It is reported as
 *   unreachable and the caller is answered honestly. Zenoti's documented 60
 *   calls a minute is not a lot when a busy evening is asking for slots.
 */

type Env = Record<string, string | undefined>;

export interface PartnerRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path only; the base URL comes from the partner's own settings. */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Beyond the auth headers the partner always needs. */
  headers?: Record<string, string>;
}

export interface PartnerTransport {
  request<T>(req: PartnerRequest): Promise<T>;
}

export class PartnerHttpError extends Error {
  readonly status: number;
  constructor(partner: PartnerId, status: number, detail: string) {
    super(`${partner} answered ${status}: ${detail}`);
    this.name = "PartnerHttpError";
    this.status = status;
  }
}

/** Ten seconds: longer than this and the caller on the line has already noticed. */
const TIMEOUT_MS = 10_000;

export interface TransportOptions {
  /** Where the partner's API lives, sandbox or live. */
  baseUrl: string;
  /** The headers that authenticate Belline. Never logged. */
  auth: Record<string, string>;
  timeoutMs?: number;
}

export function httpTransport(facts: PartnerFacts, options: TransportOptions): PartnerTransport {
  return {
    async request<T>(req: PartnerRequest): Promise<T> {
      const url = new URL(req.path.replace(/^\//, ""), options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`);
      for (const [key, value] of Object.entries(req.query ?? {})) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          method: req.method,
          headers: {
            accept: "application/json",
            ...(req.body === undefined ? {} : { "content-type": "application/json" }),
            ...options.auth,
            ...req.headers,
          },
          body: req.body === undefined ? undefined : JSON.stringify(req.body),
          signal: controller.signal,
        });
        if (!res.ok) {
          // The partner's own words are for our logs, never for a guest: the
          // agent's sentences are written in booking/partner-provider.ts.
          const text = await res.text().catch(() => "");
          throw new PartnerHttpError(facts.id, res.status, text.slice(0, 200));
        }
        if (res.status === 204) return undefined as T;
        return (await res.json()) as T;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * The base URL for this partner on this deployment.
 *
 * `PARTNER_<ID>_BASE_URL` wins where it is set — a sandbox host, or a partner
 * that gives each integrator its own. Otherwise the documented production host.
 */
export function baseUrlFor(facts: PartnerFacts, production: string, env: Env = process.env): string {
  return (env[partnerEnvKey(facts.id, "BASE_URL")] ?? "").trim() || production;
}

/** The partner key, or a refusal that never leaves the process. */
export function requireKey(facts: PartnerFacts, env: Env = process.env): string {
  const key = (env[partnerEnvKey(facts.id, "API_KEY")] ?? "").trim();
  if (!key) {
    throw new PartnerNotConnected(facts.id, `${partnerEnvKey(facts.id, "API_KEY")} is not set: ${facts.name} is not connected.`);
  }
  return key;
}

/** One of the partner's own settings, or a refusal naming what is missing. */
export function requireEnv(facts: PartnerFacts, suffix: string, env: Env = process.env): string {
  const key = partnerEnvKey(facts.id, suffix);
  const value = (env[key] ?? "").trim();
  if (!value) throw new PartnerNotConnected(facts.id, `${key} is not set: ${facts.name} is not connected.`);
  return value;
}

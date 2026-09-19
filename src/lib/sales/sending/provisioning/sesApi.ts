/**
 * The SES control plane: the calls that set a sending domain up.
 *
 * Not the data plane. `adapters/ses.ts` sends messages and this creates the
 * identity they are sent from, and they are deliberately separate modules with
 * separate credentials — the key that can create an identity and rewrite a
 * configuration set is a far more dangerous key than the one that can send a
 * message, and a deployment should not be holding the first one at all.
 *
 * Three properties, all of them the same ones the sending adapter has and for
 * the same reasons:
 *
 *  - **No credentials, no client.** `sesApi` returns a refusal naming the
 *    variables to set. There is no fallback, no stub behind the same door and
 *    no "pretend it worked".
 *  - **The `fetch` is an argument.** Which is what lets the check script run
 *    every one of these paths with the network off and prove it.
 *  - **Nothing here reads `process.env`.** Credentials arrive from the one
 *    resolver below, which is the only place that decides whether they exist.
 *
 * Every call is idempotent from the caller's side: `already` is returned
 * rather than thrown when SES says a thing exists, because the command that
 * uses this has to be safe to run twice.
 */

import { signRequest, type AwsCredentials } from "../../../aws/sigv4";

export type Env = Record<string, string | undefined>;

const TIMEOUT_MS = 20_000;

export const SES_ADMIN_KEYS = {
  accessKeyId: "OUTREACH_SES_ADMIN_ACCESS_KEY_ID",
  secretAccessKey: "OUTREACH_SES_ADMIN_SECRET_ACCESS_KEY",
  region: "OUTREACH_SES_ADMIN_REGION",
} as const;

export interface SesCallResult<T = Record<string, unknown>> {
  /** True when the call did something; false when SES said it already existed. */
  changed: boolean;
  body: T;
}

export interface SesApi {
  readonly region: string;
  getAccount(): Promise<{ sandbox: boolean; sendingEnabled: boolean; max24Hour: number | null }>;
  getIdentity(domain: string): Promise<IdentityState | null>;
  createIdentity(domain: string): Promise<SesCallResult>;
  enableDkim(domain: string): Promise<SesCallResult>;
  setMailFrom(domain: string, mailFromDomain: string): Promise<SesCallResult>;
  createConfigurationSet(name: string): Promise<SesCallResult>;
  createEventDestination(input: {
    configurationSet: string;
    name: string;
    topicArn: string;
    eventTypes: readonly string[];
  }): Promise<SesCallResult>;
  attachConfigurationSet(domain: string, configurationSet: string): Promise<SesCallResult>;
}

export interface IdentityState {
  verifiedForSending: boolean;
  dkimStatus: string | null;
  dkimTokens: string[];
  mailFromDomain: string | null;
  mailFromStatus: string | null;
  configurationSet: string | null;
}

export type SesApiResolution =
  | { ok: true; api: SesApi }
  | { ok: false; reason: string; missing: string[] };

export class SesApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "SesApiError";
  }
}

export function adminCredentials(env: Env = process.env): { credentials: AwsCredentials | null; missing: string[] } {
  const accessKeyId = env[SES_ADMIN_KEYS.accessKeyId]?.trim();
  const secretAccessKey = env[SES_ADMIN_KEYS.secretAccessKey]?.trim();
  const region = env[SES_ADMIN_KEYS.region]?.trim();
  const missing: string[] = [];
  if (!accessKeyId) missing.push(SES_ADMIN_KEYS.accessKeyId);
  if (!secretAccessKey) missing.push(SES_ADMIN_KEYS.secretAccessKey);
  if (!region) missing.push(SES_ADMIN_KEYS.region);
  if (missing.length > 0) return { credentials: null, missing };
  return { credentials: { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey!, region: region! }, missing };
}

/** Error codes that mean "it is already like that", which is not a failure. */
const ALREADY = /AlreadyExists/i;

export function sesApi(input: { env?: Env; fetchImpl?: typeof fetch; now?: () => Date; endpoint?: string } = {}): SesApiResolution {
  const { credentials, missing } = adminCredentials(input.env ?? process.env);
  if (!credentials) {
    return {
      ok: false,
      missing,
      reason:
        `No Amazon SES administrative credentials, so no domain can be set up. Set ${missing.join(", ")}. ` +
        `They are deliberately not the same keys the sender uses: this pair can create identities and ` +
        `rewrite configuration sets, and no web deployment should hold it.`,
    };
  }

  // Narrowed once, here, so the rest of the module cannot be written in a way
  // that reaches AWS with a null credential.
  const keys: AwsCredentials = credentials;
  const doFetch = input.fetchImpl ?? fetch;
  const clock = input.now ?? (() => new Date());
  const host = `email.${keys.region}.amazonaws.com`;

  async function call<T = Record<string, unknown>>(
    method: string,
    path: string,
    payload?: unknown,
  ): Promise<SesCallResult<T>> {
    const body = payload === undefined ? "" : JSON.stringify(payload);
    const request = signRequest({
      service: "ses",
      credentials: keys,
      method,
      host,
      path,
      payload: body,
      contentType: payload === undefined ? undefined : "application/json",
      now: clock(),
      endpoint: input.endpoint,
    });
    const response = await doFetch(request.url, {
      method,
      headers: request.headers,
      ...(body ? { body } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    if (response.ok) {
      return { changed: true, body: (text ? JSON.parse(text) : {}) as T };
    }
    let code = `http_${response.status}`;
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { __type?: string; message?: string; Message?: string };
      if (parsed.__type) code = parsed.__type.split("#").pop() ?? code;
      detail = parsed.message ?? parsed.Message ?? detail;
    } catch {
      // Left as the raw text.
    }
    if (ALREADY.test(code)) return { changed: false, body: {} as T };
    throw new SesApiError(`SES refused ${method} ${path} (${code}): ${detail}`, response.status, code);
  }

  const encode = (value: string) => encodeURIComponent(value);

  return {
    ok: true,
    api: {
      region: keys.region,

      async getAccount() {
        const { body } = await call<{
          ProductionAccessEnabled?: boolean;
          SendingEnabled?: boolean;
          SendQuota?: { Max24HourSend?: number };
        }>("GET", "/v2/email/account");
        return {
          sandbox: body.ProductionAccessEnabled !== true,
          sendingEnabled: body.SendingEnabled === true,
          max24Hour: body.SendQuota?.Max24HourSend ?? null,
        };
      },

      async getIdentity(domain) {
        try {
          const { body } = await call<{
            VerifiedForSendingStatus?: boolean;
            DkimAttributes?: { Status?: string; Tokens?: string[] };
            MailFromAttributes?: { MailFromDomain?: string; MailFromDomainStatus?: string };
            ConfigurationSetName?: string;
          }>("GET", `/v2/email/identities/${encode(domain)}`);
          return {
            verifiedForSending: body.VerifiedForSendingStatus === true,
            dkimStatus: body.DkimAttributes?.Status ?? null,
            dkimTokens: body.DkimAttributes?.Tokens ?? [],
            mailFromDomain: body.MailFromAttributes?.MailFromDomain ?? null,
            mailFromStatus: body.MailFromAttributes?.MailFromDomainStatus ?? null,
            configurationSet: body.ConfigurationSetName ?? null,
          };
        } catch (err) {
          // Not found is an answer, not a failure: it is how the command knows
          // this is a first run rather than a second one.
          if (err instanceof SesApiError && (err.status === 404 || /NotFound/i.test(err.code))) return null;
          throw err;
        }
      },

      createIdentity(domain) {
        return call("POST", "/v2/email/identities", {
          EmailIdentity: domain,
          // Easy DKIM with AWS-managed 2048-bit keys: the tokens SES returns
          // are the three CNAMEs a person has to add, and nothing about the
          // private half ever leaves AWS.
          DkimSigningAttributes: { NextSigningKeyLength: "RSA_2048_BIT" },
        });
      },

      enableDkim(domain) {
        return call("PUT", `/v2/email/identities/${encode(domain)}/dkim`, { SigningEnabled: true });
      },

      setMailFrom(domain, mailFromDomain) {
        return call("PUT", `/v2/email/identities/${encode(domain)}/mail-from`, {
          MailFromDomain: mailFromDomain,
          // `UseDefaultValue`, not `RejectMessage`: if the MAIL FROM MX record
          // is ever removed, mail falls back to amazonses.com rather than
          // stopping. A silent SPF downgrade is bad; a silent total outage of
          // the sending pipeline is worse.
          BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
        });
      },

      createConfigurationSet(name) {
        return call("POST", "/v2/email/configuration-sets", {
          ConfigurationSetName: name,
          ReputationOptions: { ReputationMetricsEnabled: true },
          SendingOptions: { SendingEnabled: true },
        });
      },

      createEventDestination({ configurationSet, name, topicArn, eventTypes }) {
        return call("POST", `/v2/email/configuration-sets/${encode(configurationSet)}/event-destinations`, {
          EventDestinationName: name,
          EventDestination: {
            Enabled: true,
            MatchingEventTypes: [...eventTypes],
            SnsDestination: { TopicArn: topicArn },
          },
        });
      },

      attachConfigurationSet(domain, configurationSet) {
        return call("PUT", `/v2/email/identities/${encode(domain)}/configuration-set`, {
          ConfigurationSetName: configurationSet,
        });
      },
    },
  };
}

/** The events a cold-mail configuration set has to hear about. */
export const EVENT_TYPES = ["BOUNCE", "COMPLAINT", "DELIVERY", "REJECT"] as const;

/**
 * The sending adapter.
 *
 * One interface, so the engine never names a provider; and a resolver that is
 * the single door between this codebase and anything that can put a message in
 * a stranger's inbox. Everything else in `sending/` takes an adapter as an
 * argument, which is what makes the tests able to prove that no path reaches a
 * real provider.
 *
 * Two rules are enforced here rather than remembered:
 *
 *  1. **No credentials, no adapter.** With nothing configured the resolver
 *     returns a refusal carrying the names of the missing variables, and the
 *     whole engine reports itself inert. It does not fall back to a stub, to
 *     a log line, or to "pretend it worked" — each of which is a way to
 *     discover months later that nothing ever sent, or that everything did.
 *
 *  2. **Resend is refused for cold mail.** Resend carries belline.ai's
 *     transactional email — verification codes, password resets, booking
 *     confirmations, demo links customers asked for. A cold list shares a
 *     reputation with whatever else goes out on the same credentials, and the
 *     one thing that must never happen is a customer's booking confirmation
 *     landing in spam because a prospecting domain got complained about. So
 *     the refusal is in code, with the reason attached.
 */

import type { LegalIdentity } from "../../legal/identity";

export interface OutboundEmail {
  /** The mailbox this leaves from, e.g. `andreas@try-belline.com`. */
  from: string;
  fromName: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  /**
   * The `Message-ID` to send under, without angle brackets.
   *
   * Supplied by the dispatcher rather than invented by the adapter, because it
   * is stored against the send item first: a reply quoting it has to find a row
   * that already exists. An adapter that minted its own would mean every reply
   * arriving in the seconds after a send was unattributable.
   */
  messageId?: string;
  /**
   * Headers the engine insists on: `List-Unsubscribe`,
   * `List-Unsubscribe-Post`. The adapter must send them verbatim or fail.
   */
  headers: Record<string, string>;
  /** Correlates a provider event back to a send item. */
  tags?: Record<string, string>;
}

export interface SendReceipt {
  providerMessageId: string;
  provider: string;
}

export interface SendAdapter {
  readonly name: string;
  /** The sending domain these credentials belong to. */
  readonly domain: string;
  send(message: OutboundEmail): Promise<SendReceipt>;
}

export type AdapterResolution =
  | { ok: true; adapter: SendAdapter; provider: string }
  | { ok: false; provider: string; reason: string; missing: string[] };

export type Env = Record<string, string | undefined>;

/**
 * Providers that exist in this codebase but may not carry cold mail.
 *
 * Named rather than merely omitted, so asking for one gets an explanation
 * instead of "unknown provider" — the next person to wonder why Resend is not
 * an option finds the answer at the point they ask.
 */
export const REFUSED_PROVIDERS: Record<string, string> = {
  resend:
    "Resend carries belline.ai's transactional email — verification codes, password resets, booking " +
    "confirmations and the demo links customers asked for. Cold outreach must never share a sending " +
    "reputation with it: one complaint rate ruining the other is not a risk worth any convenience. " +
    "Use a separate lookalike domain on Amazon SES.",
};

export const SUPPORTED_PROVIDERS = ["ses"] as const;
export type ProviderName = (typeof SUPPORTED_PROVIDERS)[number];

/**
 * The environment variables a domain's credentials live under.
 *
 * Per sending domain, because the whole point of separate domains is separate
 * reputations, and shared credentials make it one blast radius again. The
 * unsuffixed names are a fallback for a founder running a single domain, not
 * the intended shape.
 */
export function credentialKeys(domain: string): {
  accessKeyId: string[];
  secretAccessKey: string[];
  region: string[];
  configurationSet: string[];
} {
  const slug = domain.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "");
  return {
    accessKeyId: [`OUTREACH_SES_${slug}_ACCESS_KEY_ID`, "OUTREACH_SES_ACCESS_KEY_ID"],
    secretAccessKey: [`OUTREACH_SES_${slug}_SECRET_ACCESS_KEY`, "OUTREACH_SES_SECRET_ACCESS_KEY"],
    region: [`OUTREACH_SES_${slug}_REGION`, "OUTREACH_SES_REGION"],
    configurationSet: [`OUTREACH_SES_${slug}_CONFIGURATION_SET`, "OUTREACH_SES_CONFIGURATION_SET"],
  };
}

function pick(env: Env, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

export interface CredentialCheck {
  ready: boolean;
  /** The variable names a person has to set, in the per-domain form. */
  missing: string[];
  region?: string;
  configurationSet?: string;
}

/** What is and is not configured for this domain, without reading a secret out. */
export function credentialState(domain: string, env: Env = process.env): CredentialCheck {
  const keys = credentialKeys(domain);
  const missing: string[] = [];
  const accessKeyId = pick(env, keys.accessKeyId);
  const secretAccessKey = pick(env, keys.secretAccessKey);
  const region = pick(env, keys.region);
  if (!accessKeyId) missing.push(keys.accessKeyId[0]);
  if (!secretAccessKey) missing.push(keys.secretAccessKey[0]);
  if (!region) missing.push(keys.region[0]);
  return {
    ready: missing.length === 0,
    missing,
    region,
    configurationSet: pick(env, keys.configurationSet),
  };
}

/**
 * A stub adapter, for tests and for a local run with `FLAG_STUBS=on`.
 *
 * It is never reachable from `resolveAdapter`. Handing it out from the same
 * door the real one comes through is how a stub ends up in production with
 * everybody believing mail is going out; so a caller that wants the stub has
 * to import it by name and pass it in, which is visible in a diff.
 */
export interface StubAdapter extends SendAdapter {
  readonly sent: OutboundEmail[];
  reset(): void;
}

export function stubAdapter(domain = "stub.invalid"): StubAdapter {
  const sent: OutboundEmail[] = [];
  return {
    name: "stub",
    domain,
    sent,
    reset() {
      sent.length = 0;
    },
    async send(message) {
      sent.push(message);
      return { providerMessageId: `stub-${sent.length}`, provider: "stub" };
    },
  };
}

export interface ResolveInput {
  domain: string;
  provider: string;
  env?: Env;
  /**
   * Injected by the SES module to avoid a cycle. Production callers use
   * `resolveAdapter` from `./adapters`, which wires this for them.
   */
  makeSes: (input: {
    domain: string;
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
    configurationSet?: string;
  }) => SendAdapter;
}

/**
 * The only way to get something that can send.
 *
 * Returns a refusal — never throws, never a stub — when the provider is
 * refused, unknown, or unconfigured.
 */
export function resolveAdapter(input: ResolveInput): AdapterResolution {
  const env = input.env ?? process.env;
  const provider = input.provider.trim().toLowerCase();

  const refused = REFUSED_PROVIDERS[provider];
  if (refused) return { ok: false, provider, reason: refused, missing: [] };

  if (provider !== "ses") {
    return {
      ok: false,
      provider,
      reason: `"${provider}" is not a sending provider this engine knows. Supported: ${SUPPORTED_PROVIDERS.join(", ")}.`,
      missing: [],
    };
  }

  const keys = credentialKeys(input.domain);
  const state = credentialState(input.domain, env);
  if (!state.ready) {
    return {
      ok: false,
      provider,
      reason:
        `No Amazon SES credentials for ${input.domain}, so nothing can be sent from it. ` +
        `Set ${state.missing.join(", ")}.`,
      missing: state.missing,
    };
  }

  return {
    ok: true,
    provider,
    adapter: input.makeSes({
      domain: input.domain,
      accessKeyId: pick(env, keys.accessKeyId)!,
      secretAccessKey: pick(env, keys.secretAccessKey)!,
      region: state.region!,
      configurationSet: state.configurationSet,
    }),
  };
}

/** Header names the engine will not send a message without. */
export const REQUIRED_HEADERS = ["List-Unsubscribe", "List-Unsubscribe-Post"] as const;

/**
 * The last check before a message is handed to a provider.
 *
 * Belt and braces: the compliance gate has already run, but this is the point
 * at which the bytes leave, and a message without a one-click unsubscribe is
 * one this process must not be able to emit whatever else went wrong upstream.
 */
export function assertSendable(message: OutboundEmail, identity: LegalIdentity): void {
  for (const header of REQUIRED_HEADERS) {
    if (!message.headers[header]?.trim()) {
      throw new Error(`refusing to send: ${header} is missing`);
    }
  }
  if (!message.to.includes("@")) throw new Error("refusing to send: recipient is not an address");
  if (!message.from.includes("@")) throw new Error("refusing to send: sender is not an address");
  const address = identity.address?.trim();
  if (!address) throw new Error("refusing to send: no postal sender identity");
  if (!message.text.includes(address)) {
    throw new Error("refusing to send: the body does not carry the postal sender identity");
  }
}

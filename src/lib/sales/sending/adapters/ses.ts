/**
 * Amazon SES, over the v2 API, signed by hand.
 *
 * By hand because the repository has no AWS SDK and pulling one in for one
 * signed POST is a hundred megabytes and a supply chain for something
 * `node:crypto` does in forty lines. SigV4 is fiddly but it is specified, and
 * `check:outreach-engine` pins the canonical request against a known vector so
 * a future edit cannot quietly break the signature and be discovered by a
 * production 403.
 *
 * SendEmail is called with **raw** content rather than simple content, because
 * the engine must set `List-Unsubscribe` and `List-Unsubscribe-Post` and the
 * simple form cannot carry arbitrary headers. Raw content means this module
 * assembles the MIME itself.
 *
 * Nothing in this file reads `process.env`. Credentials arrive as arguments
 * from `resolveAdapter`, which is the only place that decides whether they
 * exist — so there is no path by which a missing variable becomes an
 * unauthenticated call rather than a refusal.
 */

import crypto from "node:crypto";
import {
  amzDates,
  canonicalRequest as sigv4Canonical,
  sha256Hex,
  sigv4Authorization as sigv4Sign,
  type CanonicalInput as Sigv4CanonicalInput,
} from "../../../aws/sigv4";
import type { OutboundEmail, SendAdapter, SendReceipt } from "../provider";

export interface SesConfig {
  domain: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  /** An SES configuration set, which is how bounce and complaint events reach us. */
  configurationSet?: string;
  /** Overridable so the check script can point at a local server if it ever needs to. */
  endpoint?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

const SERVICE = "ses";
const SEND_TIMEOUT_MS = 15_000;

/**
 * The signer moved to `src/lib/aws/sigv4.ts` when a second and third caller
 * appeared — reading inbound mail out of S3, and the SES control-plane calls
 * that set a sending domain up. These wrappers keep this module's own surface
 * and its pinned test vector exactly as they were, including the default
 * content type, which is part of the signature.
 */
export type CanonicalInput = Omit<Sigv4CanonicalInput, "contentType"> & { contentType?: string };
export type SignInput = CanonicalInput & {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  dateStamp: string;
};

export function canonicalRequest(input: CanonicalInput): { canonical: string; signedHeaders: string } {
  return sigv4Canonical({ ...input, contentType: input.contentType ?? "application/json" });
}

export function sigv4Authorization(input: SignInput): string {
  return sigv4Sign({ ...input, service: SERVICE, contentType: input.contentType ?? "application/json" });
}

export { amzDates, sha256Hex };

/** RFC 2047 for a display name that is not plain ASCII. */
function encodeWord(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(value) && !/[",:;<>@]/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function boundary(): string {
  return `bl_${crypto.randomBytes(12).toString("hex")}`;
}

function foldBase64(value: string): string {
  return (value.match(/.{1,76}/g) ?? []).join("\r\n");
}

/**
 * The raw MIME message.
 *
 * `text/plain` alone when there is no HTML part, which is the usual case: the
 * cold email is deliberately shaped like something a person typed, and a
 * multipart message with a single tracked image is the fastest way to be filed
 * as bulk. The video-demo mail does carry a thumbnail, so multipart/alternative
 * is there when it is needed.
 */
export function buildMime(message: OutboundEmail, messageId: string): string {
  const lines: string[] = [];
  const push = (name: string, value: string) => lines.push(`${name}: ${value}`);

  push("From", `${encodeWord(message.fromName)} <${message.from}>`);
  push("To", message.to);
  if (message.replyTo) push("Reply-To", message.replyTo);
  push("Subject", encodeWord(message.subject));
  push("Message-ID", `<${messageId}>`);
  push("MIME-Version", "1.0");
  for (const [name, value] of Object.entries(message.headers)) {
    // A header value with a newline in it is header injection, and the only
    // place these strings come from is our own token minting — but the cost of
    // being wrong about that is an attacker-controlled Bcc.
    if (/[\r\n]/.test(value)) throw new Error(`refusing to send: header ${name} contains a newline`);
    push(name, value);
  }

  const text = message.text.replace(/\r?\n/g, "\r\n");

  if (!message.html) {
    push("Content-Type", 'text/plain; charset="UTF-8"');
    push("Content-Transfer-Encoding", "base64");
    return `${lines.join("\r\n")}\r\n\r\n${foldBase64(Buffer.from(text, "utf8").toString("base64"))}\r\n`;
  }

  const mark = boundary();
  push("Content-Type", `multipart/alternative; boundary="${mark}"`);
  const html = message.html.replace(/\r?\n/g, "\r\n");
  const body = [
    `--${mark}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    foldBase64(Buffer.from(text, "utf8").toString("base64")),
    `--${mark}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    foldBase64(Buffer.from(html, "utf8").toString("base64")),
    `--${mark}--`,
    "",
  ].join("\r\n");

  return `${lines.join("\r\n")}\r\n\r\n${body}`;
}

/**
 * Errors SES gives that mean "stop", as against "try again".
 *
 * A throttle is worth a retry. An address SES will not send to, or an account
 * in the sandbox, is not — retrying it burns reputation and hides the problem.
 */
export class SesRefusal extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly code: string,
  ) {
    super(message);
    this.name = "SesRefusal";
  }
}

export function sesAdapter(config: SesConfig): SendAdapter {
  const doFetch = config.fetchImpl ?? fetch;
  const now = config.now ?? (() => new Date());
  const host = new URL(config.endpoint ?? `https://email.${config.region}.amazonaws.com`).host;
  const origin = config.endpoint ?? `https://email.${config.region}.amazonaws.com`;
  const path = "/v2/email/outbound-emails";

  return {
    name: "ses",
    domain: config.domain,
    async send(message: OutboundEmail): Promise<SendReceipt> {
      // The dispatcher's id when it gave one, so a reply can be threaded back
      // to a row that already exists; a random one only as a last resort.
      const localId = message.messageId ?? `${crypto.randomUUID()}@${config.domain}`;
      const raw = buildMime(message, localId);
      const payload = JSON.stringify({
        Content: { Raw: { Data: Buffer.from(raw, "utf8").toString("base64") } },
        FromEmailAddress: `${encodeWord(message.fromName)} <${message.from}>`,
        Destination: { ToAddresses: [message.to] },
        ...(config.configurationSet ? { ConfigurationSetName: config.configurationSet } : {}),
        ...(message.tags
          ? {
              EmailTags: Object.entries(message.tags).map(([Name, Value]) => ({
                Name,
                // SES tag values are [A-Za-z0-9_-] only, and a rejected tag
                // rejects the whole send.
                Value: Value.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 256),
              })),
            }
          : {}),
      });

      const { amzDate, dateStamp } = amzDates(now());
      const authorization = sigv4Authorization({
        method: "POST",
        path,
        host,
        amzDate,
        dateStamp,
        payload,
        region: config.region,
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      });

      const response = await doFetch(`${origin}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host,
          "x-amz-date": amzDate,
          "x-amz-content-sha256": sha256Hex(payload),
          authorization,
        },
        body: payload,
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });

      const body = await response.text();
      if (!response.ok) {
        let code = `http_${response.status}`;
        try {
          const parsed = JSON.parse(body) as { __type?: string; message?: string; Message?: string };
          if (parsed.__type) code = parsed.__type.split("#").pop() ?? code;
          throw new SesRefusal(
            `SES refused the message (${code}): ${parsed.message ?? parsed.Message ?? body.slice(0, 300)}`,
            response.status === 429 || response.status >= 500 || /Throttl/i.test(code),
            code,
          );
        } catch (err) {
          if (err instanceof SesRefusal) throw err;
          throw new SesRefusal(
            `SES refused the message (${code}): ${body.slice(0, 300)}`,
            response.status === 429 || response.status >= 500,
            code,
          );
        }
      }

      const parsed = JSON.parse(body) as { MessageId?: string };
      return { providerMessageId: parsed.MessageId ?? localId, provider: "ses" };
    },
  };
}

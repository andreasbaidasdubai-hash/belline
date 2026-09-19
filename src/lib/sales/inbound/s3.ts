/**
 * Reading a raw inbound message out of S3.
 *
 * The SNS receipt action can carry the whole message inside the notification,
 * but only up to 150 KB — and a reply with a signature image or a forwarded
 * thread goes past that without anybody doing anything unusual. AWS's own
 * recommendation is therefore the S3 action: the rule writes the message to a
 * bucket and the notification carries a pointer. This is the fetch for that
 * pointer.
 *
 * The same rule as the sending adapter applies and for the same reason: **no
 * credentials, no client**. `s3Reader` returns a refusal carrying the names of
 * the variables to set, never a stub and never an unauthenticated call. A
 * fetch that silently failed here would mean replies arriving, being
 * unreadable, and being filed as nothing — which looks exactly like nobody
 * replying.
 */

import { signRequest, uriEncode, type AwsCredentials } from "../../aws/sigv4";

export type Env = Record<string, string | undefined>;

const READ_TIMEOUT_MS = 20_000;
/** Bigger than any reply worth parsing, small enough that one cannot exhaust us. */
export const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;

export const S3_CREDENTIAL_KEYS = {
  accessKeyId: "OUTREACH_INBOUND_ACCESS_KEY_ID",
  secretAccessKey: "OUTREACH_INBOUND_SECRET_ACCESS_KEY",
  region: "OUTREACH_INBOUND_REGION",
} as const;

export interface S3Reader {
  get(bucket: string, key: string): Promise<string>;
}

export type S3Resolution =
  | { ok: true; reader: S3Reader }
  | { ok: false; reason: string; missing: string[] };

export function inboundCredentials(env: Env = process.env): { credentials: AwsCredentials | null; missing: string[] } {
  const accessKeyId = env[S3_CREDENTIAL_KEYS.accessKeyId]?.trim();
  const secretAccessKey = env[S3_CREDENTIAL_KEYS.secretAccessKey]?.trim();
  const region = env[S3_CREDENTIAL_KEYS.region]?.trim();
  const missing: string[] = [];
  if (!accessKeyId) missing.push(S3_CREDENTIAL_KEYS.accessKeyId);
  if (!secretAccessKey) missing.push(S3_CREDENTIAL_KEYS.secretAccessKey);
  if (!region) missing.push(S3_CREDENTIAL_KEYS.region);
  if (missing.length > 0) return { credentials: null, missing };
  return { credentials: { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey!, region: region! }, missing };
}

/**
 * The only way to get something that can read from S3.
 *
 * Takes its `fetch` as an argument so the check scripts can exercise every
 * path with the network off.
 */
export function s3Reader(input: { env?: Env; fetchImpl?: typeof fetch; now?: () => Date } = {}): S3Resolution {
  const { credentials, missing } = inboundCredentials(input.env ?? process.env);
  if (!credentials) {
    return {
      ok: false,
      missing,
      reason:
        `No AWS credentials for reading inbound mail out of S3, so a message stored there cannot be read. ` +
        `Set ${missing.join(", ")}.`,
    };
  }
  const doFetch = input.fetchImpl ?? fetch;
  const now = input.now ?? (() => new Date());

  return {
    ok: true,
    reader: {
      async get(bucket, key) {
        const host = `${bucket}.s3.${credentials.region}.amazonaws.com`;
        const request = signRequest({
          service: "s3",
          credentials,
          method: "GET",
          host,
          // Each segment encoded, the separators kept: an SES object key is
          // `inbound/<messageId>` and a future prefix may hold anything.
          path: `/${key.split("/").map((s) => uriEncode(s)).join("/")}`,
          now: now(),
        });
        const response = await doFetch(request.url, {
          method: "GET",
          headers: request.headers,
          signal: AbortSignal.timeout(READ_TIMEOUT_MS),
        });
        if (!response.ok) {
          throw new Error(`S3 refused to read s3://${bucket}/${key} (HTTP ${response.status})`);
        }
        const length = Number(response.headers.get("content-length") ?? "0");
        if (length > MAX_MESSAGE_BYTES) {
          throw new Error(`s3://${bucket}/${key} is ${length} bytes, past the ${MAX_MESSAGE_BYTES} limit`);
        }
        const text = await response.text();
        return text.slice(0, MAX_MESSAGE_BYTES);
      },
    },
  };
}

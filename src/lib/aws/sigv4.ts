/**
 * AWS Signature Version 4, by hand.
 *
 * By hand for the reason the SES adapter gave first: the repository has no AWS
 * SDK, and pulling one in is a hundred megabytes and a supply chain for
 * something `node:crypto` does in sixty lines. This file is that code, lifted
 * out of the SES adapter once a second and a third caller appeared — reading a
 * raw inbound message out of S3, and the SES control-plane calls that set a
 * sending domain up.
 *
 * Every exported function is pure. Nothing here reads `process.env`, opens a
 * socket or knows what a credential is: callers pass keys in, which is what
 * makes it possible for a test to prove that no code path reaches AWS without
 * somebody having explicitly supplied credentials.
 */

import crypto from "node:crypto";

export function sha256Hex(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hmac(key: Buffer | string, value: string): Buffer {
  return crypto.createHmac("sha256", key).update(value, "utf8").digest();
}

/** `20260918T101530Z` and `20260918`, the two forms SigV4 wants. */
export function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

/**
 * Percent-encoding as SigV4 defines it, which is not `encodeURIComponent`.
 *
 * The difference is `!'()*`, which `encodeURIComponent` leaves alone and AWS
 * expects encoded, and `/`, which must survive in a path but not in a query
 * value. A key with a bracket in it — which S3 keys from SES do not have, but
 * a future caller's might — is a 403 that looks like a wrong secret.
 */
export function uriEncode(value: string, encodeSlash = true): string {
  return value
    .split("")
    .map((c) => {
      if (/[A-Za-z0-9\-._~]/.test(c)) return c;
      if (c === "/" && !encodeSlash) return c;
      return [...Buffer.from(c, "utf8")].map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join("");
    })
    .join("");
}

export interface CanonicalInput {
  method: string;
  /** Already-encoded path, beginning with `/`. */
  path: string;
  host: string;
  amzDate: string;
  payload: string;
  contentType?: string;
  /** Sorted `a=b&c=d`, or empty. */
  query?: string;
  /** Extra headers to sign, lower-cased names. */
  extraHeaders?: Record<string, string>;
}

/** The canonical request, exposed so it can be tested against a fixed vector. */
export function canonicalRequest(input: CanonicalInput): { canonical: string; signedHeaders: string } {
  const payloadHash = sha256Hex(input.payload);
  const headers: [string, string][] = [
    ...(input.contentType === undefined ? [] : ([["content-type", input.contentType]] as [string, string][])),
    ["host", input.host],
    ["x-amz-content-sha256", payloadHash],
    ["x-amz-date", input.amzDate],
    ...Object.entries(input.extraHeaders ?? {}).map(([k, v]) => [k.toLowerCase(), v] as [string, string]),
  ];
  headers.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const canonicalHeaders = headers.map(([k, v]) => `${k}:${v.trim()}\n`).join("");
  const signedHeaders = headers.map(([k]) => k).join(";");
  const canonical = [input.method, input.path, input.query ?? "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  return { canonical, signedHeaders };
}

export interface SignInput extends CanonicalInput {
  service: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  dateStamp: string;
}

/** The finished `Authorization` header value. */
export function sigv4Authorization(input: SignInput): string {
  const { canonical, signedHeaders } = canonicalRequest(input);
  const scope = `${input.dateStamp}/${input.region}/${input.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", input.amzDate, scope, sha256Hex(canonical)].join("\n");

  let key = hmac(`AWS4${input.secretAccessKey}`, input.dateStamp);
  key = hmac(key, input.region);
  key = hmac(key, input.service);
  key = hmac(key, "aws4_request");
  const signature = crypto.createHmac("sha256", key).update(toSign, "utf8").digest("hex");

  return (
    `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`
  );
}

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

export interface SignedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/**
 * Everything a `fetch` needs for one signed call.
 *
 * Returned rather than performed, so the caller supplies the `fetch` — which
 * is how the check scripts run every one of these paths with no network at
 * all.
 */
export function signRequest(input: {
  service: string;
  credentials: AwsCredentials;
  method: string;
  host: string;
  path: string;
  query?: string;
  payload?: string;
  contentType?: string;
  now?: Date;
  endpoint?: string;
}): SignedRequest {
  const payload = input.payload ?? "";
  const { amzDate, dateStamp } = amzDates(input.now ?? new Date());
  const authorization = sigv4Authorization({
    service: input.service,
    method: input.method,
    path: input.path,
    query: input.query,
    host: input.host,
    amzDate,
    dateStamp,
    payload,
    contentType: input.contentType,
    region: input.credentials.region,
    accessKeyId: input.credentials.accessKeyId,
    secretAccessKey: input.credentials.secretAccessKey,
  });
  const origin = input.endpoint ?? `https://${input.host}`;
  return {
    url: `${origin}${input.path}${input.query ? `?${input.query}` : ""}`,
    method: input.method,
    headers: {
      ...(input.contentType ? { "content-type": input.contentType } : {}),
      host: input.host,
      "x-amz-date": amzDate,
      "x-amz-content-sha256": sha256Hex(payload),
      authorization,
    },
    ...(input.method === "GET" || input.method === "HEAD" ? {} : { body: payload }),
  };
}

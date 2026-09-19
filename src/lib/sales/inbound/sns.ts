/**
 * Amazon SNS notifications, verified.
 *
 * The endpoint that takes inbound mail is a public URL. Anyone who finds it can
 * POST to it, and what they would be POSTing is "this lead replied" — which
 * stops a sequence, writes to a lead's timeline and, with the right words,
 * suppresses a company permanently. So the signature is not a formality; it is
 * the only thing standing between a stranger and our sales pipeline.
 *
 * Four checks, and all four have to pass:
 *
 *  1. **The signature verifies** against the certificate SNS names, using the
 *     canonical string AWS specifies for that message type.
 *  2. **The certificate came from AWS.** The URL is in the message, so it is
 *     attacker-controlled; without pinning the host to `sns.<region>.
 *     amazonaws.com` an attacker signs with their own key and points us at
 *     their own certificate, and the signature check passes perfectly.
 *  3. **The topic is ours.** A valid AWS signature is not the same as a
 *     message from our account.
 *  4. **It is recent.** A replayed notification from last month must not
 *     re-stop a sequence somebody has since restarted.
 *
 * Nothing in this file reaches the network on its own: the certificate fetcher
 * is an argument. The default one is wired up in the route.
 */

import crypto from "node:crypto";

export type SnsType = "Notification" | "SubscriptionConfirmation" | "UnsubscribeConfirmation";

export interface SnsEnvelope {
  Type: SnsType;
  MessageId: string;
  TopicArn: string;
  Subject?: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL?: string;
  SigningCertUrl?: string;
  Token?: string;
  SubscribeURL?: string;
}

export type CertFetcher = (url: string) => Promise<string>;

export interface VerifyInput {
  envelope: SnsEnvelope;
  /** The topic ARNs this endpoint accepts. Empty means "refuse everything". */
  allowedTopics: readonly string[];
  fetchCert: CertFetcher;
  now?: Date;
  /** How old a notification may be. Fifteen minutes, as for AWS request signing. */
  maxAgeMs?: number;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

const DEFAULT_MAX_AGE_MS = 15 * 60_000;

/**
 * The fields AWS signs, per message type, in the order it signs them.
 *
 * Fixed lists rather than "every field present": signing whatever happens to
 * be in the JSON means an attacker can change the canonical string by adding
 * or removing a key, which is the classic way a signature check is bypassed
 * while appearing to work.
 */
const SIGNED_FIELDS: Record<SnsType, string[]> = {
  Notification: ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"],
  SubscriptionConfirmation: ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"],
  UnsubscribeConfirmation: ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"],
};

export function canonicalString(envelope: SnsEnvelope): string {
  const fields = SIGNED_FIELDS[envelope.Type];
  if (!fields) throw new Error(`unknown SNS message type ${envelope.Type}`);
  let out = "";
  for (const field of fields) {
    const value = (envelope as unknown as Record<string, string | undefined>)[field];
    // Subject is the only optional one, and it is omitted entirely rather than
    // signed as an empty string.
    if (value === undefined || value === null) continue;
    out += `${field}\n${value}\n`;
  }
  return out;
}

/**
 * Is this URL somewhere AWS would actually host a certificate.
 *
 * `https`, and a host that is exactly `sns.<region>.amazonaws.com` or the
 * China partition's equivalent. Not "contains amazonaws.com", which
 * `https://sns.amazonaws.com.attacker.test/` satisfies.
 */
export function certUrlIsAws(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  return /^sns\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/.test(parsed.hostname);
}

export async function verifySns(input: VerifyInput): Promise<VerifyResult> {
  const { envelope } = input;
  const now = input.now ?? new Date();

  if (!SIGNED_FIELDS[envelope.Type]) return { ok: false, reason: `unknown message type ${envelope.Type}` };
  if (input.allowedTopics.length === 0) {
    return {
      ok: false,
      reason:
        "no inbound SNS topic is configured, so nothing can be accepted. Set OUTREACH_INBOUND_SNS_TOPIC_ARN.",
    };
  }
  if (!input.allowedTopics.includes(envelope.TopicArn)) {
    return { ok: false, reason: `topic ${envelope.TopicArn} is not one this endpoint accepts` };
  }

  const age = now.getTime() - Date.parse(envelope.Timestamp);
  if (!Number.isFinite(age)) return { ok: false, reason: "no usable Timestamp" };
  if (age > (input.maxAgeMs ?? DEFAULT_MAX_AGE_MS)) {
    return { ok: false, reason: `notification is ${Math.round(age / 60_000)} minutes old` };
  }
  // A little tolerance the other way for clock skew, and no more: a timestamp
  // far in the future is a replay dressed up to outlive the age check.
  if (age < -5 * 60_000) return { ok: false, reason: "notification is timestamped in the future" };

  const certUrl = envelope.SigningCertURL ?? envelope.SigningCertUrl;
  if (!certUrl || !certUrlIsAws(certUrl)) {
    return { ok: false, reason: `signing certificate URL is not an AWS one: ${certUrl ?? "(missing)"}` };
  }

  const algorithm = envelope.SignatureVersion === "2" ? "RSA-SHA256" : "RSA-SHA1";
  if (envelope.SignatureVersion !== "1" && envelope.SignatureVersion !== "2") {
    return { ok: false, reason: `unsupported SignatureVersion ${envelope.SignatureVersion}` };
  }

  let pem: string;
  try {
    pem = await input.fetchCert(certUrl);
  } catch (err) {
    return { ok: false, reason: `could not fetch the signing certificate: ${(err as Error).message}` };
  }

  try {
    const verifier = crypto.createVerify(algorithm);
    verifier.update(canonicalString(envelope), "utf8");
    if (!verifier.verify(new crypto.X509Certificate(pem).publicKey, envelope.Signature, "base64")) {
      return { ok: false, reason: "signature does not verify" };
    }
  } catch (err) {
    return { ok: false, reason: `signature could not be checked: ${(err as Error).message}` };
  }

  return { ok: true };
}

/**
 * A certificate fetcher with a cache.
 *
 * SNS rotates its signing certificate rarely and sends thousands of
 * notifications between rotations; fetching the same PEM for every inbound
 * message would add a round trip to AWS on the critical path of a webhook
 * that has to answer quickly.
 */
export function cachingCertFetcher(fetchImpl: typeof fetch = fetch, ttlMs = 6 * 3_600_000): CertFetcher {
  const cache = new Map<string, { pem: string; at: number }>();
  return async (url: string) => {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < ttlMs) return hit.pem;
    // Re-checked here as well as in `verifySns`. This function is exported and
    // a future caller that forgets the check would otherwise fetch whatever
    // URL an attacker put in the message.
    if (!certUrlIsAws(url)) throw new Error("refusing to fetch a certificate from a non-AWS host");
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const pem = await response.text();
    cache.set(url, { pem, at: Date.now() });
    return pem;
  };
}

// ---------------------------------------------------------------------------
// What SES puts inside the notification
// ---------------------------------------------------------------------------

export interface SesInboundNotification {
  notificationType?: string;
  /** Present when the receipt rule used the SNS action: the whole raw message. */
  content?: string;
  mail?: {
    messageId?: string;
    timestamp?: string;
    source?: string;
    destination?: string[];
    commonHeaders?: { from?: string[]; to?: string[]; subject?: string; messageId?: string };
  };
  receipt?: {
    recipients?: string[];
    spamVerdict?: { status?: string };
    virusVerdict?: { status?: string };
    spfVerdict?: { status?: string };
    dkimVerdict?: { status?: string };
    dmarcVerdict?: { status?: string };
    action?: { type?: string; bucketName?: string; objectKey?: string; encoding?: string };
  };
}

export interface InboundPayload {
  /** SES's own id for the message. The idempotency key. */
  sesMessageId: string;
  /** The raw RFC822 message, when the notification carried it. */
  raw: string | null;
  /** Where to read it from instead, when the rule wrote it to S3. */
  s3: { bucket: string; key: string } | null;
  recipients: string[];
  /** SES's verdicts, so an obvious spam or virus can be dropped rather than filed. */
  spam: boolean;
  virus: boolean;
  receivedAt: string | null;
}

/**
 * Pull the useful parts out of an SES receipt notification.
 *
 * Returns null for anything that is not one — SES sends bounce and complaint
 * notifications down configuration-set topics with the same envelope shape,
 * and those are handled by a different path.
 */
export function parseSesNotification(message: string): InboundPayload | null {
  let parsed: SesInboundNotification;
  try {
    parsed = JSON.parse(message) as SesInboundNotification;
  } catch {
    return null;
  }
  if (parsed.notificationType !== "Received" && !parsed.receipt) return null;
  const sesMessageId = parsed.mail?.messageId;
  if (!sesMessageId) return null;

  const action = parsed.receipt?.action;
  const s3 =
    action?.type === "S3" && action.bucketName && action.objectKey
      ? { bucket: action.bucketName, key: action.objectKey }
      : null;

  const raw = typeof parsed.content === "string" && parsed.content.length > 0
    ? // The SNS action base64-encodes the message when it is not plain text.
      /^[A-Za-z0-9+/=\s]+$/.test(parsed.content) && !parsed.content.includes(":")
      ? Buffer.from(parsed.content, "base64").toString("utf8")
      : parsed.content
    : null;

  return {
    sesMessageId,
    raw,
    s3,
    recipients: (parsed.receipt?.recipients ?? parsed.mail?.destination ?? []).map((r) => r.toLowerCase()),
    spam: parsed.receipt?.spamVerdict?.status === "FAIL",
    virus: parsed.receipt?.virusVerdict?.status === "FAIL",
    receivedAt: parsed.mail?.timestamp ?? null,
  };
}

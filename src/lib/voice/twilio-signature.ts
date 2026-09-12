import crypto from "node:crypto";

/**
 * Is this request really from Twilio?
 *
 * HMAC-SHA1 over the public URL plus every POST parameter, key then value,
 * sorted by key. Lifted out of the voice webhook so the one decision that
 * matters can be tested: what happens when the auth token is not set.
 *
 * It used to return true. "Unconfigured: development only" said the comment,
 * on the route that opens a metered call into any venue by dialled number —
 * and a lost environment variable on a redeploy would have made that the
 * production behaviour, silently. The WhatsApp adapters refuse in the same
 * situation. Now this does too, everywhere but a development process, where a
 * missing token is the normal state and refusing would only mean nobody could
 * run the thing locally.
 */
export function twilioSignatureValid(
  url: string,
  params: Record<string, string>,
  signature: string | null,
  opts: { token: string | undefined; production: boolean },
): boolean {
  if (!opts.token) return !opts.production;
  if (!signature) return false;

  const payload =
    url +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join("");
  const expected = crypto.createHmac("sha1", opts.token).update(payload, "utf8").digest("base64");

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

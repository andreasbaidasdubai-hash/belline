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
/**
 * The public URL Twilio requested, which is the one it signed.
 *
 * Railway (like every managed host) terminates TLS at the edge and forwards
 * plain HTTP, so request.url says http:// while Twilio signed the https:// URL
 * the caller actually hit. Rebuilt from the forwarded headers, or the
 * signature never matches.
 */
export function publicRequestUrl(request: Request): string {
  const url = new URL(request.url);
  const signed = new URL(url.toString());
  signed.protocol = (request.headers.get("x-forwarded-proto") ?? "https").split(",")[0].trim() + ":";
  // Clear the port before setting the host: the URL host setter leaves the
  // existing port in place unless the new value carries one of its own, which
  // would otherwise leave the internal :3000 glued to the public hostname.
  signed.port = "";
  signed.host = (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host).split(",")[0].trim();
  return signed.toString();
}

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

import crypto from "node:crypto";
import type { DeliveryStatus, InboundMessage, StatusUpdate } from "../types";
import {
  toE164,
  type AdapterCredentials,
  type ChannelAdapter,
  type OutboundText,
  type SendResult,
} from "./index";

/**
 * WhatsApp, through Twilio.
 *
 * Not the destination — Meta's Cloud API is, and it is cheaper per
 * conversation once there is volume. This exists because of a scheduling
 * fact rather than a technical one: connecting a real business number to Meta
 * requires a Business verification that takes days to weeks, and Twilio's
 * WhatsApp sandbox answers within the hour using credentials this deployment
 * already has for voice and SMS.
 *
 * So the first demo runs on this, and moving a business to its own Meta number
 * afterwards is one row in `channel_account`. Everything above the adapter —
 * the brain, the tools, the booking, the handoff — cannot tell the difference,
 * which is the only reason having two providers is cheap rather than a tax.
 *
 * Three differences from Meta worth knowing:
 *
 * - The webhook is `application/x-www-form-urlencoded`, not JSON, and carries
 *   exactly one message.
 * - The signature is HMAC-SHA1 over the *URL plus the sorted parameters*, not
 *   over the raw body — so it needs the public URL, which behind a proxy is
 *   not the one Node sees.
 * - Numbers are prefixed `whatsapp:`, on the way in and on the way out.
 */

function twilioStatus(raw: string | undefined): DeliveryStatus | null {
  switch (raw) {
    case "sent":
    case "delivered":
    case "read":
      return raw;
    case "failed":
    case "undelivered":
      return "failed";
    case "queued":
    case "accepted":
    case "sending":
      return "queued";
    default:
      return null;
  }
}

export const twilioAdapter: ChannelAdapter = {
  provider: "twilio",
  channel: "whatsapp",

  verifySignature(raw, headers, url) {
    const token = process.env.TWILIO_AUTH_TOKEN;
    if (!token) return false;
    const given = headers.get("x-twilio-signature");
    if (!given) return false;

    // Twilio's scheme: the full URL, then every POST parameter appended as
    // key followed immediately by value, sorted by key.
    const params = new URLSearchParams(raw);
    const sorted = [...params.keys()].sort();
    let payload = url;
    for (const key of sorted) payload += key + (params.get(key) ?? "");

    const expected = crypto.createHmac("sha1", token).update(payload, "utf8").digest("base64");
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  },

  parse(raw) {
    const messages: InboundMessage[] = [];
    const statuses: StatusUpdate[] = [];

    const p = new URLSearchParams(raw);
    const sid = p.get("MessageSid") ?? p.get("SmsSid") ?? "";
    if (!sid) return { messages, statuses };

    // A status callback carries MessageStatus and no Body. The same endpoint
    // receives both, which is Twilio's design rather than ours.
    const statusField = p.get("MessageStatus") ?? p.get("SmsStatus");
    if (statusField && !p.has("Body")) {
      const status = twilioStatus(statusField);
      if (status) {
        statuses.push({
          providerMessageId: sid,
          status,
          error: p.get("ErrorMessage") ?? p.get("ErrorCode") ?? undefined,
          timestamp: new Date().toISOString(),
          // `From` on a status callback is our number — the one the message
          // went out on — which is the account it belongs to.
          toE164: p.get("From") ? toE164(p.get("From")!) : undefined,
        });
      }
      return { messages, statuses };
    }

    const from = p.get("From");
    const to = p.get("To");
    if (!from) return { messages, statuses };

    const common = {
      channel: "whatsapp" as const,
      provider: "twilio" as const,
      providerMessageId: sid,
      toE164: to ? toE164(to) : undefined,
      // Twilio has no per-number id of Meta's kind; the number is the handle.
      externalNumberId: undefined,
      fromE164: toE164(from),
      profileName: p.get("ProfileName") ?? undefined,
      timestamp: new Date().toISOString(),
      raw: Object.fromEntries(p.entries()),
    };

    const mediaCount = Number(p.get("NumMedia") ?? "0");
    const body = p.get("Body") ?? "";

    if (mediaCount > 0) {
      const type = p.get("MediaContentType0") ?? "";
      const mediaUrl = p.get("MediaUrl0") ?? "";
      if (type.startsWith("audio/") && mediaUrl) {
        // The URL is the handle here, not an id — downloadMedia takes it back.
        messages.push({ ...common, content: { type: "audio", mediaId: mediaUrl, mime: type } });
      } else {
        messages.push({
          ...common,
          content: { type: "unsupported", kind: type || "media" },
        });
      }
      return { messages, statuses };
    }

    if (body.trim()) {
      messages.push({ ...common, content: { type: "text", text: body } });
    }
    return { messages, statuses };
  },

  async send(account, credentials, to, message: OutboundText): Promise<SendResult> {
    const sid = credentials.accountSid ?? process.env.TWILIO_ACCOUNT_SID;
    const token = credentials.authToken ?? process.env.TWILIO_AUTH_TOKEN;
    const from = credentials.from ?? account.phoneE164;
    if (!sid || !token || !from) {
      return { ok: false, detail: "This WhatsApp account has no usable credentials.", retryable: false };
    }

    try {
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
        {
          method: "POST",
          headers: {
            authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            From: `whatsapp:${from}`,
            To: `whatsapp:${to}`,
            Body: message.text,
          }),
          signal: AbortSignal.timeout(15_000),
        },
      );

      const body = (await res.json().catch(() => ({}))) as { sid?: string; message?: string };
      if (!res.ok || !body.sid) {
        return {
          ok: false,
          detail: body.message ?? `Twilio returned ${res.status}`,
          retryable: res.status >= 500 || res.status === 429,
        };
      }
      return { ok: true, providerMessageId: body.sid };
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
        retryable: true,
      };
    }
  },

  async downloadMedia(_account, credentials, mediaUrl) {
    const sid = credentials.accountSid ?? process.env.TWILIO_ACCOUNT_SID;
    const token = credentials.authToken ?? process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) return null;
    // Only ever Twilio's own media host. The URL arrives in a webhook, and a
    // webhook is data: following an arbitrary URL with our credentials
    // attached is how a forged payload turns into a credential leak.
    if (!/^https:\/\/api\.twilio\.com\//.test(mediaUrl)) return null;
    try {
      const res = await fetch(mediaUrl, {
        headers: {
          authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) return null;
      return {
        bytes: Buffer.from(await res.arrayBuffer()),
        mime: res.headers.get("content-type") ?? "audio/ogg",
      };
    } catch {
      return null;
    }
  },
};

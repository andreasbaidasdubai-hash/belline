import crypto from "node:crypto";
import type { InboundMessage, StatusUpdate, DeliveryStatus } from "../types";
import {
  toE164,
  type AdapterCredentials,
  type ChannelAdapter,
  type OutboundText,
  type SendResult,
} from "./index";

/**
 * WhatsApp, through Meta's Cloud API.
 *
 * The official platform, and the one a business's own number ends up on. Three
 * things about it shape this file.
 *
 * **It retries.** Anything Meta considers slow or failed comes again, possibly
 * several times, possibly to a different container. Every defence against that
 * is downstream in the unique index on `provider_message_id`; this file's only
 * job is to surface that id faithfully.
 *
 * **It signs the raw bytes.** `X-Hub-Signature-256` is an HMAC over the exact
 * body, so the signature has to be checked before anything parses it.
 * `JSON.parse` then `JSON.stringify` does not round-trip to the same bytes.
 *
 * **Its envelope is deeply nested and mostly irrelevant.** One webhook can
 * carry several entries, each with several changes, each with messages *and*
 * delivery statuses. Flattening that here is the point of the adapter.
 */

const GRAPH = process.env.WHATSAPP_GRAPH_VERSION ?? "v21.0";

interface MetaEnvelope {
  object?: string;
  entry?: {
    id?: string;
    changes?: {
      field?: string;
      value?: {
        metadata?: { display_phone_number?: string; phone_number_id?: string };
        contacts?: { profile?: { name?: string }; wa_id?: string }[];
        messages?: MetaMessage[];
        statuses?: MetaStatus[];
      };
    }[];
  }[];
}

interface MetaMessage {
  id?: string;
  from?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  audio?: { id?: string; mime_type?: string; voice?: boolean };
  [k: string]: unknown;
}

interface MetaStatus {
  id?: string;
  status?: string;
  timestamp?: string;
  errors?: { title?: string; message?: string }[];
}

/** Meta's vocabulary is nearly ours; "read" and "delivered" match, "sent" matches. */
function toDeliveryStatus(raw: string | undefined): DeliveryStatus | null {
  switch (raw) {
    case "sent":
    case "delivered":
    case "read":
    case "failed":
      return raw;
    // "warning" and anything new: not a state we model, and inventing one
    // would put a value in the column that nothing knows how to render.
    default:
      return null;
  }
}

function isoFrom(unixSeconds: string | undefined): string {
  const n = Number(unixSeconds);
  return Number.isFinite(n) && n > 0
    ? new Date(n * 1000).toISOString()
    : new Date().toISOString();
}

export const metaAdapter: ChannelAdapter = {
  provider: "meta",
  channel: "whatsapp",

  verifyChallenge(params) {
    const expected = process.env.WHATSAPP_VERIFY_TOKEN;
    // No token configured means no handshake can be honest. Refusing is right:
    // echoing the challenge unconditionally would let anybody point their own
    // Meta app at this endpoint.
    if (!expected) return null;
    if (params.get("hub.mode") !== "subscribe") return null;
    const given = params.get("hub.verify_token") ?? "";
    // Constant-time: the token is a shared secret, and a comparison that
    // returns early leaks its prefix to anyone willing to measure.
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return params.get("hub.challenge");
  },

  verifySignature(raw, headers) {
    const secret = process.env.WHATSAPP_APP_SECRET;
    // Unset is a refusal, not a pass. An endpoint that accepts unsigned
    // webhooks because it has not been configured is an endpoint anybody can
    // post conversations into.
    if (!secret) return false;

    const header = headers.get("x-hub-signature-256") ?? "";
    const given = header.startsWith("sha256=") ? header.slice(7) : "";
    if (!given) return false;

    const expected = crypto.createHmac("sha256", secret).update(raw, "utf8").digest("hex");
    const a = Buffer.from(given, "hex");
    const b = Buffer.from(expected, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  },

  parse(raw) {
    const messages: InboundMessage[] = [];
    const statuses: StatusUpdate[] = [];

    let envelope: MetaEnvelope;
    try {
      envelope = JSON.parse(raw) as MetaEnvelope;
    } catch {
      // A body we cannot read is not an error worth retrying — returning
      // nothing means the route answers 200 and Meta stops resending it.
      return { messages, statuses };
    }

    for (const entry of envelope.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        if (!value) continue;

        const numberId = value.metadata?.phone_number_id;
        const toNumber = value.metadata?.display_phone_number;
        // One contact per message in practice, but the shape is a list and the
        // name is the only place a profile name appears.
        const nameByWaId = new Map(
          (value.contacts ?? []).map((c) => [c.wa_id ?? "", c.profile?.name ?? ""]),
        );

        for (const m of value.messages ?? []) {
          if (!m.id || !m.from) continue;

          const common = {
            channel: "whatsapp" as const,
            provider: "meta" as const,
            providerMessageId: m.id,
            toE164: toNumber ? toE164(toNumber) : undefined,
            externalNumberId: numberId,
            fromE164: toE164(m.from),
            profileName: nameByWaId.get(m.from) || undefined,
            timestamp: isoFrom(m.timestamp),
            raw: m,
          };

          if (m.type === "text" && m.text?.body) {
            messages.push({ ...common, content: { type: "text", text: m.text.body } });
          } else if (m.type === "audio" && m.audio?.id) {
            messages.push({
              ...common,
              content: { type: "audio", mediaId: m.audio.id, mime: m.audio.mime_type },
            });
          } else {
            // An image, a document, a location, a sticker, a reaction. Recorded
            // rather than dropped: the customer sent something, staff should be
            // able to see that they did, and Belline should say it cannot read
            // it rather than answer as though nothing arrived.
            messages.push({
              ...common,
              content: { type: "unsupported", kind: m.type ?? "unknown" },
            });
          }
        }

        for (const s of value.statuses ?? []) {
          const status = toDeliveryStatus(s.status);
          if (!s.id || !status) continue;
          statuses.push({
            providerMessageId: s.id,
            status,
            error: s.errors?.[0]?.message ?? s.errors?.[0]?.title,
            timestamp: isoFrom(s.timestamp),
            toE164: toNumber ? toE164(toNumber) : undefined,
            externalNumberId: numberId,
          });
        }
      }
    }

    return { messages, statuses };
  },

  async send(account, credentials, to, message: OutboundText): Promise<SendResult> {
    const token = credentials.accessToken;
    const numberId = credentials.phoneNumberId ?? account.externalNumberId;
    if (!token || !numberId) {
      return { ok: false, detail: "This WhatsApp account has no usable credentials.", retryable: false };
    }

    try {
      const res = await fetch(`https://graph.facebook.com/${GRAPH}/${numberId}/messages`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: to.replace(/^\+/, ""),
          type: "text",
          // Link previews off: a URL in a confirmation should not pull an
          // unrelated card under the message.
          text: { preview_url: false, body: message.text },
        }),
        signal: AbortSignal.timeout(15_000),
      });

      const body = (await res.json().catch(() => ({}))) as {
        messages?: { id?: string }[];
        error?: { message?: string; code?: number };
      };

      if (!res.ok) {
        return {
          ok: false,
          detail: body.error?.message ?? `Meta returned ${res.status}`,
          // 4xx is a bad request or an expired token — sending it again
          // produces the same failure and a duplicate if it half-worked.
          retryable: res.status >= 500 || res.status === 429,
        };
      }

      const id = body.messages?.[0]?.id;
      if (!id) {
        // Accepted with no id. Treated as failure and *not* retried: we cannot
        // tell whether it was delivered, and a retry risks sending it twice.
        return { ok: false, detail: "Meta accepted the message without an id.", retryable: false };
      }
      return { ok: true, providerMessageId: id };
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
        retryable: true,
      };
    }
  },

  async downloadMedia(_account, credentials, mediaId) {
    const token = credentials.accessToken;
    if (!token) return null;
    try {
      // Two hops, and the second one still needs the bearer: the URL Meta
      // hands back is not public.
      const meta = await fetch(`https://graph.facebook.com/${GRAPH}/${mediaId}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!meta.ok) return null;
      const { url, mime_type } = (await meta.json()) as { url?: string; mime_type?: string };
      if (!url) return null;

      const file = await fetch(url, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!file.ok) return null;
      return {
        bytes: Buffer.from(await file.arrayBuffer()),
        mime: mime_type ?? "audio/ogg",
      };
    } catch {
      return null;
    }
  },
};

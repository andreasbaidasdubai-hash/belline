import { NextResponse } from "next/server";
import { isConfigured } from "@/lib/db/client";
import { metaAdapter } from "@/lib/reception/channel/meta";
import { twilioAdapter } from "@/lib/reception/channel/twilio";
import { acceptInbound, acceptStatus } from "@/lib/reception/inbound";
import { respondTo } from "@/lib/reception/respond";
import { newTraceId } from "@/lib/reception/events";
import type { ChannelAdapter } from "@/lib/reception/channel";

export const dynamic = "force-dynamic";

/**
 * Where WhatsApp arrives.
 *
 * One endpoint for both providers, because a business moving from the Twilio
 * sandbox to its own Meta number should not have to change a URL that is
 * already registered in somebody's console.
 *
 * The single most important property of this route is **how fast it returns**.
 * Meta retries anything it considers slow, Twilio does the same, and a retry
 * that gets handled a second time is a duplicate booking. So the shape is
 * fixed: verify the signature, hand the work to a promise, return 200. Nothing
 * that talks to a model or a booking engine happens before the response.
 *
 * The second most important is that **a failure still returns 200**. A 500
 * here does not make the message arrive — it makes the provider send it again,
 * and again, which turns one broken message into a queue of them. Anything
 * that goes wrong is logged against a trace id and answered with an
 * acknowledgement.
 */

/**
 * Which provider sent this.
 *
 * By the shape of the request, not by a query parameter — a parameter is
 * something a forged request can set, and the signature check that follows
 * depends on picking the right scheme.
 */
function adapterFor(contentType: string, headers: Headers): ChannelAdapter | null {
  if (headers.has("x-twilio-signature")) return twilioAdapter;
  if (headers.has("x-hub-signature-256")) return metaAdapter;
  // Form-encoded with no signature is Twilio with the token unset, which the
  // adapter will refuse anyway. JSON with none is Meta, likewise.
  if (contentType.includes("application/x-www-form-urlencoded")) return twilioAdapter;
  if (contentType.includes("application/json")) return metaAdapter;
  return null;
}

/**
 * The URL Twilio signed.
 *
 * Behind a proxy the URL Node sees is `http://localhost:3000/...`, and the one
 * Twilio hashed is the public HTTPS one. Getting this wrong makes every
 * signature fail, which looks exactly like a wrong auth token.
 */
function publicUrl(req: Request): string {
  const url = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}${url.pathname}${url.search}`;
}

/**
 * Meta's one-time handshake.
 *
 * Pasting the URL into Meta's webhook form makes this request immediately, and
 * the form will not save until it echoes the challenge. It is the reason this
 * route has to exist before anybody can finish configuring anything.
 */
export function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const challenge = metaAdapter.verifyChallenge?.(params) ?? null;

  if (challenge === null) {
    console.warn("[whatsapp] webhook verification refused");
    return new NextResponse("verification failed", { status: 403 });
  }
  // Plain text, exactly the challenge, nothing else. Meta compares bytes.
  return new NextResponse(challenge, {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

export async function POST(req: Request) {
  const traceId = newTraceId();
  const contentType = req.headers.get("content-type") ?? "";
  const adapter = adapterFor(contentType, req.headers);

  if (!adapter) {
    console.warn(`[whatsapp ${traceId}] unrecognised webhook shape: ${contentType}`);
    return acknowledge();
  }

  // The raw bytes, before anything parses them: every signature scheme here is
  // over the exact body, and JSON.parse followed by JSON.stringify is not it.
  const raw = await req.text();

  if (!adapter.verifySignature(raw, req.headers, publicUrl(req))) {
    // A genuine 403, unlike everything below. An unsigned request is not a
    // message we failed to handle — it is one that was never ours.
    console.warn(`[whatsapp ${traceId}] rejected: bad ${adapter.provider} signature`);
    return new NextResponse("bad signature", { status: 403 });
  }

  if (!isConfigured()) {
    // Nowhere to put it. Acknowledged rather than retried, because retrying
    // will not provision a database.
    console.error(`[whatsapp ${traceId}] DATABASE_URL is not set — message dropped`);
    return acknowledge();
  }

  const { messages, statuses } = adapter.parse(raw);

  // Everything past this point is deliberately not awaited by the response.
  void handle(adapter, messages, statuses, traceId);

  return acknowledge(adapter);
}

/**
 * 200, always, and as fast as possible.
 *
 * Twilio gets an empty TwiML document with its content type rather than an
 * empty body. The empty body was answered in 30 ms by our side and still
 * logged by Twilio as error 11200 with a 502, followed by a second delivery of
 * the same message eleven seconds later. TwiML is what its webhook expects,
 * and `<Response/>` tells it there is nothing to send back — the reply goes
 * out separately through the API once Belline has written it.
 */
function acknowledge(adapter?: ChannelAdapter) {
  if (adapter?.provider === "twilio") {
    return new NextResponse('<?xml version="1.0" encoding="UTF-8"?><Response/>', {
      status: 200,
      headers: { "content-type": "text/xml; charset=utf-8" },
    });
  }
  return new NextResponse(null, { status: 200 });
}

async function handle(
  adapter: ChannelAdapter,
  messages: Awaited<ReturnType<ChannelAdapter["parse"]>>["messages"],
  statuses: Awaited<ReturnType<ChannelAdapter["parse"]>>["statuses"],
  traceId: string,
): Promise<void> {
  for (const status of statuses) {
    try {
      await acceptStatus(
        adapter.channel,
        { phoneE164: status.toE164, externalNumberId: status.externalNumberId },
        status,
      );
    } catch (err) {
      console.error(`[whatsapp ${traceId}] status ${status.providerMessageId}:`, err);
    }
  }

  for (const inbound of messages) {
    try {
      const result = await acceptInbound(inbound);
      if (!result.ok) {
        console.warn(`[whatsapp ${traceId}] ${result.rejected.reason}: ${result.rejected.detail}`);
        continue;
      }
      if (!result.accepted.fresh) {
        // The retry defence doing its job. Worth a line, because a burst of
        // these means something upstream is timing out.
        console.log(`[whatsapp ${traceId}] duplicate ${inbound.providerMessageId} ignored`);
        continue;
      }
      console.log(
        `[whatsapp ${traceId}] conversation ${result.accepted.conversationId} ` +
          `<- ${inbound.content.type} from ${inbound.fromE164}`,
      );
      const outcome = await respondTo(result.accepted);
      if (!outcome.sent) {
        // Never rethrown and never a 500: the provider must not be asked to
        // send this again. A message Belline could not answer is one a person
        // picks up, which is what the inbox is for.
        console.warn(
          `[whatsapp ${traceId}] no reply — ` +
            ("skipped" in outcome ? outcome.skipped : outcome.failed),
        );
      }
    } catch (err) {
      console.error(`[whatsapp ${traceId}] ${inbound.providerMessageId}:`, err);
    }
  }
}

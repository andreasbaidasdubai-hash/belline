/**
 * Where replies to the cold-mail domains arrive.
 *
 * Amazon SES receives the message, a receipt rule hands it to SNS, and SNS
 * POSTs it here. The shape of this route is borrowed from the WhatsApp webhook
 * and for the same three reasons, which are worth restating because each of
 * them was learned the expensive way:
 *
 *  - **Verify the signature before anything else.** This URL is public. A
 *    forged POST to it would stop a sequence, write to a lead's timeline and,
 *    with the right words, suppress a company permanently. The check is in
 *    `inbound/sns.ts` and it pins the certificate host, the topic and the age.
 *
 *  - **A bad signature is a 403; everything else is a 200.** A 500 does not
 *    make the message arrive — it makes SNS send it again, and again, which
 *    turns one unparseable message into a queue of them.
 *
 *  - **Return fast.** SNS times out and retries. The parsing, matching and
 *    stopping happen on a promise the response does not wait for, and the
 *    idempotency key means a retry that overtakes us is still one reply.
 *
 * There is no GET handshake: SNS confirms a subscription by POSTing a
 * `SubscriptionConfirmation`, which is handled below, and only ever for a
 * topic that is already named in this deployment's configuration.
 */

import { NextResponse } from "next/server";
import { receiveInbound } from "@/lib/sales/inbound/receive";
import { s3Reader } from "@/lib/sales/inbound/s3";
import {
  cachingCertFetcher,
  parseSesNotification,
  verifySns,
  type SnsEnvelope,
} from "@/lib/sales/inbound/sns";

export const dynamic = "force-dynamic";

const fetchCert = cachingCertFetcher();

/** The topics this deployment accepts, from the environment. Never a wildcard. */
function allowedTopics(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.OUTREACH_INBOUND_SNS_TOPIC_ARN ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function POST(request: Request) {
  const raw = await request.text();

  let envelope: SnsEnvelope;
  try {
    envelope = JSON.parse(raw) as SnsEnvelope;
  } catch {
    console.warn("[inbound-mail] body is not JSON");
    return new NextResponse(null, { status: 200 });
  }

  const verdict = await verifySns({
    envelope,
    allowedTopics: allowedTopics(),
    fetchCert,
  });
  if (!verdict.ok) {
    // The one genuine refusal. An unsigned or unrecognised notification is not
    // a message we failed to handle; it is one that was never ours.
    console.warn(`[inbound-mail] refused: ${verdict.reason}`);
    return new NextResponse("refused", { status: 403 });
  }

  if (envelope.Type === "SubscriptionConfirmation") {
    // Only reached for a topic this deployment already names and a signature
    // that verified, so confirming is not something a stranger can provoke.
    return confirm(envelope);
  }
  if (envelope.Type === "UnsubscribeConfirmation") {
    console.warn(`[inbound-mail] the endpoint was unsubscribed from ${envelope.TopicArn}`);
    return new NextResponse(null, { status: 200 });
  }

  const payload = parseSesNotification(envelope.Message);
  if (!payload) {
    console.warn(`[inbound-mail] ${envelope.MessageId}: not an SES receipt notification`);
    return new NextResponse(null, { status: 200 });
  }

  void handle(payload).catch((err) => {
    console.error(`[inbound-mail] ${payload.sesMessageId}:`, err);
  });

  return new NextResponse(null, { status: 200 });
}

async function confirm(envelope: SnsEnvelope): Promise<NextResponse> {
  const url = envelope.SubscribeURL;
  if (!url) return new NextResponse(null, { status: 200 });
  try {
    await fetch(url, { signal: AbortSignal.timeout(10_000) });
    console.log(`[inbound-mail] confirmed the subscription to ${envelope.TopicArn}`);
  } catch (err) {
    // Not fatal: the same URL can be opened from the SNS console by hand.
    console.error(`[inbound-mail] could not confirm the subscription — confirm it in the SNS console: ${url}`, err);
  }
  return new NextResponse(null, { status: 200 });
}

async function handle(payload: NonNullable<ReturnType<typeof parseSesNotification>>): Promise<void> {
  let raw = payload.raw;

  if (!raw && payload.s3) {
    const reader = s3Reader();
    if (!reader.ok) {
      // Loud, because this is the failure that looks like nobody replying.
      console.error(
        `[inbound-mail] ${payload.sesMessageId} is in s3://${payload.s3.bucket}/${payload.s3.key} and cannot be read: ${reader.reason}`,
      );
      return;
    }
    raw = await reader.reader.get(payload.s3.bucket, payload.s3.key);
  }

  if (!raw) {
    console.error(`[inbound-mail] ${payload.sesMessageId} carried neither content nor an S3 pointer`);
    return;
  }

  const outcome = await receiveInbound({
    provider: "ses",
    providerMessageId: payload.sesMessageId,
    raw,
    recipients: payload.recipients,
    receivedAt: payload.receivedAt ?? undefined,
    spam: payload.spam,
    virus: payload.virus,
  });

  console.log(
    `[inbound-mail] ${payload.sesMessageId} → ${outcome.action}: ${outcome.summary}` +
      (outcome.leadId === null ? "" : ` (lead ${outcome.leadId}, matched by ${outcome.matchedBy})`),
  );
}

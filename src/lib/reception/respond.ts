import type Anthropic from "@anthropic-ai/sdk";
import type { Call, Location } from "../types";
import type { Conversation } from "./types";
import { getCall, getLocation, saveCall } from "../store";
import { startCall } from "../calls";
import { AgentSession } from "../agent/runtime";
import { checkTimes, honestAlternative } from "../agent/honesty";
import { metaAdapter } from "./channel/meta";
import { twilioAdapter } from "./channel/twilio";
import { internalAdapter } from "./channel/internal";
import { webchatAdapter } from "./channel/webchat";
import { isPhoneHandle } from "../webchat";
import { openCredentials } from "../db/credentials";
import {
  agentHistory,
  commitAiTurn,
  getAccount,
  getConversation,
  getCustomer,
  accountCredentials,
  markDelivery,
  markSent,
  recordMessage,
  transition,
} from "./repo";
import { track, newTraceId } from "./events";
import type { Accepted } from "./inbound";
import type { ChannelAdapter } from "./channel";

/**
 * Belline answering a message.
 *
 * The shape of a turn, and the order is the whole design:
 *
 *   1. Is Belline allowed to speak here at all? (status, and the account's
 *      own switch — a business can have the inbox without the agent.)
 *   2. Rehydrate the conversation and run the turn. No lock is held: this
 *      takes seconds, and a Postgres transaction open for seconds pins a
 *      connection for no benefit.
 *   3. Take the lock, re-check that a person has not taken over, write the
 *      reply and the history, commit.
 *   4. *Then* send. Sending cannot be rolled back, so the row exists first —
 *      a message that went out and was never recorded is invisible to the
 *      inbox, and staff would answer something Belline had already answered.
 *
 * Step 3 returning nothing means somebody took the conversation while Belline
 * was thinking. The reply is discarded. That costs a few hundred tokens and is
 * the correct price for never talking over a member of staff.
 */

const ADAPTERS: Record<string, ChannelAdapter> = {
  meta: metaAdapter,
  twilio: twilioAdapter,
  // No wire. The same pipeline with the delivery recorded rather than sent —
  // how the journey is demonstrated before a business's own number exists.
  internal: internalAdapter,
  // Our own page. The reply is delivered by being written down; the visitor's
  // browser asks for it. See channel/webchat.ts.
  webchat: webchatAdapter,
};

/** The reason a turn produced nothing, for the log. Never shown to a customer. */
export type Skipped =
  | "not_ai_active"
  | "ai_disabled"
  | "no_account"
  | "no_venue"
  | "taken_over"
  | "nothing_to_say"
  | "unsupported_content";

export type TurnOutcome =
  | { sent: true; text: string; providerMessageId: string }
  | { sent: false; skipped: Skipped }
  | { sent: false; failed: string };

export async function respondTo(accepted: Accepted): Promise<TurnOutcome> {
  const traceId = newTraceId();
  const { tenantId, conversationId } = accepted;

  const conversation = await getConversation(tenantId, conversationId);
  if (!conversation) return { sent: false, skipped: "not_ai_active" };
  if (conversation.status !== "AI_ACTIVE") {
    return { sent: false, skipped: "not_ai_active" };
  }

  const account = conversation.channelAccountId
    ? await getAccount(tenantId, conversation.channelAccountId)
    : undefined;
  if (!account) return { sent: false, skipped: "no_account" };
  // A business that wants the inbox but not the agent. Every message waits for
  // a person, and Belline says nothing at all rather than a holding line.
  if (!account.aiEnabled) return { sent: false, skipped: "ai_disabled" };

  const location = conversation.locationId ? getLocation(conversation.locationId) : undefined;
  if (!location) return { sent: false, skipped: "no_venue" };

  const customer = await getCustomer(tenantId, conversation.customerId);

  // Something Belline cannot read. Said plainly rather than answered around —
  // a receptionist who received a photograph and replied about opening hours
  // is worse than one who says it cannot see it.
  if (!accepted.text) {
    const say =
      accepted.message.content.type === "audio"
        ? "I can't listen to voice notes just yet — could you type it instead?"
        : "I can't open that here. Could you tell me in a message what you need?";
    return sendAndRecord(accepted, account, location, say, traceId, {
      history: (await agentHistory(tenantId, conversationId)) as Anthropic.MessageParam[],
      skipModel: true,
    });
  }

  // --- the turn -------------------------------------------------------------

  const history = (await agentHistory(tenantId, conversationId)) as Anthropic.MessageParam[];

  // The venue's own episode record. Created on the first turn and carried on
  // the conversation afterwards, so the dashboard, the attention inbox and the
  // week's numbers see a WhatsApp conversation exactly as they see a call.
  const call: Call =
    existingCall(conversation.callId) ?? startEpisode(location, conversation.channel, accepted);

  const session = new AgentSession(location, call, {
    // Only a real number. A website visitor's handle is not one, and handing it
    // to the agent would have it looking up a guest by a string no booking can
    // ever contain — see webchat.ts.
    callerNumber: isPhoneHandle(customer?.phoneE164) ? customer?.phoneE164 : undefined,
    channel: "text",
    history,
  });

  let reply = "";
  let handoff: { reason: string; summary: string } | undefined;
  let modelError: string | undefined;
  const startedAt = Date.now();

  try {
    for await (const event of session.respond(accepted.text)) {
      if (event.type === "sentence") {
        // One message, not three. The fragments exist for a speech engine; on
        // a written channel they are joined and sent once.
        reply += (reply ? " " : "") + event.text;
      } else if (event.type === "tool") {
        if (event.trace.name === "request_human_handoff" && event.trace.ok) {
          const input = event.trace.input as { reason?: string; summary?: string };
          handoff = {
            reason: String(input.reason ?? "asked for a person"),
            summary: String(input.summary ?? ""),
          };
        }
      } else if (event.type === "error") {
        modelError = event.message;
      }
    }
  } catch (err) {
    modelError = err instanceof Error ? err.message : String(err);
  }

  await track({
    tenantId,
    businessId: conversation.businessId,
    locationId: location.id,
    channel: conversation.channel,
    conversationId,
    traceId,
    name: "ai.responded",
    payload: {
      ms: Date.now() - startedAt,
      model: location.agent.model,
      tools: call.toolCalls.map((t) => t.name),
      handoff: Boolean(handoff),
      error: modelError,
    },
  });

  // Did it name a time nothing came back with?
  //
  // The prompt forbids it twice and the model did it anyway — "I have 2:00,
  // 3:30 and 5:00" at a salon whose only free slots were before half past ten.
  // A guest turning up for an appointment that does not exist is the worst
  // failure this product has, so it is a check rather than a request.
  const honesty = checkTimes(reply, call.toolCalls);
  if (!honesty.ok) {
    console.warn(
      `[reception ${traceId}] invented ${honesty.invented.join(", ")} — offered ${
        honesty.offered.join(", ") || "nothing"
      }
           replaced: ${reply}`,
    );
    await track({
      tenantId,
      businessId: conversation.businessId,
      channel: conversation.channel,
      conversationId,
      traceId,
      name: "ai.invented_availability",
      // The original is kept: a guard nobody can audit is a guard nobody
      // trusts, and a false positive is invisible without it.
      payload: { invented: honesty.invented, offered: honesty.offered, replaced: reply },
    });
    // Replaced from the tool's own output rather than regenerated: a second
    // model call costs a second and might invent a different set.
    reply = honestAlternative(honesty);
  }

  if (modelError && !reply) {
    // Nothing usable came back. Escalating is the honest answer: a customer
    // waiting on a message that will never arrive is worse than one told a
    // person is coming.
    await escalate(
      tenantId,
      conversationId,
      "the agent could not answer",
      `Belline failed to produce a reply (${modelError}). The customer is waiting.`,
    );
    return { sent: false, failed: modelError };
  }

  // --- commit, then send ----------------------------------------------------

  call.transcript.push(
    { role: "caller", text: accepted.text, at: new Date().toISOString() },
    ...(reply ? [{ role: "agent" as const, text: reply, at: new Date().toISOString() }] : []),
  );
  saveCall(call);

  const committed = await commitAiTurn(tenantId, conversationId, {
    reply,
    history: session.history(),
    callId: call.id,
    bookingId: call.bookingId,
    handoff,
  });

  if (!committed) {
    // Somebody took it over while Belline was thinking.
    await track({
      tenantId,
      businessId: conversation.businessId,
      channel: conversation.channel,
      conversationId,
      traceId,
      name: "ai.discarded",
      payload: { reason: "taken_over" },
    });
    return { sent: false, skipped: "taken_over" };
  }

  if (handoff) {
    await track({
      tenantId,
      businessId: conversation.businessId,
      channel: conversation.channel,
      conversationId,
      traceId,
      name: "handoff.requested",
      payload: { reason: handoff.reason },
    });
  }

  if (!committed.messageId || !reply.trim()) {
    return { sent: false, skipped: "nothing_to_say" };
  }

  const result = await deliver(account, customer?.phoneE164 ?? accepted.message.fromE164, reply);

  if (!result.ok) {
    await markDelivery(tenantId, `pending:${committed.messageId}`, "failed", result.detail);
    await track({
      tenantId,
      businessId: conversation.businessId,
      channel: conversation.channel,
      conversationId,
      traceId,
      name: "provider.error",
      payload: { where: "send", detail: result.detail, retryable: result.retryable },
    });
    console.error(`[reception ${traceId}] send failed: ${result.detail}`);
    return { sent: false, failed: result.detail };
  }

  await markSent(tenantId, committed.messageId, result.providerMessageId);
  await track({
    tenantId,
    businessId: conversation.businessId,
    channel: conversation.channel,
    conversationId,
    traceId,
    name: "message.sent",
    payload: { chars: reply.length },
  });

  return { sent: true, text: reply, providerMessageId: result.providerMessageId };
}

// ---------------------------------------------------------------------------

async function deliver(
  account: Awaited<ReturnType<typeof getAccount>> & object,
  to: string,
  text: string,
) {
  const adapter = ADAPTERS[account.provider];
  if (!adapter) {
    return { ok: false as const, detail: `No adapter for ${account.provider}`, retryable: false };
  }
  const sealed = await accountCredentials(account.tenantId, account.id);
  // Unsealed here and nowhere else. An adapter never reads the database and
  // never touches the key.
  const credentials = sealed ? openCredentials(sealed) : {};
  return adapter.send(account, credentials, to, { type: "text", text });
}

/**
 * A reply that does not need the model.
 *
 * Used for the things Belline knows it cannot do — a photograph, a document —
 * where running a turn would cost money to produce a sentence we already know.
 */
async function sendAndRecord(
  accepted: Accepted,
  account: Awaited<ReturnType<typeof getAccount>> & object,
  _location: Location,
  text: string,
  traceId: string,
  opts: { history: Anthropic.MessageParam[]; skipModel: true },
): Promise<TurnOutcome> {
  const committed = await commitAiTurn(accepted.tenantId, accepted.conversationId, {
    reply: text,
    history: opts.history,
  });
  if (!committed?.messageId) return { sent: false, skipped: "taken_over" };

  const result = await deliver(account, accepted.message.fromE164, text);
  if (!result.ok) {
    console.error(`[reception ${traceId}] send failed: ${result.detail}`);
    return { sent: false, failed: result.detail };
  }
  await markSent(accepted.tenantId, committed.messageId, result.providerMessageId);
  return { sent: true, text, providerMessageId: result.providerMessageId };
}

async function escalate(
  tenantId: string,
  conversationId: number,
  reason: string,
  summary: string,
): Promise<void> {
  await transition(tenantId, conversationId, "HANDOFF_REQUESTED", {
    expect: ["AI_ACTIVE"],
    reason,
    summary,
  });
  await recordMessage({
    tenantId,
    conversationId,
    sender: "system",
    direction: "out",
    body: `Handed to the team: ${reason}`,
  });
}

/**
 * The episode record, read fresh each turn.
 *
 * Not cached between messages: a WhatsApp conversation can be hours long, and
 * in that time the same call may have been written by a member of staff
 * clearing it from the attention inbox. Reading it back is cheap; holding a
 * stale copy and saving it over their work is not.
 */
function existingCall(callId: string | undefined): Call | undefined {
  return callId ? getCall(callId) : undefined;
}

/**
 * Open the venue's episode record for a conversation.
 *
 * The channel carries through so the dashboard can say where somebody came
 * from, and so the two website channels keep separate daily ceilings. A visitor
 * who has given no number is recorded as "Website" rather than as their internal
 * handle: the column is read by a receptionist, not by us.
 */
function startEpisode(
  location: Location,
  channel: Conversation["channel"],
  accepted: Accepted,
): Call {
  if (channel === "webchat") return startCall(location, "webchat", "Website");
  return startCall(location, "whatsapp", accepted.message.fromE164);
}

/**
 * Mark the venue's episode record finished.
 *
 * Called when a conversation is closed, by a person or by time. A WhatsApp
 * conversation has no moment of hanging up, so without this the call would sit
 * "active" forever and the attention inbox would keep offering it.
 */
export function closeEpisode(callId: string, summary: string): void {
  const call = getCall(callId);
  if (!call || call.status !== "active") return;
  saveCall({
    ...call,
    status: "completed",
    endedAt: new Date().toISOString(),
    summary: call.summary ?? summary,
  });
}

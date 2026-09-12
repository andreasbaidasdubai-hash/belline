import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { canSeeLocation } from "@/lib/auth";
import {
  getAccount,
  getConversation,
  getCustomer,
  markSent,
  recordMessage,
  transition,
  accountCredentials,
} from "@/lib/reception/repo";
import { openCredentials } from "@/lib/db/credentials";
import { metaAdapter } from "@/lib/reception/channel/meta";
import { twilioAdapter } from "@/lib/reception/channel/twilio";
import { internalAdapter } from "@/lib/reception/channel/internal";
import { track } from "@/lib/reception/events";
import { seedIfEmpty } from "@/lib/seed";
import type { ChannelAdapter } from "@/lib/reception/channel";

export const dynamic = "force-dynamic";

const ADAPTERS: Record<string, ChannelAdapter> = {
  meta: metaAdapter,
  twilio: twilioAdapter,
  internal: internalAdapter,
};

/**
 * Taking a conversation over, giving it back, and answering it.
 *
 * Every one of these goes through `transition`, which is a single conditional
 * update: the move only lands if the conversation is still in the state the
 * person saw when they clicked. Two members of staff pressing "take over" at
 * the same moment produce one winner and one honest refusal, rather than two
 * people each believing they own it.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; action: string }> },
) {
  seedIfEmpty();
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const user = auth.user;

  const { id, action } = await params;
  const conversationId = Number(id);
  if (!Number.isFinite(conversationId)) {
    return NextResponse.json({ error: "Unknown conversation." }, { status: 404 });
  }

  const conversation = await getConversation(user.tenantId, conversationId);
  if (!conversation) {
    return NextResponse.json({ error: "Unknown conversation." }, { status: 404 });
  }
  // Tenant is already enforced by the lookup; this is the venue-level check,
  // for a member of staff who can only see one branch.
  if (conversation.locationId && !canSeeLocation(user, conversation.locationId)) {
    return NextResponse.json({ error: "Not your venue." }, { status: 403 });
  }

  switch (action) {
    case "takeover": {
      const moved = await transition(user.tenantId, conversationId, "HUMAN_ACTIVE", {
        expect: ["AI_ACTIVE", "HANDOFF_REQUESTED"],
        userId: user.id,
      });
      if (!moved) {
        return NextResponse.json(
          { error: "Somebody got there first." },
          { status: 409 },
        );
      }
      await recordMessage({
        tenantId: user.tenantId,
        conversationId,
        sender: "system",
        direction: "out",
        body: `${user.name} took over. Belline has stopped answering.`,
      });
      await track({
        tenantId: user.tenantId,
        businessId: conversation.businessId,
        channel: conversation.channel,
        conversationId,
        name: "handoff.taken",
      });
      return NextResponse.json({ ok: true, status: "HUMAN_ACTIVE" });
    }

    case "release": {
      const moved = await transition(user.tenantId, conversationId, "AI_ACTIVE", {
        expect: ["HUMAN_ACTIVE"],
      });
      if (!moved) {
        return NextResponse.json({ error: "It is not yours to hand back." }, { status: 409 });
      }
      await recordMessage({
        tenantId: user.tenantId,
        conversationId,
        sender: "system",
        direction: "out",
        body: `${user.name} handed it back to Belline.`,
      });
      await track({
        tenantId: user.tenantId,
        businessId: conversation.businessId,
        channel: conversation.channel,
        conversationId,
        name: "handoff.returned",
      });
      return NextResponse.json({ ok: true, status: "AI_ACTIVE" });
    }

    case "close": {
      await transition(user.tenantId, conversationId, "CLOSED", {
        expect: ["AI_ACTIVE", "HANDOFF_REQUESTED", "HUMAN_ACTIVE"],
      });
      await track({
        tenantId: user.tenantId,
        businessId: conversation.businessId,
        channel: conversation.channel,
        conversationId,
        name: "conversation.closed",
      });
      return NextResponse.json({ ok: true, status: "CLOSED" });
    }

    case "reply": {
      // Only from HUMAN_ACTIVE. A member of staff typing into a conversation
      // Belline is still answering is the exact overlap the whole state
      // machine exists to prevent.
      if (conversation.status !== "HUMAN_ACTIVE") {
        return NextResponse.json(
          { error: "Take the conversation over first." },
          { status: 409 },
        );
      }

      const body = (await req.json().catch(() => ({}))) as { text?: string };
      const text = String(body.text ?? "").trim();
      if (!text) return NextResponse.json({ error: "Nothing to send." }, { status: 422 });

      const account = conversation.channelAccountId
        ? await getAccount(user.tenantId, conversation.channelAccountId)
        : undefined;
      const customer = await getCustomer(user.tenantId, conversation.customerId);
      if (!account || !customer) {
        return NextResponse.json({ error: "That number is no longer connected." }, { status: 409 });
      }

      // Written before it is sent, for the same reason Belline's replies are:
      // a message that went out and was never recorded is invisible to the
      // next person who opens the thread.
      const stored = await recordMessage({
        tenantId: user.tenantId,
        conversationId,
        sender: "human",
        direction: "out",
        body: text,
        deliveryStatus: "queued",
        meta: { by: user.email },
      });

      const adapter = ADAPTERS[account.provider];
      const sealed = await accountCredentials(user.tenantId, account.id);
      const result = await adapter.send(
        account,
        sealed ? openCredentials(sealed) : {},
        customer.phoneE164,
        { type: "text", text },
      );

      if (!result.ok) {
        return NextResponse.json({ error: result.detail }, { status: 502 });
      }
      await markSent(user.tenantId, stored.message.id, result.providerMessageId);
      await track({
        tenantId: user.tenantId,
        businessId: conversation.businessId,
        channel: conversation.channel,
        conversationId,
        name: "message.sent",
        payload: { by: "human" },
      });
      return NextResponse.json({ ok: true });
    }

    default:
      return NextResponse.json({ error: `Unknown action ${action}.` }, { status: 404 });
  }
}

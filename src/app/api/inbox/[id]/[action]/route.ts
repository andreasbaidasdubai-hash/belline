import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { canSeeLocation, inboxTenants } from "@/lib/auth";
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
import { ADAPTERS, closeEpisode } from "@/lib/reception/respond";
import { track } from "@/lib/reception/events";
import { seedIfEmpty } from "@/lib/seed";

export const dynamic = "force-dynamic";

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

  // Their own tenant first; Belline staff also answer Belline's own inbox,
  // which is another tenant. inboxTenants gives nobody else a second one.
  let tenantId = user.tenantId;
  let conversation = await getConversation(tenantId, conversationId);
  for (const other of inboxTenants(user)) {
    if (conversation) break;
    tenantId = other;
    conversation = await getConversation(tenantId, conversationId);
  }
  if (!conversation) {
    return NextResponse.json({ error: "Unknown conversation." }, { status: 404 });
  }
  // Tenant is already enforced by the lookup; this is the venue-level check,
  // for a member of staff who can only see one branch. Belline's own venue is
  // internal and outside the staff member's tenant, so it is skipped there.
  if (tenantId === user.tenantId && conversation.locationId && !canSeeLocation(user, conversation.locationId)) {
    return NextResponse.json({ error: "Not your venue." }, { status: 403 });
  }
  switch (action) {
    case "takeover": {
      const moved = await transition(tenantId, conversationId, "HUMAN_ACTIVE", {
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
        tenantId: tenantId,
        conversationId,
        sender: "system",
        direction: "out",
        body: `${user.name} took over. Belline has stopped answering.`,
      });
      await track({
        tenantId: tenantId,
        businessId: conversation.businessId,
        channel: conversation.channel,
        conversationId,
        name: "handoff.taken",
      });
      return NextResponse.json({ ok: true, status: "HUMAN_ACTIVE" });
    }

    case "release": {
      const moved = await transition(tenantId, conversationId, "AI_ACTIVE", {
        expect: ["HUMAN_ACTIVE"],
      });
      if (!moved) {
        return NextResponse.json({ error: "It is not yours to hand back." }, { status: 409 });
      }
      await recordMessage({
        tenantId: tenantId,
        conversationId,
        sender: "system",
        direction: "out",
        body: `${user.name} handed it back to Belline.`,
      });
      await track({
        tenantId: tenantId,
        businessId: conversation.businessId,
        channel: conversation.channel,
        conversationId,
        name: "handoff.returned",
      });
      return NextResponse.json({ ok: true, status: "AI_ACTIVE" });
    }

    case "close": {
      await transition(tenantId, conversationId, "CLOSED", {
        expect: ["AI_ACTIVE", "HANDOFF_REQUESTED", "HUMAN_ACTIVE"],
      });
      // The venue's own episode record, finished. A conversation has no moment
      // of hanging up; without this the call sat "active" for ever and the
      // attention inbox kept offering it. Written, exported, and called by
      // nothing until now.
      if (conversation.callId) {
        closeEpisode(conversation.callId, `Closed by ${user.name}.`);
      }
      await track({
        tenantId: tenantId,
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
        ? await getAccount(tenantId, conversation.channelAccountId)
        : undefined;
      const customer = await getCustomer(tenantId, conversation.customerId);
      if (!account || !customer) {
        return NextResponse.json({ error: "That number is no longer connected." }, { status: 409 });
      }

      // Written before it is sent, for the same reason Belline's replies are:
      // a message that went out and was never recorded is invisible to the
      // next person who opens the thread.
      const stored = await recordMessage({
        tenantId: tenantId,
        conversationId,
        sender: "human",
        direction: "out",
        body: text,
        deliveryStatus: "queued",
        meta: { by: user.email },
      });

      const adapter = ADAPTERS[account.provider];
      const sealed = await accountCredentials(tenantId, account.id);
      const result = await adapter.send(
        account,
        sealed ? openCredentials(sealed) : {},
        customer.phoneE164,
        { type: "text", text },
      );

      if (!result.ok) {
        return NextResponse.json({ error: result.detail }, { status: 502 });
      }
      await markSent(tenantId, stored.message.id, result.providerMessageId);
      await track({
        tenantId: tenantId,
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

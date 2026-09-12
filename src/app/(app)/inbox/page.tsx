import { requireUser } from "@/lib/auth-server";
import { visibleLocations } from "@/lib/auth";
import { isConfigured } from "@/lib/db/client";
import { listConversations, listMessages, getCustomer } from "@/lib/reception/repo";
import { seedIfEmpty } from "@/lib/seed";
import { describeHandle } from "@/lib/webchat";
import Thread from "./Thread";
import type { Conversation, Message, Customer } from "@/lib/reception/types";

export const dynamic = "force-dynamic";

export const metadata = { title: "Inbox" };

/**
 * Messages, and who is answering them.
 *
 * The screen the WhatsApp channel was missing. Everything underneath it —
 * webhook, dedup, conversation state, the agent, the booking engine — has been
 * working for a while, and none of it was visible to the person whose business
 * it is. A channel you cannot look at is a channel nobody will trust.
 *
 * Three things it has to make obvious at a glance, because they are the three
 * things a member of staff needs before they type anything:
 *
 *   Who said it. Customer, Belline and a colleague are three different voices
 *   and must never be mistaken for one another.
 *
 *   Whether Belline is still answering. The moment somebody takes over, it
 *   stops — and the screen has to say which of those two worlds it is in.
 *
 *   What happened already. A booking, an escalation, the summary written at
 *   the moment it was handed over — so nobody reads forty messages to find out
 *   they are about to repeat an answer.
 */
export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  seedIfEmpty();
  const user = await requireUser();
  const { id } = await searchParams;

  if (!isConfigured()) {
    return (
      <div>
        <h1 className="page-title">Inbox</h1>
        <div className="panel" style={{ padding: 24, marginTop: 18 }}>
          <p className="muted" style={{ margin: 0, fontSize: 14, lineHeight: 1.6 }}>
            Messaging needs a database, and <code>DATABASE_URL</code> is not set on this
            deployment. Voice works without it; WhatsApp does not.
          </p>
        </div>
      </div>
    );
  }

  const mine = visibleLocations(user).map((l) => l.id);
  const conversations = await listConversations(user.tenantId, { locationIds: mine, limit: 60 });

  const selected: Conversation | undefined =
    conversations.find((c) => String(c.id) === id) ?? conversations[0];

  const messages: Message[] = selected
    ? await listMessages(user.tenantId, selected.id)
    : [];
  const customer: Customer | undefined = selected
    ? await getCustomer(user.tenantId, selected.customerId)
    : undefined;

  return (
    <Thread
      conversations={conversations.map((c) => ({
        id: c.id,
        status: c.status,
        channel: c.channel,
        lastMessageAt: c.lastMessageAt,
        customerId: c.customerId,
        handoffReason: c.handoffReason,
      }))}
      names={Object.fromEntries(
        await Promise.all(
          conversations.map(async (c) => {
            const person = await getCustomer(user.tenantId, c.customerId);
            return [
              c.id,
              person
                ? [person.firstName, person.lastName].filter(Boolean).join(" ") || describeHandle(person.phoneE164)
                : "Unknown",
            ] as const;
          }),
        ),
      )}
      previews={Object.fromEntries(
        await Promise.all(
          conversations.map(async (c) => {
            const last = (await listMessages(user.tenantId, c.id, 400)).at(-1);
            return [c.id, last?.body?.slice(0, 90) ?? ""] as const;
          }),
        ),
      )}
      selected={selected ?? null}
      messages={messages}
      customerName={
        customer
          ? [customer.firstName, customer.lastName].filter(Boolean).join(" ") || describeHandle(customer.phoneE164)
          : ""
      }
      customerPhone={describeHandle(customer?.phoneE164)}
    />
  );
}

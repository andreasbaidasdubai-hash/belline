import { requireUser } from "@/lib/auth-server";
import { inboxTenants, visibleLocations } from "@/lib/auth";
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

  // Belline staff read two inboxes: their own account's, and Belline's own —
  // WhatsApp and website chat on our number — which lives in a tenant of its
  // own, on an internal venue hidden from every list. Everyone else reads one.
  const mine = visibleLocations(user).map((l) => l.id);
  const tenantOf = new Map<number, string>();
  const conversations = (
    await Promise.all(
      inboxTenants(user).map(async (tenantId) => {
        const rows = await listConversations(tenantId, {
          locationIds: tenantId === user.tenantId ? mine : undefined,
          limit: 60,
        });
        for (const c of rows) tenantOf.set(c.id, tenantId);
        return rows;
      }),
    )
  )
    .flat()
    .sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime())
    .slice(0, 60);
  const tenantFor = (c: Conversation) => tenantOf.get(c.id) ?? user.tenantId;

  const selected: Conversation | undefined =
    conversations.find((c) => String(c.id) === id) ?? conversations[0];

  const messages: Message[] = selected
    ? await listMessages(tenantFor(selected), selected.id)
    : [];
  const customer: Customer | undefined = selected
    ? await getCustomer(tenantFor(selected), selected.customerId)
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
            const person = await getCustomer(tenantFor(c), c.customerId);
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
            const last = (await listMessages(tenantFor(c), c.id, 400)).at(-1);
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

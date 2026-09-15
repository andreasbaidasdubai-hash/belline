import { inboxTenants, visibleLocations } from "../auth";
import { isConfigured } from "../db/client";
import { describeHandle } from "../webchat";
import type { User } from "../types";
import { getCustomer, listConversations, listMessages } from "./repo";
import type { Conversation, Message } from "./types";

/**
 * Everything the inbox screen shows, or why it cannot show it.
 *
 * Loaded here rather than in the page so that a database that cannot be
 * reached is a state the screen can describe, not an exception that turns the
 * whole page into a 500. Phone calls do not depend on this database; the
 * screen should say so instead of looking like Belline itself is down.
 */
export type InboxView =
  | { state: "not-configured" }
  | { state: "unavailable" }
  | {
      state: "ok";
      conversations: Pick<Conversation, "id" | "status" | "channel" | "lastMessageAt" | "customerId" | "handoffReason">[];
      names: Record<number, string>;
      previews: Record<number, string>;
      selected: Conversation | null;
      messages: Message[];
      customerName: string;
      customerPhone: string;
    };

export async function loadInbox(user: User, id: string | undefined): Promise<InboxView> {
  if (!isConfigured()) return { state: "not-configured" };

  try {
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

    const selected = conversations.find((c) => String(c.id) === id) ?? conversations[0] ?? null;
    const messages = selected ? await listMessages(tenantFor(selected), selected.id) : [];
    const customer = selected ? await getCustomer(tenantFor(selected), selected.customerId) : undefined;

    const names = Object.fromEntries(
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
    );
    const previews = Object.fromEntries(
      await Promise.all(
        conversations.map(async (c) => {
          const last = (await listMessages(tenantFor(c), c.id, 400)).at(-1);
          return [c.id, last?.body?.slice(0, 90) ?? ""] as const;
        }),
      ),
    );

    return {
      state: "ok",
      conversations: conversations.map((c) => ({
        id: c.id,
        status: c.status,
        channel: c.channel,
        lastMessageAt: c.lastMessageAt,
        customerId: c.customerId,
        handoffReason: c.handoffReason,
      })),
      names,
      previews,
      selected,
      messages,
      customerName: customer
        ? [customer.firstName, customer.lastName].filter(Boolean).join(" ") || describeHandle(customer.phoneE164)
        : "",
      customerPhone: describeHandle(customer?.phoneE164),
    };
  } catch (err) {
    // The message names the failure (a host, a timeout), never a customer.
    console.error("[inbox] could not load conversations:", err instanceof Error ? err.message : String(err));
    return { state: "unavailable" };
  }
}

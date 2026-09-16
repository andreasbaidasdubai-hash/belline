import { requireUser } from "@/lib/auth-server";
import { loadInbox } from "@/lib/reception/inbox-view";
import { seedIfEmpty } from "@/lib/seed";
import Thread from "./Thread";

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

  const view = await loadInbox(user, id);

  if (view.state !== "ok") {
    return (
      <div>
        <h1 className="page-title">Inbox</h1>
        <div className="panel" role="status" style={{ padding: 24, marginTop: 18 }}>
          {view.state === "not-configured" ? (
            <p className="muted" style={{ margin: 0, fontSize: 14, lineHeight: 1.6 }}>
              Messages are not switched on for this account yet. Phone calls are answered as
              normal.
            </p>
          ) : (
            <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, maxWidth: "62ch" }}>
              Messages can&apos;t be loaded right now. Phone calls don&apos;t depend on this and
              are still being answered. Reload this page in a minute. If it keeps happening,
              the team is told automatically.
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <Thread
      conversations={view.conversations}
      names={view.names}
      previews={view.previews}
      selected={view.selected}
      messages={view.messages}
      customerName={view.customerName}
      customerPhone={view.customerPhone}
    />
  );
}

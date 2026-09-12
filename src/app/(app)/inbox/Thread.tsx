"use client";

import { useState } from "react";
import type { Conversation, ConversationStatus, Message } from "@/lib/reception/types";

/**
 * The thread, and the controls that decide who is answering it.
 *
 * The three voices are the whole design problem. A customer, Belline and a
 * colleague have to be tellable apart at a glance and without reading — so
 * they differ in side, in ground and in label, not in one of those. Getting
 * this wrong means somebody answers a question Belline already answered, in
 * front of the customer.
 */

type Summary = {
  id: number;
  status: ConversationStatus;
  channel: string;
  lastMessageAt: string;
  customerId: number;
  handoffReason?: string;
};

const STATUS: Record<ConversationStatus, { label: string; tone: string }> = {
  AI_ACTIVE: { label: "Belline", tone: "var(--ok)" },
  HANDOFF_REQUESTED: { label: "Needs you", tone: "var(--bad)" },
  HUMAN_ACTIVE: { label: "You", tone: "var(--gold-ink)" },
  CLOSED: { label: "Closed", tone: "var(--muted)" },
};

export default function Thread({
  conversations,
  names,
  previews,
  selected,
  messages,
  customerName,
  customerPhone,
}: {
  conversations: Summary[];
  names: Record<number, string>;
  previews: Record<number, string>;
  selected: Conversation | null;
  messages: Message[];
  customerName: string;
  customerPhone: string;
}) {
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");

  async function act(action: string, body?: Record<string, unknown>) {
    if (!selected || busy) return;
    setBusy(true);
    await fetch(`/api/inbox/${selected.id}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    // A full reload rather than optimistic state: the status is decided by the
    // server under a row lock, and guessing it here is how two people both
    // believe they have taken the conversation over.
    window.location.reload();
  }

  if (!conversations.length) {
    return (
      <div>
        <h1 className="page-title">Inbox</h1>
        <div className="panel" style={{ padding: 26, marginTop: 18, maxWidth: "62ch" }}>
          <p style={{ margin: "0 0 10px", fontSize: 15 }}>Nothing here yet.</p>
          <p className="muted" style={{ margin: 0, fontSize: 13.5, lineHeight: 1.65 }}>
            Messages arrive once a WhatsApp number is connected. Everything behind this
            screen — answering, booking, handing over to you — is built and tested; what is
            missing is the number itself.
          </p>
        </div>
      </div>
    );
  }

  const status = selected ? STATUS[selected.status] : null;
  const aiAnswering = selected?.status === "AI_ACTIVE";

  return (
    <div>
      <h1 className="page-title">Inbox</h1>

      <div className="inbox">
        {/* Who is waiting. */}
        <aside className="inbox-list">
          {conversations.map((c) => {
            const on = selected?.id === c.id;
            const tone = STATUS[c.status];
            return (
              <a
                key={c.id}
                href={`/inbox?id=${c.id}`}
                className={`inbox-row${on ? " is-on" : ""}`}
                aria-current={on ? "page" : undefined}
              >
                <div className="inbox-row-top">
                  <strong>{names[c.id] ?? "Unknown"}</strong>
                  <span style={{ color: tone.tone }}>{tone.label}</span>
                </div>
                <p>{previews[c.id] || "—"}</p>
                <time dateTime={c.lastMessageAt}>
                  {new Date(c.lastMessageAt).toLocaleString("en-GB", {
                    day: "numeric",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              </a>
            );
          })}
        </aside>

        {/* The conversation. */}
        <section className="inbox-thread">
          {selected && (
            <>
              <header className="inbox-head">
                <div>
                  <strong>{customerName}</strong>
                  <span className="muted"> · {customerPhone} · WhatsApp</span>
                </div>
                <span className="pill" style={{ color: status?.tone }}>
                  {aiAnswering ? "Belline is answering" : status?.label}
                </span>
              </header>

              {selected.handoffSummary && (
                <div className="inbox-summary">
                  <strong>Handed to you{selected.handoffReason ? ` — ${selected.handoffReason}` : ""}</strong>
                  <p>{selected.handoffSummary}</p>
                </div>
              )}

              <div className="inbox-messages">
                {messages.map((m) => (
                  <div key={m.id} className={`bubble bubble-${m.sender}`}>
                    <span className="bubble-who">
                      {m.sender === "customer"
                        ? customerName
                        : m.sender === "ai"
                          ? "Belline"
                          : m.sender === "human"
                            ? "You"
                            : ""}
                    </span>
                    <p>{m.body || <em>{m.contentType}</em>}</p>
                    <time dateTime={m.createdAt}>
                      {new Date(m.createdAt).toLocaleTimeString("en-GB", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                      {m.deliveryStatus && m.direction === "out" ? ` · ${m.deliveryStatus}` : ""}
                    </time>
                  </div>
                ))}
              </div>

              <footer className="inbox-act">
                {aiAnswering ? (
                  <>
                    <p className="muted">
                      Belline is answering this. Taking over stops it immediately.
                    </p>
                    <button className="btn" onClick={() => act("takeover")} disabled={busy}>
                      Take over
                    </button>
                  </>
                ) : selected.status === "CLOSED" ? (
                  <p className="muted">This conversation is closed.</p>
                ) : (
                  <>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (draft.trim()) act("reply", { text: draft.trim() });
                      }}
                    >
                      <textarea
                        rows={2}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        placeholder={`Reply to ${customerName}`}
                        disabled={busy}
                      />
                      <button className="btn btn-accent" type="submit" disabled={busy || !draft.trim()}>
                        Send
                      </button>
                    </form>
                    <div className="inbox-act-more">
                      <button className="btn" onClick={() => act("release")} disabled={busy}>
                        Return to Belline
                      </button>
                      <button className="btn" onClick={() => act("close")} disabled={busy}>
                        Close
                      </button>
                    </div>
                  </>
                )}
              </footer>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

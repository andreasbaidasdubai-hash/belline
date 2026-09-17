"use client";

import { useEffect, useRef, useState } from "react";
import type { HelpCard } from "@/lib/onboarding/assistant";

/**
 * Setting up by talking to Belle.
 *
 * A plain chat, deliberately. The owner answers in their own words; Belle
 * saves each answer as she goes and says what she saved. What is still
 * missing is always visible beside the conversation, so nobody has to ask
 * "are we done?". When Belle cannot answer, her reply carries the next step's
 * button and help, and a ticket for the team shows its number.
 *
 * The conversation is `BelleChat` on its own so the same chat can be docked
 * beside a setup step (see setup/BelleDock.tsx) rather than only filling this
 * page. It is the one Belle: same props, same endpoint, same turn.
 */

interface Line {
  role: "user" | "assistant";
  content: string;
  help?: HelpCard;
  ticket?: string;
  /** Buttons to dashboard pages Belle offered (link_to_page). */
  links?: { href: string; label: string }[];
}

export function BelleChat({
  locationId,
  step,
  greeting,
  initialDraft,
  onMissing,
  /** Docked, the chat takes the height it is given instead of setting its own. */
  fill = false,
  inputRef,
  handover = false,
}: {
  locationId: string;
  step?: string;
  greeting: string;
  /** A message written for the owner, e.g. from a failed check. They still press send. */
  initialDraft?: string;
  onMissing?: (missing: string[]) => void;
  fill?: boolean;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  /** Offer "Talk to a person", which opens a ticket for the Belline team (api/belle/handover). */
  handover?: boolean;
}) {
  const [lines, setLines] = useState<Line[]>([{ role: "assistant", content: greeting }]);
  const [draft, setDraft] = useState(initialDraft ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [lines, busy]);

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    const next: Line[] = [...lines, { role: "user", content: text }];
    setLines(next);
    setDraft("");
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/setup/assistant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locationId, step, page: window.location.pathname, messages: next.map(({ role, content }) => ({ role, content })) }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        reply?: string;
        missing?: string[];
        error?: string;
        help?: HelpCard;
        ticket?: string;
        links?: { href: string; label: string }[];
      };
      if (!res.ok || !body.reply) {
        setError(body.error ?? "Belle could not answer just then.");
      } else {
        setLines([...next, { role: "assistant", content: body.reply, help: body.help, ticket: body.ticket, links: body.links }]);
        if (body.missing) onMissing?.(body.missing);
      }
    } catch {
      setError("Could not reach Belline. Check your connection.");
    } finally {
      setBusy(false);
    }
  }

  async function askForPerson() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/belle/handover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locationId, page: window.location.pathname, messages: lines.map(({ role, content }) => ({ role, content })) }),
      });
      const body = (await res.json().catch(() => ({}))) as { reply?: string; ticket?: string; error?: string };
      if (!res.ok || !body.reply) setError(body.error ?? "That didn't reach the team. Try again, or email hello@belline.ai.");
      else setLines((prev) => [...prev, { role: "assistant", content: body.reply!, ticket: body.ticket }]);
    } catch {
      setError("Could not reach Belline. Check your connection.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={fill ? undefined : "panel"}
      style={
        fill
          ? { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }
          : { display: "flex", flexDirection: "column", height: "min(640px, 72vh)" }
      }
    >
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "18px 18px 8px", display: "grid", gap: 10, alignContent: "start" }} role="log" aria-live="polite" tabIndex={0} aria-label="Conversation with Belle">
        {lines.map((line, i) => (
          <div key={i} style={{ display: "flex", justifyContent: line.role === "user" ? "flex-end" : "flex-start" }}>
            <p
              style={{
                margin: 0,
                maxWidth: "78%",
                padding: "10px 13px",
                borderRadius: 14,
                fontSize: 14,
                lineHeight: 1.5,
                whiteSpace: "pre-wrap",
                background: line.role === "user" ? "var(--text)" : "var(--panel-2)",
                color: line.role === "user" ? "var(--bg)" : "var(--text)",
              }}
            >
              {line.content}
              {line.ticket && (
                <span style={{ display: "block", marginTop: 8, fontWeight: 600 }}>Ticket {line.ticket}</span>
              )}
              {line.links && line.links.length > 0 && (
                <span style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
                  {line.links.map((l) => (
                    <a key={l.href} href={l.href} className="btn btn-accent" style={{ display: "inline-block" }}>
                      {l.label}
                    </a>
                  ))}
                </span>
              )}
              {line.help && (
                <span style={{ display: "block", marginTop: 10 }}>
                  <a href={line.help.fix} className="btn btn-accent" style={{ display: "inline-block" }}>
                    {line.help.title.replace(/^Step \d+ · /, "Go to ")}
                  </a>
                </span>
              )}
            </p>
          </div>
        ))}
        {busy && <p className="muted" style={{ margin: 0, fontSize: 13 }}>Belle is saving that…</p>}
        <div ref={end} />
      </div>
      {error && <p role="alert" style={{ margin: "0 18px 8px", fontSize: 12.5, color: "var(--bad)" }}>{error}</p>}
      {handover && (
        <div style={{ display: "flex", justifyContent: "flex-end", padding: "0 12px 6px" }}>
          <button type="button" className="btn btn-row" disabled={busy} onClick={() => void askForPerson()}>
            Talk to a person
          </button>
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        style={{ display: "flex", gap: 8, padding: 12, borderTop: "1px solid var(--border)" }}
      >
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={handover ? "Ask anything, or tell Belle what to change" : "e.g. We're open 9 to 8, Saturday to Thursday"}
          aria-label="Your answer"
          maxLength={2000}
          style={{ flex: 1, minWidth: 0 }}
        />
        <button className="btn btn-accent" type="submit" disabled={busy || !draft.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}

export default function SetupAssistant({
  locationId,
  step,
  greeting,
  initialMissing,
  initialDraft,
}: {
  locationId: string;
  step?: string;
  greeting: string;
  initialMissing: string[];
  /** A message written for the owner, e.g. from a failed check. They still press send. */
  initialDraft?: string;
}) {
  const [missing, setMissing] = useState(initialMissing);

  return (
    // The grid lives in globals.css so it can stack on a phone; inline, the
    // 230px side column left the conversation 77px wide at 375.
    <div className="setup-assistant">
      <BelleChat locationId={locationId} step={step} greeting={greeting} initialDraft={initialDraft} onMissing={setMissing} />

      <aside className="panel" style={{ padding: "14px 16px" }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>{missing.length ? "Still to set up" : "Ready to answer"}</div>
        {missing.length ? (
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.7, color: "var(--text-2)" }}>
            {missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        ) : (
          <div style={{ display: "grid", gap: 8, fontSize: 13 }}>
            <a href="/setup/phone">Forward your phone line →</a>
            <a href="/setup/website">Add it to your website →</a>
            <a href="/channels">Talk to it now →</a>
          </div>
        )}
        <p className="muted" style={{ fontSize: 11.5, margin: "14px 0 0", lineHeight: 1.55 }}>
          Every change is saved as a version you can undo on the How it works page.
        </p>
      </aside>
    </div>
  );
}

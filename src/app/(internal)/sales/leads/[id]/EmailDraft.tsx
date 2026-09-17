"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import Action from "../../Actions";

/**
 * The agent's email draft for this lead: read it, edit it, decide.
 *
 * Nothing here can be sent. There is no email sender in Belline yet, so an
 * approved draft is copied or opened in the staff member's own email program
 * and sent from there, and "Mark as sent" records that it was. Every save runs
 * the pre-send checks again, and approve runs them once more on what is saved.
 */

export interface DraftProps {
  id: number;
  company: string;
  status: string;
  toAddress: string | null;
  subject: string;
  body: string;
  parts: { observation: string; problem: string; solution: string; cta: string };
  problems: string[];
  warnings: string[];
  demoUrl?: string;
  sentAt: string | null;
}

const PART_LABELS: [keyof DraftProps["parts"], string][] = [
  ["observation", "Opening: what we noticed about them"],
  ["problem", "The problem it causes"],
  ["solution", "How Belline helps"],
  ["cta", "The ask"],
];

export default function EmailDraft({ draft }: { draft: DraftProps }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ error?: string; problems?: string[]; warnings?: string[]; saved?: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  const editable = ["draft", "pending_approval", "approved"].includes(draft.status);

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/sales/drafts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId: draft.id, action: "save", ...Object.fromEntries(form.entries()) }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; problems?: string[]; warnings?: string[] };
      if (!res.ok) {
        setResult({ error: data.error ?? "That did not save.", problems: data.problems });
        return;
      }
      setResult({ saved: true, problems: data.problems, warnings: data.warnings });
      setEditing(false);
      router.refresh();
    } catch {
      setResult({ error: "Could not reach the server. Nothing was saved." });
    } finally {
      setBusy(false);
    }
  }

  const mailto = draft.toAddress
    ? `mailto:${encodeURIComponent(draft.toAddress)}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body)}`
    : null;

  return (
    <div className="staff-draft">
      <p className="staff-note" style={{ marginBottom: 12 }}>
        Nothing here can be sent: Belline has no email sender yet. Approve the draft, send it from your own email, then
        mark it as sent.
      </p>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
        <span className={`pill staff-pill ${draft.status === "approved" ? "ok" : draft.status === "draft" ? "warn" : draft.status === "sent" ? "accent" : ""}`}>
          {draft.status === "draft" ? "Held back by the checks" : draft.status === "pending_approval" ? "Waiting for review" : draft.status === "approved" ? "Approved" : "Sent by hand"}
        </span>
        <span className="muted" style={{ fontSize: 12.5 }}>
          To {draft.toAddress ?? "no address on file"}
        </span>
      </div>

      {!editing ? (
        <>
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 4 }}>
            Subject
          </div>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 10 }}>{draft.subject}</div>
          <pre>{draft.body}</pre>
        </>
      ) : (
        <form onSubmit={save} style={{ display: "grid", gap: 10 }}>
          <label className="staff-field">
            <span>Subject</span>
            <input name="subject" defaultValue={draft.subject} maxLength={200} required />
          </label>
          {PART_LABELS.map(([key, label]) => (
            <label key={key} className="staff-field">
              <span>{label}</span>
              <textarea name={key} defaultValue={draft.parts[key]} rows={key === "cta" ? 2 : 3} required={key !== "problem"} />
            </label>
          ))}
          <p className="staff-note">The greeting, the demo link, the sign-off and the opt-out line stay as they are. Saving runs the checks again.</p>
          <div className="staff-action-buttons">
            <button type="submit" className="btn btn-accent btn-row" disabled={busy}>
              {busy ? "Checking…" : "Save and check"}
            </button>
            <button type="button" className="btn btn-row" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {(result?.problems?.length ? result.problems : draft.problems).length > 0 && (
        <div className="staff-action-error" style={{ marginTop: 10 }} role="alert">
          The checks refused this draft:
          <ul>
            {(result?.problems?.length ? result.problems : draft.problems).map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      {draft.warnings.length > 0 && (
        <ul className="staff-note" style={{ margin: "8px 0 0", paddingLeft: 18 }}>
          {draft.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      {result?.error && (
        <div className="staff-action-error" role="alert" style={{ marginTop: 8 }}>
          {result.error}
        </div>
      )}
      {result?.saved && !result.problems?.length && (
        <div className="staff-action-done" role="status" style={{ marginTop: 8 }}>
          Saved. The checks passed.
        </div>
      )}

      {!editing && (
        <div className="staff-row-actions" style={{ marginTop: 14 }}>
          {editable && draft.status !== "approved" && (
            <button type="button" className="btn btn-row" onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
          {(draft.status === "pending_approval" || draft.status === "draft") && (
            <Action endpoint="/api/sales/drafts" body={{ messageId: draft.id, action: "approve" }} label="Approve" tone="primary" small disabled={draft.problems.length > 0} />
          )}
          {draft.status === "approved" && (
            <>
              <button
                type="button"
                className="btn btn-row"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(`Subject: ${draft.subject}\n\n${draft.body}`);
                    setCopied(true);
                  } catch {
                    setCopied(false);
                  }
                }}
              >
                {copied ? "Copied" : "Copy"}
              </button>
              {mailto && (
                <a className="btn btn-row" href={mailto}>
                  Open in email app
                </a>
              )}
              <Action
                endpoint="/api/sales/drafts"
                body={{ messageId: draft.id, action: "mark_sent" }}
                label="Mark as sent"
                tone="primary"
                small
                confirm={`Did you send this email to ${draft.toAddress ?? draft.company} from your own email? This records it and moves ${draft.company} to Contacted.`}
                submitLabel="Yes, I sent it"
              />
            </>
          )}
          {editable && (
            <>
              <Action
                endpoint="/api/sales/drafts"
                body={{ messageId: draft.id, action: "reject" }}
                label="Reject"
                small
                reason="What is wrong with this draft?"
                submitLabel="Reject draft"
              />
              <Action
                endpoint="/api/sales/drafts"
                body={{ messageId: draft.id, action: "reject_suppress" }}
                label="Do not contact"
                tone="danger"
                small
                confirm={`Reject this draft and never contact ${draft.company} again, from any agent?`}
                reason="Why should they never be contacted?"
                submitLabel="Never contact them"
              />
            </>
          )}
        </div>
      )}
      {draft.problems.length > 0 && draft.status !== "approved" && !editing && (
        <p className="staff-note" style={{ marginTop: 8 }}>
          A draft the checks refused cannot be approved. Edit it or reject it.
        </p>
      )}
    </div>
  );
}

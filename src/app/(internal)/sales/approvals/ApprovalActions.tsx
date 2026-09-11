"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Approve, reject, or reject and never write to them again.
 *
 * Three buttons rather than two because "this draft is wrong" and "this
 * company should never be contacted" are different decisions, and collapsing
 * them means either suppressing companies by accident or writing to someone
 * who should have been suppressed.
 *
 * A blocked draft cannot be approved from here at all. Overriding a guard is a
 * deliberate act, and it belongs behind fixing the draft rather than behind a
 * button that sits next to the ordinary one.
 */
export default function ApprovalActions({
  messageId,
  blocked,
}: {
  messageId: number;
  blocked: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (action: "approve" | "reject" | "reject_suppress") => {
    if (busy) return;
    let reason: string | null = null;
    if (action !== "approve") {
      reason = window.prompt(
        action === "reject_suppress"
          ? "Why should this company never be contacted?"
          : "What is wrong with this draft?",
      );
      // A rejection without a reason teaches nobody anything, and the reasons
      // are the corpus that shows where the personaliser is going wrong.
      if (reason === null) return;
    }

    setBusy(action);
    setError(null);
    try {
      const response = await fetch("/api/sales/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId, action, reason }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Failed (${response.status})`);
      }
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ marginTop: 16, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      {blocked ? (
        <span className="muted" style={{ fontSize: 12.5 }}>
          Blocked by a guard — fix the draft or reject it.
        </span>
      ) : (
        <button
          type="button"
          className="btn btn-accent"
          disabled={busy !== null}
          onClick={() => act("approve")}
        >
          {busy === "approve" ? "Approving…" : "Approve"}
        </button>
      )}

      <button type="button" className="btn" disabled={busy !== null} onClick={() => act("reject")}>
        Reject
      </button>

      <button
        type="button"
        className="btn btn-danger"
        disabled={busy !== null}
        onClick={() => act("reject_suppress")}
      >
        Reject &amp; never contact
      </button>

      {error && (
        <span style={{ fontSize: 12.5, color: "var(--warn)" }}>{error}</span>
      )}
    </div>
  );
}

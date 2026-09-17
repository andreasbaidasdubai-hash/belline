"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

async function send(body: Record<string, unknown>): Promise<string | null> {
  try {
    const res = await fetch("/api/sales/abuse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return res.ok ? null : (data.error ?? "That did not save.");
  } catch {
    return "Could not reach the server.";
  }
}

/** Allow, note or suspend one flagged signup. The note is written in the page, never in a dialog. */
export default function AbuseActions({ id, status, canSuspend }: { id: string; status: string; canSuspend: boolean }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function act(action: string) {
    setBusy(true);
    setError(null);
    const failed = await send({ id, action, note });
    setBusy(false);
    if (failed) setError(failed);
    else {
      setNote("");
      router.refresh();
    }
  }

  return (
    <div style={{ display: "grid", gap: 6, minWidth: 220 }}>
      <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (needed to save a note; optional to allow or suspend)" aria-label="Note" rows={2} maxLength={1000} />
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {status !== "allowed" && (
          <button className="btn btn-accent btn-row" type="button" disabled={busy} onClick={() => void act("allow")}>
            Allow
          </button>
        )}
        <button className="btn btn-row" type="button" disabled={busy || !note.trim()} onClick={() => void act("note")}>
          Save note
        </button>
        {canSuspend && status !== "suspended" && (
          <button className="btn btn-row" type="button" disabled={busy} onClick={() => void act("suspend")}>
            Suspend trial
          </button>
        )}
        {canSuspend && status === "suspended" && (
          <button className="btn btn-row" type="button" disabled={busy} onClick={() => void act("unsuspend")}>
            Lift suspension
          </button>
        )}
      </div>
      {error && (
        <p role="alert" style={{ margin: 0, fontSize: 12, color: "var(--bl-danger)" }}>
          {error}
        </p>
      )}
    </div>
  );
}

/** Mark an owner's email address confirmed, when the team has checked it by hand. */
export function VerifyButton({ userId }: { userId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div>
      <button
        className="btn btn-row"
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const failed = await send({ userId, action: "verify" });
          setBusy(false);
          if (failed) setError(failed);
          else router.refresh();
        }}
      >
        Mark email confirmed
      </button>
      {error && (
        <p role="alert" style={{ margin: "4px 0 0", fontSize: 12, color: "var(--bl-danger)" }}>
          {error}
        </p>
      )}
    </div>
  );
}

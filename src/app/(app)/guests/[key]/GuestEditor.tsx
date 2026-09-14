"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Correct a customer's name or email — applied to every booking under their number. */
export default function GuestEditor({
  locationId,
  guestKey,
  name: initialName,
  email: initialEmail,
}: {
  locationId: string;
  guestKey: string;
  name: string;
  email: string;
}) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [email, setEmail] = useState(initialEmail);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const changed = name !== initialName || email !== initialEmail;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNote(null);
    const res = await fetch("/api/guests/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ locationId, key: guestKey, name, email }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string; updated?: number };
    setBusy(false);
    if (!res.ok) {
      setNote({ text: body.error ?? "Could not save.", bad: true });
      return;
    }
    setNote({ text: `Saved on ${body.updated ?? 0} booking${body.updated === 1 ? "" : "s"}.`, bad: false });
    router.refresh();
  }

  return (
    <form className="panel" onSubmit={save} style={{ padding: "14px 16px", display: "grid", gap: 10 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600 }}>Details</div>
      <label style={{ display: "grid", gap: 5 }}>Name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label style={{ display: "grid", gap: 5 }}>Email<input value={email} onChange={(e) => setEmail(e.target.value)} inputMode="email" placeholder="Not known yet" /></label>
      {note && <p role="status" style={{ margin: 0, fontSize: 12.5, color: note.bad ? "var(--bad)" : "var(--ok)" }}>{note.text}</p>}
      <button className="btn btn-accent" disabled={busy || !changed}>{busy ? "Saving…" : "Save"}</button>
    </form>
  );
}

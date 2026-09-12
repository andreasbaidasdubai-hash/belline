"use client";

import { useState } from "react";

/** Add somebody to the waitlist from the desk, or take somebody off. */
export function AddToWaitlist({
  locationId,
  restaurant,
  today,
}: {
  locationId: string;
  restaurant: boolean;
  today: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          locationId,
          guestName: form.get("name"),
          guestPhone: form.get("phone"),
          date: form.get("date"),
          earliest: form.get("earliest"),
          latest: form.get("latest"),
          partySize: Number(form.get("partySize") || 2),
          notes: form.get("notes"),
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "That didn't save.");
        return;
      }
      window.location.reload();
    } catch {
      setError("That didn't save.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className="btn btn-accent" onClick={() => setOpen(true)}>
        + Add someone
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="panel" style={{ padding: 18, display: "grid", gap: 12, maxWidth: 520 }}>
      <div className="split" style={{ gap: 12 }}>
        <div>
          <label htmlFor="wl-name">Name</label>
          <input id="wl-name" name="name" required autoComplete="off" />
        </div>
        <div>
          <label htmlFor="wl-phone">Phone</label>
          <input id="wl-phone" name="phone" inputMode="tel" autoComplete="off" />
        </div>
      </div>
      <div className="split" style={{ gap: 12 }}>
        <div>
          <label htmlFor="wl-date">Day</label>
          <input id="wl-date" name="date" type="date" defaultValue={today} required />
        </div>
        {restaurant && (
          <div>
            <label htmlFor="wl-party">Party</label>
            <input id="wl-party" name="partySize" type="number" min={1} max={20} defaultValue={2} />
          </div>
        )}
      </div>
      <div className="split" style={{ gap: 12 }}>
        <div>
          <label htmlFor="wl-earliest">From</label>
          <input id="wl-earliest" name="earliest" placeholder="7:00 PM" required />
        </div>
        <div>
          <label htmlFor="wl-latest">Until</label>
          <input id="wl-latest" name="latest" placeholder="9:00 PM" required />
        </div>
      </div>
      <div>
        <label htmlFor="wl-notes">Notes</label>
        <input id="wl-notes" name="notes" placeholder="Terrace if possible" />
      </div>
      {error && <p style={{ margin: 0, fontSize: 12.5, color: "var(--bad)" }}>{error}</p>}
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn btn-accent" type="submit" disabled={busy}>
          {busy ? "Adding…" : "Add to the waitlist"}
        </button>
        <button className="btn" type="button" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function RemoveFromWaitlist({ id, name }: { id: string; name: string }) {
  const [busy, setBusy] = useState(false);

  async function remove() {
    if (!window.confirm(`Take ${name} off the waitlist?`)) return;
    setBusy(true);
    try {
      await fetch(`/api/waitlist?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      window.location.reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button className="btn btn-row" onClick={remove} disabled={busy}>
      {busy ? "Removing…" : "Remove"}
    </button>
  );
}

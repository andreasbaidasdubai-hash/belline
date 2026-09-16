"use client";

import { useState } from "react";

/**
 * WhatsApp while self-serve waits on Meta: a real way to get it, not a dead
 * "Coming soon". Opens a ticket for the team (POST /api/whatsapp/assisted).
 */
export default function WhatsAppAssisted({ locationId, ticket: initialTicket }: { locationId: string; ticket?: string }) {
  const [ticket, setTicket] = useState(initialTicket ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function ask() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/whatsapp/assisted", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locationId }),
      });
      const data = (await res.json().catch(() => ({}))) as { ticket?: string; error?: string };
      if (!res.ok || !data.ticket) setError(data.error ?? "That did not go through. Try again in a moment.");
      else setTicket(data.ticket);
    } catch {
      setError("Could not reach Belline. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (ticket) {
    return (
      <p role="status" style={{ fontSize: 13, lineHeight: 1.55, margin: "10px 0 0", color: "var(--text)" }}>
        Asked — ticket {ticket}. We will contact you at the email address on your account to set up your WhatsApp number.
      </p>
    );
  }
  return (
    <div style={{ marginTop: 10 }}>
      <button type="button" className="btn btn-accent" onClick={ask} disabled={busy} style={{ padding: "8px 14px", fontSize: 13.5 }}>
        {busy ? "Sending…" : "Set it up with us"}
      </button>
      {error && (
        <p role="alert" style={{ fontSize: 13, color: "var(--bad)", margin: "6px 0 0" }}>
          {error}
        </p>
      )}
    </div>
  );
}

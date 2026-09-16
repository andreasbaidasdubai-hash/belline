"use client";

import { useRef, useState } from "react";
import PhoneField, { type PhoneFieldHandle } from "@/components/PhoneField";

/**
 * The venue's Belline number: the one its calls are forwarded to.
 *
 * Buy it in Twilio, point its voice webhook at /api/twilio/voice, then record
 * it here. Until this exists for a venue, its forwarded calls reach nobody.
 *
 * Recording is the whole of it: nothing here buys a number, configures Twilio
 * or dials anything. What it writes is `location.bellineNumber`, which is the
 * field the voice webhook routes on — so a wrong value silently points a live
 * venue's calls at the wrong diary. Hence the confirmation and the audit row.
 * It never changes the business's own phone, which is shown in its own column.
 */
export default function NumberCell({
  venueId,
  venueName,
  bellineNumber,
  via,
  market,
}: {
  venueId: string;
  venueName: string;
  bellineNumber: string;
  via: "pool" | "staff" | "legacy" | null;
  /** The venue's market (ISO), the country picker's default. */
  market: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<PhoneFieldHandle>(null);

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    if (field.current && !field.current.check()) return;

    const form = new FormData(e.currentTarget);
    const next = String(form.get("phone") ?? "").trim();
    // Named, and quoting both numbers. This row is one of twenty and the wrong
    // one is a keystroke away; "are you sure?" would not tell anybody which
    // venue they were about to redirect.
    const question = bellineNumber
      ? `Change the Belline number for ${venueName} from ${bellineNumber} to ${next || "none"}?\n\n` +
        `Calls forwarded to ${bellineNumber} will stop reaching this venue.`
      : `Record ${next || "no number"} as the Belline number for ${venueName}?`;
    if (!window.confirm(question)) return;

    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/sales/clients/number", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ venueId, phone: next }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "That didn't work.");
        return;
      }
      window.location.reload();
    } catch {
      setError("That didn't work.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return bellineNumber ? (
      <div style={{ fontSize: 12.5 }}>
        <span className="mono">{bellineNumber}</span>
        {via && <span className="muted" style={{ fontSize: 11 }}> · {via}</span>}
        <button className="btn btn-row" style={{ marginLeft: 8 }} onClick={() => setOpen(true)}>
          Change
        </button>
      </div>
    ) : (
      <button className="btn btn-row" onClick={() => setOpen(true)}>
        Record a number
      </button>
    );
  }

  return (
    <form onSubmit={save} style={{ display: "grid", gap: 6, minWidth: 240 }}>
      <PhoneField
        ref={field}
        id={`belline-number-${venueId}`}
        label="Belline number"
        name="phone"
        value={bellineNumber}
        defaultCountry={market}
        serverError={error ?? undefined}
        compact
      />
      <div style={{ display: "flex", gap: 6 }}>
        <button className="btn btn-accent btn-row" type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button className="btn btn-row" type="button" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

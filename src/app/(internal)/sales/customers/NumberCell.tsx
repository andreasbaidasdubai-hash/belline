"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import PhoneField, { type PhoneFieldHandle } from "@/components/PhoneField";

/**
 * A location's Belline number: the one its calls are forwarded to.
 *
 * Buy it in Twilio, point its voice webhook at /api/twilio/voice, then record
 * it here. Until this exists for a location, its forwarded calls reach nobody.
 *
 * Recording is the whole of it: nothing here buys a number, configures Twilio
 * or dials anything. What it writes is `location.bellineNumber`, the field the
 * voice webhook routes on, so a wrong value silently points a live venue's
 * calls at the wrong diary. Hence the in-page confirmation that names the
 * venue and both numbers, and the audit row. It never changes the business's
 * own phone.
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
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const field = useRef<PhoneFieldHandle>(null);

  function ask(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    if (field.current && !field.current.check()) return;
    setPending(String(new FormData(e.currentTarget).get("phone") ?? "").trim());
  }

  async function save(next: string) {
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
        setPending(null);
        return;
      }
      setPending(null);
      setOpen(false);
      router.refresh();
    } catch {
      setError("That didn't work.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return bellineNumber ? (
      <div style={{ fontSize: 13 }}>
        <span className="mono">{bellineNumber}</span>
        {via && <span className="muted" style={{ fontSize: 11.5 }}> · {via === "pool" ? "from the pool" : via === "staff" ? "recorded by staff" : "from before"}</span>}
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

  if (pending !== null) {
    // Named, and quoting both numbers: the wrong row is one click away, and
    // "are you sure?" would not say which venue is about to be redirected.
    return (
      <div className="staff-action-form" role="alertdialog" aria-label={`Confirm the Belline number for ${venueName}`}>
        <p className="staff-action-question">
          {bellineNumber
            ? `Change the Belline number for ${venueName} from ${bellineNumber} to ${pending || "none"}? Calls forwarded to ${bellineNumber} will stop reaching this venue.`
            : `Record ${pending || "no number"} as the Belline number for ${venueName}?`}
        </p>
        <div className="staff-action-buttons">
          <button className="btn btn-accent btn-row" type="button" disabled={busy} onClick={() => void save(pending)}>
            {busy ? "Saving…" : "Yes, save it"}
          </button>
          <button className="btn btn-row" type="button" disabled={busy} onClick={() => setPending(null)}>
            Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={ask} style={{ display: "grid", gap: 6, minWidth: 240 }}>
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
          Save
        </button>
        <button className="btn btn-row" type="button" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

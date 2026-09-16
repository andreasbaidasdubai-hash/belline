"use client";

import { useState } from "react";

/**
 * Which calendars Belline uses, and the way to disconnect: Google Calendar's
 * and Outlook's, each against its own route.
 *
 * The venue calendar is where bookings go and busy times are read. A person
 * can have their own: something in it blocks only them. The server checks
 * every pick against the calendars the account can add events to.
 */
export default function CalendarControls({
  endpoint,
  idPrefix,
  locationId,
  calendars,
  calendarId,
  staff,
  staffCalendars,
}: {
  /** The integration's route: /api/integrations/google or /api/integrations/microsoft. */
  endpoint: string;
  /** Keeps the form's ids apart when both kinds are on one page. */
  idPrefix: string;
  locationId: string;
  /** Null when they could not be loaded just now. */
  calendars: { id: string; name: string }[] | null;
  calendarId: string;
  staff: { id: string; name: string }[];
  staffCalendars: Record<string, string>;
}) {
  const [venueCal, setVenueCal] = useState(calendarId);
  const [perStaff, setPerStaff] = useState<Record<string, string>>(staffCalendars);
  const [busy, setBusy] = useState<"save" | "disconnect" | null>(null);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);

  /** A sentence the server wants the owner to read after a success (Outlook's disconnect). */
  const [after, setAfter] = useState<string | null>(null);

  /** Null on success with nothing to say, `{ said }` on success with a sentence, `{ problem }` on failure. */
  async function call(method: "POST" | "DELETE", body: Record<string, unknown>): Promise<{ problem?: string; said?: string } | null> {
    try {
      const res = await fetch(endpoint, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; said?: string };
      if (res.ok) return data.said ? { said: data.said } : null;
      return { problem: data.error ?? "That did not save. Try again." };
    } catch {
      return { problem: "Could not reach Belline. Check your connection and try again." };
    }
  }

  async function save() {
    setBusy("save");
    setSaid(null);
    const out = await call("POST", { locationId, calendarId: venueCal, staffCalendars: perStaff });
    setBusy(null);
    setSaid(out?.problem ? { ok: false, text: out.problem } : { ok: true, text: "Saved." });
  }

  async function disconnect() {
    setBusy("disconnect");
    setSaid(null);
    const out = await call("DELETE", { locationId });
    if (out?.problem) {
      setBusy(null);
      setSaid({ ok: false, text: out.problem });
      return;
    }
    // Microsoft has no way for Belline to withdraw the permission itself, so its
    // answer says where the owner does; that stays on screen until they move on.
    if (out?.said) {
      setBusy(null);
      setAfter(out.said);
      return;
    }
    window.location.reload();
  }

  if (after) {
    return (
      <p role="status" style={{ fontSize: 13, marginTop: 16, maxWidth: 520 }}>
        {after}
      </p>
    );
  }

  return (
    <div style={{ marginTop: 16, display: "grid", gap: 12, maxWidth: 520 }}>
      {calendars === null ? (
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>
          Belline could not load your calendars just now. Reload this page in a minute.
        </p>
      ) : (
        <>
          <div>
            <label htmlFor={`${idPrefix}-calendar`} style={{ fontSize: 13, textTransform: "none", letterSpacing: 0 }}>
              Calendar for bookings
            </label>
            <select id={`${idPrefix}-calendar`} value={venueCal} onChange={(e) => setVenueCal(e.target.value)}>
              {calendars.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          {staff.length > 0 && (
            <fieldset style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 8 }}>
              <legend className="muted" style={{ fontSize: 12.5, marginBottom: 4 }}>
                A person&apos;s own calendar (optional). Busy there blocks only them.
              </legend>
              {staff.map((s) => (
                <div key={s.id}>
                  <label htmlFor={`${idPrefix}-staff-${s.id}`} style={{ fontSize: 13, textTransform: "none", letterSpacing: 0 }}>
                    {s.name}
                  </label>
                  <select
                    id={`${idPrefix}-staff-${s.id}`}
                    value={perStaff[s.id] ?? ""}
                    onChange={(e) => setPerStaff({ ...perStaff, [s.id]: e.target.value })}
                  >
                    <option value="">Same as above</option>
                    {calendars.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </fieldset>
          )}
        </>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {calendars !== null && (
          <button type="button" className="btn btn-accent" onClick={save} disabled={busy !== null}>
            {busy === "save" ? "Saving…" : "Save calendars"}
          </button>
        )}
        <button type="button" className="btn" onClick={disconnect} disabled={busy !== null}>
          {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
        </button>
      </div>
      {said && (
        <p role={said.ok ? "status" : "alert"} style={{ fontSize: 13, margin: 0, color: said.ok ? "var(--text)" : "var(--bad)" }}>
          {said.text}
        </p>
      )}
    </div>
  );
}

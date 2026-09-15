"use client";

import { useState } from "react";

/**
 * Which calendars Belline uses, and the way to disconnect.
 *
 * The venue calendar is where bookings go and busy times are read. A person
 * can have their own: something in it blocks only them. The server checks
 * every pick against the calendars the Google account can add events to.
 */
export default function GoogleCalendarControls({
  locationId,
  calendars,
  calendarId,
  staff,
  staffCalendars,
}: {
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

  async function call(method: "POST" | "DELETE", body: Record<string, unknown>): Promise<string | null> {
    try {
      const res = await fetch("/api/integrations/google", {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) return null;
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      return data.error ?? "That did not save. Try again.";
    } catch {
      return "Could not reach Belline. Check your connection and try again.";
    }
  }

  async function save() {
    setBusy("save");
    setSaid(null);
    const problem = await call("POST", { locationId, calendarId: venueCal, staffCalendars: perStaff });
    setBusy(null);
    setSaid(problem ? { ok: false, text: problem } : { ok: true, text: "Saved." });
  }

  async function disconnect() {
    setBusy("disconnect");
    setSaid(null);
    const problem = await call("DELETE", { locationId });
    if (problem) {
      setBusy(null);
      setSaid({ ok: false, text: problem });
      return;
    }
    window.location.reload();
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
            <label htmlFor="google-calendar" style={{ fontSize: 13, textTransform: "none", letterSpacing: 0 }}>
              Calendar for bookings
            </label>
            <select id="google-calendar" value={venueCal} onChange={(e) => setVenueCal(e.target.value)}>
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
                  <label htmlFor={`google-staff-${s.id}`} style={{ fontSize: 13, textTransform: "none", letterSpacing: 0 }}>
                    {s.name}
                  </label>
                  <select
                    id={`google-staff-${s.id}`}
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

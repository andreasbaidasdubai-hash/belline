"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Which calendars Belline uses, who uses which, and the way to disconnect:
 * Google Calendar's and Outlook's, each against its own route.
 *
 * The venue calendar is where bookings go and busy times are read for
 * everyone. A person can have their own: Belline reads it for busy times too,
 * something there blocks only them, and their bookings are added to it (see
 * `calendarFor` and `isBusy` in integrations/google.ts and outlook.ts). The
 * server checks every pick against the calendars the account can add events to.
 *
 * People are added, renamed and removed straight away through
 * /api/calendars/people (integrations/calendar-people.ts), and only where the
 * venue is not on Belline's diary: a diary venue keeps its team on the Venue
 * page with their hours. Calendar picks are saved with the button, so a pick
 * made before adding somebody is still on screen afterwards: the page refreshes
 * its list of people, and this component keeps its own state.
 */
export default function CalendarControls({
  endpoint,
  idPrefix,
  service,
  locationId,
  calendars,
  calendarId,
  staff,
  staffCalendars,
  mapsPeople,
  canEditPeople,
}: {
  /** The integration's route: /api/integrations/google or /api/integrations/microsoft. */
  endpoint: string;
  /** Keeps the form's ids apart when both kinds are on one page. */
  idPrefix: string;
  /** "Google Calendar" or "Outlook", for the sentences. */
  service: string;
  locationId: string;
  /** Null when they could not be loaded just now. */
  calendars: { id: string; name: string }[] | null;
  calendarId: string;
  staff: { id: string; name: string }[];
  staffCalendars: Record<string, string>;
  /** False for a restaurant: tables are booked, not people. */
  mapsPeople: boolean;
  /** The owner can add, rename and remove people here (not a diary venue). */
  canEditPeople: boolean;
}) {
  const router = useRouter();
  const [venueCal, setVenueCal] = useState(calendarId);
  const [perStaff, setPerStaff] = useState<Record<string, string>>(staffCalendars);
  const [busy, setBusy] = useState<"save" | "disconnect" | "people" | null>(null);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

  /** A sentence the server wants the owner to read after a success (Outlook's disconnect). */
  const [after, setAfter] = useState<string | null>(null);

  /** Null on success with nothing to say, `{ said }` on success with a sentence, `{ problem }` on failure. */
  async function call(url: string, method: "POST" | "DELETE", body: Record<string, unknown>): Promise<{ problem?: string; said?: string } | null> {
    try {
      const res = await fetch(url, {
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
    // Only people still on the list: a pick for somebody just removed would be refused.
    const picks = Object.fromEntries(Object.entries(perStaff).filter(([id, cal]) => cal && staff.some((s) => s.id === id)));
    const out = await call(endpoint, "POST", { locationId, calendarId: venueCal, staffCalendars: picks });
    setBusy(null);
    setSaid(out?.problem ? { ok: false, text: out.problem } : { ok: true, text: "Saved." });
    if (!out?.problem) router.refresh();
  }

  async function people(body: Record<string, unknown>, done: string): Promise<boolean> {
    setBusy("people");
    setSaid(null);
    const out = await call("/api/calendars/people", "POST", { locationId, ...body });
    setBusy(null);
    if (out?.problem) {
      setSaid({ ok: false, text: out.problem });
      return false;
    }
    setSaid({ ok: true, text: done });
    router.refresh();
    return true;
  }

  async function add() {
    const name = newName.trim();
    if (!name) {
      setSaid({ ok: false, text: "Type their name." });
      return;
    }
    if (await people({ action: "add", name }, `${name} added. Pick their calendar, then save.`)) setNewName("");
  }

  async function rename() {
    if (!renaming) return;
    if (await people({ action: "rename", staffId: renaming.id, name: renaming.name }, "Name saved.")) setRenaming(null);
  }

  async function remove(person: { id: string; name: string }) {
    if (!window.confirm(`Remove ${person.name}? Their bookings stay; upcoming ones in their own calendar move to the venue calendar.`)) return;
    if (await people({ action: "remove", staffId: person.id }, `${person.name} removed.`)) {
      const { [person.id]: _gone, ...rest } = perStaff;
      setPerStaff(rest);
    }
  }

  async function disconnect() {
    setBusy("disconnect");
    setSaid(null);
    const out = await call(endpoint, "DELETE", { locationId });
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
      <p role="status" style={{ fontSize: 13, marginTop: 16, maxWidth: 560 }}>
        {after}
      </p>
    );
  }

  const label = { fontSize: 13, textTransform: "none" as const, letterSpacing: 0 };
  const nameOf = (id: string) => calendars?.find((c) => c.id === id)?.name;

  return (
    <div style={{ marginTop: 16, display: "grid", gap: 14, maxWidth: 640 }}>
      {calendars === null ? (
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>
          Belline could not load your calendars just now. Reload this page in a minute.
        </p>
      ) : (
        <div>
          <label htmlFor={`${idPrefix}-calendar`} style={label}>
            Venue calendar
          </label>
          <select id={`${idPrefix}-calendar`} value={venueCal} onChange={(e) => setVenueCal(e.target.value)}>
            {calendars.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <p className="muted" style={{ fontSize: 12.5, margin: "6px 0 0" }}>
            Bookings go here unless the person has their own calendar below. Anything busy here blocks everyone.
          </p>
        </div>
      )}

      {mapsPeople && (
        <section aria-labelledby={`${idPrefix}-people`} style={{ display: "grid", gap: 8 }}>
          <h3 id={`${idPrefix}-people`} style={{ fontSize: 14, margin: 0 }}>
            Who uses which calendar
          </h3>
          <p className="muted" style={{ fontSize: 12.5, margin: 0, lineHeight: 1.55 }}>
            When someone uses their own {service} calendar, Belline checks it for busy times before offering them, and adds
            their bookings to it. Busy there blocks only them.
            {canEditPeople
              ? " Belline books appointments with the people on this list, during your opening hours."
              : " Your team and their hours are kept on the Venue page."}
          </p>

          {staff.length === 0 ? (
            <p className="muted" style={{ fontSize: 13, margin: 0 }}>
              {canEditPeople ? "Nobody on the list yet. Add the people customers book with." : "Nobody is on your team list yet."}
            </p>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
              {staff.map((s) => (
                <li
                  key={s.id}
                  style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", padding: "8px 0", borderTop: "1px solid var(--border-soft)" }}
                >
                  {renaming?.id === s.id ? (
                    <input
                      aria-label={`New name for ${s.name}`}
                      value={renaming.name}
                      maxLength={60}
                      onChange={(e) => setRenaming({ id: s.id, name: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") rename();
                        if (e.key === "Escape") setRenaming(null);
                      }}
                      style={{ flex: "1 1 160px", minWidth: 0 }}
                      autoFocus
                    />
                  ) : (
                    <label htmlFor={`${idPrefix}-staff-${s.id}`} style={{ ...label, flex: "1 1 160px", fontWeight: 600, margin: 0 }}>
                      {s.name}
                    </label>
                  )}
                  {calendars !== null && (
                    <select
                      id={`${idPrefix}-staff-${s.id}`}
                      aria-label={`Calendar for ${s.name}`}
                      value={perStaff[s.id] ?? ""}
                      onChange={(e) => setPerStaff({ ...perStaff, [s.id]: e.target.value })}
                      style={{ flex: "2 1 200px", minWidth: 0 }}
                    >
                      <option value="">Venue calendar{nameOf(venueCal) ? ` (${nameOf(venueCal)})` : ""}</option>
                      {calendars.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  )}
                  {canEditPeople && (
                    <span style={{ display: "flex", gap: 6 }}>
                      {renaming?.id === s.id ? (
                        <>
                          <button type="button" className="btn btn-row" onClick={rename} disabled={busy !== null}>
                            Save name
                          </button>
                          <button type="button" className="btn btn-row" onClick={() => setRenaming(null)} disabled={busy !== null}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button type="button" className="btn btn-row" onClick={() => setRenaming({ id: s.id, name: s.name })} disabled={busy !== null}>
                            Rename
                          </button>
                          <button type="button" className="btn btn-row" onClick={() => remove(s)} disabled={busy !== null}>
                            Remove
                          </button>
                        </>
                      )}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}

          {canEditPeople && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
              <input
                aria-label="Name of the person to add"
                placeholder="Name"
                value={newName}
                maxLength={60}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") add();
                }}
                style={{ flex: "1 1 200px", minWidth: 0 }}
              />
              <button type="button" className="btn" onClick={add} disabled={busy !== null}>
                {busy === "people" ? "Saving…" : "Add person"}
              </button>
            </div>
          )}
        </section>
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

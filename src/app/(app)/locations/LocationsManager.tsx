"use client";

import { useEffect, useRef, useState } from "react";
import PhoneField, { type PhoneFieldHandle } from "@/components/PhoneField";
import { useRouter } from "next/navigation";
import type { Vertical, WeeklyHours } from "@/lib/types";
import type { RemovalBlock } from "@/lib/locations";
import { TRADES, TRADE_GROUPS, tradeLabel } from "@/lib/signup-rules";
import { minutesToClock } from "@/lib/time";

/**
 * Locations, managed the way a business with branches expects.
 *
 * Cards rather than a table, because a location is a place with a name and an
 * address, not a row. Editing happens in a side drawer so the list stays in
 * view. Archiving and deleting open one confirmation dialog that says what
 * will happen — or, when a rule stops it, which rule and the way out — using
 * the same checks the API enforces (lib/locations.ts `removalOf`), so nothing
 * offered here fails when pressed.
 */

interface Venue {
  id: string;
  name: string;
  vertical: Vertical;
  tradeKey?: string;
  timezone: string;
  address: string;
  phone: string;
  currency: string;
  hours: WeeklyHours;
  closures: string[];
  archivedAt: string | null;
  hasBellineNumber: boolean;
  usage: { bookings: number; upcoming: number; calls: number };
  archiveBlock: RemovalBlock | null;
  deleteBlock: RemovalBlock | null;
}

type AddState = { allowed: true; sentence: string } | { allowed: false; reason: string; choosePlan: boolean };

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function toMinutes(clock: string): number {
  const [h, m] = clock.split(":").map(Number);
  return h * 60 + (m || 0);
}

async function post(body: Record<string, unknown>) {
  const res = await fetch("/api/locations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; locationId?: string; field?: string };
  return { ok: res.ok, ...data };
}

export default function LocationsManager({
  venues,
  canManage,
  timezones,
  add,
}: {
  venues: Venue[];
  canManage: boolean;
  timezones: string[];
  add: AddState;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<Venue | "new" | null>(null);
  const [removing, setRemoving] = useState<{ venue: Venue; intent: "archive" | "delete" } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const active = venues.filter((v) => !v.archivedAt);
  const archived = venues.filter((v) => v.archivedAt);

  async function act(body: Record<string, unknown>, done: string): Promise<string | null> {
    const result = await post(body);
    if (!result.ok) return result.error ?? "That did not work.";
    setNotice(done);
    router.refresh();
    return null;
  }

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 12, flexWrap: "wrap" }}>
        <span className="muted" style={{ fontSize: 13 }}>
          {active.length} active{archived.length ? ` · ${archived.length} archived` : ""}
        </span>
        {canManage && add.allowed && (
          <span style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span className="muted" style={{ fontSize: 12.5 }}>{add.sentence}</span>
            <button className="btn btn-accent" onClick={() => setEditing("new")}>
              Add a location
            </button>
          </span>
        )}
      </div>

      {/* Not a button that fails: when the plan does not allow another
          location, say so, and offer the plan where one can be chosen. */}
      {canManage && !add.allowed && (
        <div className="panel" role="note" style={{ padding: "12px 16px", marginBottom: 14, fontSize: 13, lineHeight: 1.55 }}>
          <strong style={{ display: "block", marginBottom: 2 }}>Adding a location</strong>
          {add.reason}
          {add.choosePlan && (
            <>
              {" "}
              <a href="/checkout" style={{ color: "var(--accent)", textDecoration: "underline" }}>Choose a plan</a>
            </>
          )}
        </div>
      )}

      {notice && (
        <div className="cal-toast" role="status" style={{ position: "static" }}>
          {notice}
        </div>
      )}

      <div className="loc-grid">
        {active.map((v) => (
          <VenueCard key={v.id} venue={v} canManage={canManage} onEdit={() => setEditing(v)} onRemove={(intent) => setRemoving({ venue: v, intent })} />
        ))}
      </div>

      {archived.length > 0 && (
        <>
          <h2 style={{ fontSize: 15, margin: "28px 0 10px" }}>Archived</h2>
          <p className="muted" style={{ fontSize: 12.5, margin: "0 0 10px" }}>
            Not answering and hidden everywhere else. Bookings and calls are kept.
          </p>
          <div className="loc-grid">
            {archived.map((v) => (
              <VenueCard
                key={v.id}
                venue={v}
                canManage={canManage}
                onEdit={() => setEditing(v)}
                onRemove={(intent) => setRemoving({ venue: v, intent })}
                restoreBlocked={add.allowed ? undefined : add.reason}
                onRestore={() => act({ action: "restore", locationId: v.id }, `${v.name} restored.`).then((error) => { if (error) setNotice(error); })}
              />
            ))}
          </div>
        </>
      )}

      {editing && (
        <VenueDrawer
          venue={editing === "new" ? null : editing}
          timezones={timezones}
          onClose={() => setEditing(null)}
          onSaved={(message, locationId) => {
            setEditing(null);
            setNotice(message);
            if (locationId) router.push(`/setup/assistant?loc=${locationId}`);
            else router.refresh();
          }}
        />
      )}

      {removing && (
        <RemoveDialog
          venue={removing.venue}
          intent={removing.intent}
          onClose={() => setRemoving(null)}
          onIntent={(intent) => setRemoving({ ...removing, intent })}
          onAct={async (body, done) => {
            const error = await act(body, done);
            if (!error) setRemoving(null);
            return error;
          }}
        />
      )}
    </>
  );
}

function VenueCard({
  venue,
  canManage,
  onEdit,
  onRemove,
  onRestore,
  restoreBlocked,
}: {
  venue: Venue;
  canManage: boolean;
  onEdit: () => void;
  onRemove: (intent: "archive" | "delete") => void;
  onRestore?: () => void;
  /** Restoring adds an answering location, so it follows the same limit as adding one. */
  restoreBlocked?: string;
}) {
  return (
    <div className="panel" style={{ padding: "16px 18px", opacity: venue.archivedAt ? 0.8 : 1 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" }}>
        <strong style={{ fontSize: 15 }}>{venue.name}</strong>
        <span className="pill">{tradeLabel(venue.tradeKey, venue.vertical)}</span>
      </div>
      <p className="muted" style={{ fontSize: 12.5, margin: "6px 0 0", lineHeight: 1.55 }}>
        {venue.address || "No address yet"}
        <br />
        {venue.phone || "No number yet"} · {venue.timezone}
      </p>
      <p style={{ fontSize: 12.5, margin: "10px 0 0" }}>
        {venue.usage.upcoming} upcoming · {venue.usage.bookings} bookings · {venue.usage.calls} calls
      </p>

      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        {!venue.archivedAt && (
          <>
            <a className="btn" href={`/calendar?loc=${venue.id}`}>Open</a>
            <button className="btn" onClick={onEdit} aria-label={`Edit ${venue.name}`}>Edit</button>
          </>
        )}
        {canManage && !venue.archivedAt && (
          <button className="btn" onClick={() => onRemove("archive")} aria-label={`Archive ${venue.name}`}>Archive</button>
        )}
        {canManage && venue.archivedAt && onRestore && !restoreBlocked && (
          <button className="btn" onClick={onRestore} aria-label={`Restore ${venue.name}`}>Restore</button>
        )}
        {canManage && (
          <button className="btn btn-danger" onClick={() => onRemove("delete")} aria-label={`Delete ${venue.name}`}>Delete</button>
        )}
      </div>
      {canManage && venue.archivedAt && restoreBlocked && (
        <p className="muted" style={{ fontSize: 12, margin: "8px 0 0", lineHeight: 1.5 }}>
          It cannot be restored yet: {restoreBlocked.charAt(0).toLowerCase() + restoreBlocked.slice(1)}
        </p>
      )}
    </div>
  );
}

/**
 * Confirming an archive or a delete.
 *
 * A native <dialog> opened with showModal(): the browser keeps focus inside
 * it, makes the page behind inert, closes it on Escape (the `cancel` event,
 * routed through onClose so React state agrees) and returns focus to the
 * button that opened it. Focus starts on the first thing to do — the name
 * field for a delete, otherwise the safe choice.
 */
function RemoveDialog({
  venue,
  intent,
  onClose,
  onIntent,
  onAct,
}: {
  venue: Venue;
  intent: "archive" | "delete";
  onClose: () => void;
  onIntent: (intent: "archive" | "delete") => void;
  onAct: (body: Record<string, unknown>, done: string) => Promise<string | null>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const block = intent === "archive" ? venue.archiveBlock : venue.deleteBlock;
  const titleId = `remove-${venue.id}-title`;
  const bodyId = `remove-${venue.id}-body`;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const opener = document.activeElement as HTMLElement | null;
    if (!dialog.open) dialog.showModal();
    const cancel = (event: Event) => {
      event.preventDefault();
      onClose();
    };
    dialog.addEventListener("cancel", cancel);
    return () => {
      dialog.removeEventListener("cancel", cancel);
      if (dialog.open) dialog.close();
      opener?.focus?.();
    };
    // Opened once per dialog; switching intent keeps it open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setTyped("");
    setError(null);
    ref.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, [intent]);

  async function run(body: Record<string, unknown>, done: string) {
    setBusy(true);
    setError(null);
    const failed = await onAct(body, done);
    setBusy(false);
    if (failed) setError(failed);
  }

  const archiveInstead = intent === "delete" && block?.code === "history" && !venue.archivedAt && !venue.archiveBlock;
  // Where focus lands: the name field for a delete, "Archive instead" when
  // that is the way out, otherwise the choice that changes nothing.
  const cancelFirst = Boolean(block && !archiveInstead) || (!block && intent === "archive");
  const title = block
    ? intent === "archive" ? `${venue.name} cannot be archived` : `${venue.name} cannot be deleted`
    : intent === "archive" ? `Archive ${venue.name}?` : `Delete ${venue.name} for good?`;

  return (
    <dialog ref={ref} className="confirm-dialog" aria-labelledby={titleId} aria-describedby={bodyId}>
      <h2 id={titleId} style={{ fontSize: 16, margin: "0 0 8px" }}>{title}</h2>
      <div id={bodyId} style={{ fontSize: 13, lineHeight: 1.6 }}>
        {block ? (
          <p style={{ margin: 0 }}>
            {block.reason}
            {block.code === "paid" && (
              <>
                {" "}
                <a href={`/billing?loc=${venue.id}`} style={{ color: "var(--accent)", textDecoration: "underline" }}>Open Billing</a>
              </>
            )}
            {block.code === "stranded" && (
              <>
                {" "}
                <a href="/team" style={{ color: "var(--accent)", textDecoration: "underline" }}>Open Team</a>
              </>
            )}
          </p>
        ) : intent === "archive" ? (
          <p style={{ margin: 0 }}>
            Archiving stops {venue.name} answering on every channel and hides it everywhere else. Its{" "}
            {venue.usage.bookings} bookings and {venue.usage.calls} calls are kept, and you can restore it from Archived.
            {venue.usage.upcoming > 0 && <strong> It has {venue.usage.upcoming} upcoming bookings — tell those customers first.</strong>}
          </p>
        ) : (
          <>
            <p style={{ margin: 0 }}>
              This removes {venue.name} and its setup. It has no bookings or calls, and it cannot be undone.
              {venue.hasBellineNumber && " Its Belline number is released and rests for 30 days before anyone else can be given it."}
            </p>
            <label className="label-plain" style={{ display: "grid", gap: 6, marginTop: 12 }}>
              Type <strong>{venue.name}</strong> to confirm
              <input data-autofocus value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
            </label>
          </>
        )}
        {error && <p role="alert" style={{ color: "var(--bad)", margin: "10px 0 0" }}>{error}</p>}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
        {!block && intent === "archive" && (
          <button className="btn btn-danger" disabled={busy} onClick={() => void run({ action: "archive", locationId: venue.id }, `${venue.name} archived.`)}>
            {busy ? "Archiving…" : "Archive"}
          </button>
        )}
        {!block && intent === "delete" && (
          <button
            className="btn btn-danger"
            disabled={busy || typed.trim() !== venue.name}
            onClick={() => void run({ action: "delete", locationId: venue.id, confirmName: typed }, `${venue.name} deleted.`)}
          >
            {busy ? "Deleting…" : "Delete for good"}
          </button>
        )}
        {archiveInstead && (
          <button className="btn btn-danger" data-autofocus onClick={() => onIntent("archive")}>
            Archive instead…
          </button>
        )}
        <button className="btn" onClick={onClose} data-autofocus={cancelFirst || undefined}>
          {block ? "Close" : "Cancel"}
        </button>
      </div>
    </dialog>
  );
}

function VenueDrawer({
  venue,
  timezones,
  onClose,
  onSaved,
}: {
  venue: Venue | null;
  timezones: string[];
  onClose: () => void;
  onSaved: (message: string, newLocationId?: string) => void;
}) {
  const [name, setName] = useState(venue?.name ?? "");
  const [trade, setTrade] = useState<string>(venue?.tradeKey ?? "");
  const [timezone, setTimezone] = useState(venue?.timezone ?? "Asia/Dubai");
  const [address, setAddress] = useState(venue?.address ?? "");
  const [phone, setPhone] = useState(venue?.phone ?? "");
  const phoneField = useRef<PhoneFieldHandle | null>(null);
  const [phoneError, setPhoneError] = useState<string | undefined>();
  const [currency, setCurrency] = useState(venue?.currency ?? "AED");
  const [hours, setHours] = useState<WeeklyHours>(
    venue?.hours ?? Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, [{ start: 540, end: 1080 }]])),
  );
  const [closures, setClosures] = useState<string[]>(venue?.closures ?? []);
  const [closureDraft, setClosureDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);

  const zones = timezones.includes(timezone) ? timezones : [timezone, ...timezones];

  // Escape closes the drawer, and focus starts on the name, and goes back to
  // the button that opened it on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    nameInput.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setDay(day: number, value: { start: number; end: number } | null) {
    setHours({ ...hours, [day]: value ? [value] : [] });
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setPhoneError(undefined);
    // The phone is checked at its field: red, the reason under it, focus on it.
    if (!phoneField.current?.check()) return;
    setBusy(true);
    const result = await post({
      action: venue ? "update" : "create",
      locationId: venue?.id,
      name,
      ...(venue ? {} : { trade }),
      timezone,
      address,
      phone,
      currency,
      hours,
      closures,
    });
    setBusy(false);
    if (!result.ok) {
      if ((result as { field?: string }).field === "phone") setPhoneError(result.error);
      else setError(result.error ?? "Could not save.");
      return;
    }
    onSaved(venue ? `${name} saved.` : `${name} added — let's set it up.`, venue ? undefined : result.locationId);
  }

  return (
    <div className="drawer-scrim" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={venue ? `Edit ${venue.name}` : "Add a location"} onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <strong>{venue ? `Edit ${venue.name}` : "Add a location"}</strong>
          <button className="btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <form onSubmit={save} className="drawer-body">
          <label>Name<input ref={nameInput} value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} /></label>
          {venue ? (
            // The engine behind a restaurant and a clinic differ, so the kind
            // of business is fixed (lib/locations.ts). Said, not hidden.
            <p className="muted" style={{ fontSize: 12.5, margin: 0, lineHeight: 1.5 }}>
              Kind of business: {tradeLabel(venue.tradeKey, venue.vertical)}. This cannot change — add a new location for a different kind.
            </p>
          ) : (
            <label>
              Kind of business
              <select value={trade} onChange={(e) => setTrade(e.target.value)}>
                <option value="">Something else</option>
                {TRADE_GROUPS.map((group) => (
                  <optgroup key={group} label={group}>
                    {TRADES.filter((t) => t.group === group).map((t) => (
                      <option key={t.key} value={t.key}>{t.label}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
          )}
          <label>Address<input value={address} onChange={(e) => setAddress(e.target.value)} maxLength={240} /></label>
          <div className="drawer-row">
            <PhoneField
              ref={phoneField}
              id="location-phone"
              label="Business phone"
              compact
              value={venue?.phone}
              defaultCountry="AE"
              serverError={phoneError}
              onValue={(p) => {
                if (!p.error) setPhone(p.e164);
                setPhoneError(undefined);
              }}
            />
            <label>Currency<input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} /></label>
          </div>
          <label>
            Timezone
            <select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              {zones.map((z) => <option key={z} value={z}>{z}</option>)}
            </select>
          </label>

          <fieldset className="drawer-fieldset">
            <legend>Opening hours</legend>
            {DAYS.map((label, day) => {
              const range = hours[day]?.[0];
              return (
                <div key={label} className="hours-row">
                  <label className="hours-toggle">
                    <input type="checkbox" checked={Boolean(range)} onChange={(e) => setDay(day, e.target.checked ? { start: 540, end: 1080 } : null)} />
                    {label}
                  </label>
                  {range ? (
                    <span className="hours-times">
                      <input type="time" step={900} value={minutesToClock(range.start)} onChange={(e) => setDay(day, { ...range, start: toMinutes(e.target.value) })} aria-label={`${label} opens`} />
                      –
                      <input type="time" step={900} value={minutesToClock(range.end)} onChange={(e) => setDay(day, { ...range, end: toMinutes(e.target.value) })} aria-label={`${label} closes`} />
                    </span>
                  ) : (
                    <span className="muted" style={{ fontSize: 12.5 }}>Closed</span>
                  )}
                </div>
              );
            })}
          </fieldset>

          <fieldset className="drawer-fieldset">
            <legend>Closed on</legend>
            <div style={{ display: "flex", gap: 8 }}>
              <input type="date" value={closureDraft} onChange={(e) => setClosureDraft(e.target.value)} aria-label="Closure date" />
              <button type="button" className="btn" disabled={!closureDraft} onClick={() => { setClosures([...new Set([...closures, closureDraft])].sort()); setClosureDraft(""); }}>
                Add
              </button>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
              {closures.map((d) => (
                <button type="button" key={d} className="pill" onClick={() => setClosures(closures.filter((c) => c !== d))} title="Remove">
                  {d} ✕
                </button>
              ))}
            </div>
          </fieldset>

          {error && <p role="alert" style={{ color: "var(--bad)", fontSize: 13, margin: 0 }}>{error}</p>}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-accent" disabled={busy}>{busy ? "Saving…" : venue ? "Save" : "Add location"}</button>
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
          </div>
        </form>
      </aside>
    </div>
  );
}

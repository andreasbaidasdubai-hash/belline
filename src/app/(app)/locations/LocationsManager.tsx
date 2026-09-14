"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Vertical, WeeklyHours } from "@/lib/types";
import { minutesToClock } from "@/lib/time";

/**
 * Locations, managed the way a business with branches expects.
 *
 * Cards rather than a table, because a location is a place with a name and an
 * address, not a row. Editing happens in a side drawer so the list stays in
 * view; archiving says what it keeps; deleting asks for the name, and is only
 * offered when there is nothing to lose.
 */

interface Venue {
  id: string;
  name: string;
  vertical: Vertical;
  timezone: string;
  address: string;
  phone: string;
  currency: string;
  hours: WeeklyHours;
  closures: string[];
  archivedAt: string | null;
  usage: { bookings: number; upcoming: number; calls: number };
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const KIND: Record<Vertical, string> = { salon: "Salon or spa", clinic: "Clinic", restaurant: "Restaurant" };

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
  const data = (await res.json().catch(() => ({}))) as { error?: string; locationId?: string };
  return { ok: res.ok, ...data };
}

export default function LocationsManager({
  venues,
  canManage,
  timezones,
}: {
  venues: Venue[];
  canManage: boolean;
  timezones: string[];
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<Venue | "new" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const active = venues.filter((v) => !v.archivedAt);
  const archived = venues.filter((v) => v.archivedAt);

  async function act(body: Record<string, unknown>, done: string) {
    const result = await post(body);
    setNotice(result.ok ? done : result.error ?? "That did not work.");
    if (result.ok) router.refresh();
  }

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 12, flexWrap: "wrap" }}>
        <span className="muted" style={{ fontSize: 13 }}>
          {active.length} active{archived.length ? ` · ${archived.length} archived` : ""}
        </span>
        {canManage && (
          <button className="btn btn-accent" onClick={() => setEditing("new")}>
            Add a location
          </button>
        )}
      </div>

      {notice && (
        <div className="cal-toast" role="status" style={{ position: "static" }}>
          {notice}
        </div>
      )}

      <div className="loc-grid">
        {active.map((v) => (
          <VenueCard key={v.id} venue={v} canManage={canManage} canArchive={active.length > 1} onEdit={() => setEditing(v)} onAct={act} />
        ))}
      </div>

      {archived.length > 0 && (
        <>
          <h2 style={{ fontSize: 15, margin: "28px 0 10px" }}>Archived</h2>
          <div className="loc-grid">
            {archived.map((v) => (
              <VenueCard key={v.id} venue={v} canManage={canManage} canArchive={false} onEdit={() => setEditing(v)} onAct={act} />
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
    </>
  );
}

function VenueCard({
  venue,
  canManage,
  canArchive,
  onEdit,
  onAct,
}: {
  venue: Venue;
  canManage: boolean;
  canArchive: boolean;
  onEdit: () => void;
  onAct: (body: Record<string, unknown>, done: string) => Promise<void>;
}) {
  const [confirming, setConfirming] = useState<"archive" | "delete" | null>(null);
  const [typed, setTyped] = useState("");
  const empty = venue.usage.bookings === 0 && venue.usage.calls === 0;

  return (
    <div className="panel" style={{ padding: "16px 18px", opacity: venue.archivedAt ? 0.8 : 1 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" }}>
        <strong style={{ fontSize: 15 }}>{venue.name}</strong>
        <span className="pill">{KIND[venue.vertical]}</span>
      </div>
      <p className="muted" style={{ fontSize: 12.5, margin: "6px 0 0", lineHeight: 1.55 }}>
        {venue.address || "No address yet"}
        <br />
        {venue.phone || "No number yet"} · {venue.timezone}
      </p>
      <p style={{ fontSize: 12.5, margin: "10px 0 0" }}>
        {venue.usage.upcoming} upcoming · {venue.usage.bookings} bookings · {venue.usage.calls} calls
      </p>

      {confirming === "archive" ? (
        <div style={{ marginTop: 12, fontSize: 12.5, lineHeight: 1.55 }}>
          Archiving hides {venue.name} everywhere and stops it answering. Every booking and call is kept, and you can restore it.
          {venue.usage.upcoming > 0 && <strong> It has {venue.usage.upcoming} upcoming bookings — tell those guests first.</strong>}
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button className="btn btn-danger" onClick={() => void onAct({ action: "archive", locationId: venue.id }, `${venue.name} archived.`)}>
              Archive
            </button>
            <button className="btn" onClick={() => setConfirming(null)}>Keep it</button>
          </div>
        </div>
      ) : confirming === "delete" ? (
        <div style={{ marginTop: 12, fontSize: 12.5 }}>
          Type <strong>{venue.name}</strong> to delete it for good.
          <input value={typed} onChange={(e) => setTyped(e.target.value)} style={{ marginTop: 6 }} aria-label="Location name" />
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button
              className="btn btn-danger"
              disabled={typed.trim() !== venue.name}
              onClick={() => void onAct({ action: "delete", locationId: venue.id, confirmName: typed }, `${venue.name} deleted.`)}
            >
              Delete
            </button>
            <button className="btn" onClick={() => setConfirming(null)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          {!venue.archivedAt && (
            <>
              <a className="btn" href={`/calendar?loc=${venue.id}`}>Open</a>
              <button className="btn" onClick={onEdit}>Edit details</button>
            </>
          )}
          {canManage && !venue.archivedAt && canArchive && (
            <button className="btn" onClick={() => setConfirming("archive")}>Archive</button>
          )}
          {canManage && venue.archivedAt && (
            <>
              <button className="btn" onClick={() => void onAct({ action: "restore", locationId: venue.id }, `${venue.name} restored.`)}>
                Restore
              </button>
              {empty && (
                <button className="btn btn-danger" onClick={() => setConfirming("delete")}>Delete</button>
              )}
            </>
          )}
        </div>
      )}
    </div>
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
  const [vertical, setVertical] = useState<Vertical>(venue?.vertical ?? "salon");
  const [timezone, setTimezone] = useState(venue?.timezone ?? "Asia/Dubai");
  const [address, setAddress] = useState(venue?.address ?? "");
  const [phone, setPhone] = useState(venue?.phone ?? "");
  const [currency, setCurrency] = useState(venue?.currency ?? "AED");
  const [hours, setHours] = useState<WeeklyHours>(
    venue?.hours ?? Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, [{ start: 540, end: 1080 }]])),
  );
  const [closures, setClosures] = useState<string[]>(venue?.closures ?? []);
  const [closureDraft, setClosureDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const zones = timezones.includes(timezone) ? timezones : [timezone, ...timezones];

  function setDay(day: number, value: { start: number; end: number } | null) {
    setHours({ ...hours, [day]: value ? [value] : [] });
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await post({
      action: venue ? "update" : "create",
      locationId: venue?.id,
      name,
      ...(venue ? {} : { vertical }),
      timezone,
      address,
      phone,
      currency,
      hours,
      closures,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? "Could not save.");
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
          <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} /></label>
          {!venue && (
            <label>
              Kind of business
              <select value={vertical} onChange={(e) => setVertical(e.target.value as Vertical)}>
                <option value="salon">Salon, spa or studio</option>
                <option value="clinic">Clinic, dental or physio</option>
                <option value="restaurant">Restaurant or café</option>
              </select>
            </label>
          )}
          <label>Address<input value={address} onChange={(e) => setAddress(e.target.value)} maxLength={240} /></label>
          <div className="drawer-row">
            <label>Phone<input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+971 4 …" inputMode="tel" /></label>
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

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Which Calendly event type each service books, and the way to disconnect.
 *
 * Google's and Outlook's equivalent (CalendarControls) picks *which calendar*
 * a booking is written into, and the answer barely changes what Belline can
 * promise. This one decides whether Belline can take the venue's bookings at
 * all: Calendly books event types, each with its own fixed length, so a service
 * with no event type chosen is a service Belline cannot book. The page says
 * which ones those are, above; this is where they are fixed.
 *
 * Each option shows the event type's own length, because Calendly's length is
 * the appointment the customer gets — not the one in Belline's service list.
 */
export default function CalendlyControls({
  locationId,
  eventTypes,
  services,
  serviceEventTypes,
  defaultEventType,
}: {
  locationId: string;
  eventTypes: { uri: string; name: string; duration: number; poolingType?: string }[];
  /** Empty for a venue with no service list: the default event type is used for everything. */
  services: { id: string; name: string; durationMin: number }[];
  serviceEventTypes: Record<string, string>;
  defaultEventType?: string;
}) {
  const router = useRouter();
  const [picks, setPicks] = useState<Record<string, string>>(serviceEventTypes);
  const [fallback, setFallback] = useState(defaultEventType ?? eventTypes[0]?.uri ?? "");
  const [busy, setBusy] = useState<"save" | "disconnect" | null>(null);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const [after, setAfter] = useState<string | null>(null);

  async function call(method: "POST" | "DELETE", body: Record<string, unknown>): Promise<{ problem?: string; said?: string } | null> {
    try {
      const res = await fetch("/api/integrations/calendly", {
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
    const chosen = Object.fromEntries(Object.entries(picks).filter(([id, uri]) => uri && services.some((s) => s.id === id)));
    const out = await call("POST", { locationId, serviceEventTypes: chosen, defaultEventType: fallback });
    setBusy(null);
    setSaid(out?.problem ? { ok: false, text: out.problem } : { ok: true, text: "Saved." });
    if (!out?.problem) router.refresh();
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
  const shared = (uri: string) => {
    const type = eventTypes.find((t) => t.uri === uri);
    return Boolean(type?.poolingType && type.poolingType !== "solo");
  };

  return (
    <div style={{ marginTop: 16, display: "grid", gap: 14, maxWidth: 640 }}>
      {services.length > 0 ? (
        <section aria-labelledby="calendly-services" style={{ display: "grid", gap: 8 }}>
          <h3 id="calendly-services" style={{ fontSize: 14, margin: 0 }}>
            Which Calendly event type each service books
          </h3>
          <p className="muted" style={{ fontSize: 12.5, margin: 0, lineHeight: 1.55 }}>
            Calendly books its own event types, not free time, so each service needs one. The event type&apos;s length is the
            appointment your customer gets, whatever the length in your service list.
          </p>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
            {services.map((s) => (
              <li
                key={s.id}
                style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", padding: "8px 0", borderTop: "1px solid var(--border-soft)" }}
              >
                <label htmlFor={`calendly-service-${s.id}`} style={{ ...label, flex: "1 1 160px", fontWeight: 600, margin: 0 }}>
                  {s.name}
                  <span className="muted" style={{ fontWeight: 400 }}> · {s.durationMin} min in Belline</span>
                </label>
                <select
                  id={`calendly-service-${s.id}`}
                  value={picks[s.id] ?? ""}
                  onChange={(e) => setPicks({ ...picks, [s.id]: e.target.value })}
                  style={{ flex: "2 1 240px", minWidth: 0 }}
                >
                  <option value="">Not bookable through Calendly</option>
                  {eventTypes.map((t) => (
                    <option key={t.uri} value={t.uri}>
                      {t.name} · {t.duration} min{shared(t.uri) ? " · shared" : ""}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <div>
          <label htmlFor="calendly-default" style={label}>
            The event type Belline books
          </label>
          <select id="calendly-default" value={fallback} onChange={(e) => setFallback(e.target.value)}>
            {eventTypes.map((t) => (
              <option key={t.uri} value={t.uri}>
                {t.name} · {t.duration} min{shared(t.uri) ? " · shared" : ""}
              </option>
            ))}
          </select>
          <p className="muted" style={{ fontSize: 12.5, margin: "6px 0 0" }}>
            You have no service list, so every booking Belline makes uses this one.
          </p>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" className="btn btn-accent" onClick={save} disabled={busy !== null}>
          {busy === "save" ? "Saving…" : "Save event types"}
        </button>
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

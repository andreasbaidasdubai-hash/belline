"use client";

import { useState } from "react";
import { fill, type MANAGE_KEYS } from "@/lib/customer-copy";

type Slot = { date: string; startMin: number; staffName?: string };

const clock = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const day = (d: string, language: "en" | "de" = "en") =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString(language === "de" ? "de-DE" : "en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

const primary: React.CSSProperties = {
  padding: "12px 20px",
  borderRadius: 999,
  background: "var(--bl-ink-900)",
  color: "var(--bl-ground)",
  border: 0,
  fontWeight: 600,
  fontSize: 14,
  cursor: "pointer",
  textDecoration: "none",
};
const secondary: React.CSSProperties = { ...primary, background: "transparent", color: "var(--bl-ink-900)", border: "1px solid var(--bl-rule-strong)" };

export default function ManageBooking({
  token,
  calendarHref,
  policy,
  phone,
  venueName,
  language = "en",
  copy,
}: {
  token: string;
  calendarHref: string;
  policy: string | null;
  phone: string;
  venueName: string;
  /** The venue's language, for dates. The words themselves arrive in `copy`. */
  language?: "en" | "de";
  /** This page's lines in the guest's language, from customer-copy.ts. */
  copy: Record<(typeof MANAGE_KEYS)[number], string>;
}) {
  const [mode, setMode] = useState<"idle" | "change" | "cancel" | "done">("idle");
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function call(body: Record<string, unknown>) {
    const res = await fetch("/api/manage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, ...body }),
    });
    const data = (await res.json()) as { error?: string; slots?: Slot[]; notice?: string | null };
    if (!res.ok) throw new Error(data.error ?? copy["manage.didnt_work"]);
    return data;
  }

  async function openChange() {
    setMode("change");
    setMessage(null);
    setBusy(true);
    try {
      setSlots((await call({ action: "times" })).slots ?? []);
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function move(slot: Slot) {
    setBusy(true);
    setMessage(null);
    try {
      await call({ action: "reschedule", date: slot.date, startMin: slot.startMin });
      setMode("done");
      setMessage(fill(copy["manage.moved"], { day: day(slot.date, language), time: clock(slot.startMin) }));
      window.setTimeout(() => window.location.reload(), 1800);
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    setBusy(true);
    setMessage(null);
    try {
      const data = await call({ action: "cancel" });
      setMode("done");
      setMessage(fill(copy["manage.cancelled"], { notice: data.notice ? ` ${data.notice}` : "" }));
      window.setTimeout(() => window.location.reload(), 2500);
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const byDay = (slots ?? []).reduce<Record<string, Slot[]>>((acc, s) => {
    (acc[s.date] ??= []).push(s);
    return acc;
  }, {});

  return (
    <div style={{ marginTop: 28 }}>
      {mode === "idle" && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button style={primary} onClick={openChange}>{copy["manage.change_time"]}</button>
          <a style={secondary} href={calendarHref}>{copy["booking.add_to_calendar"]}</a>
          <button style={secondary} onClick={() => setMode("cancel")}>{copy["manage.cancel_booking"]}</button>
        </div>
      )}

      {mode === "change" && (
        <div>
          <p style={{ fontSize: 15, margin: "0 0 12px" }}>{copy["manage.pick_time"]}</p>
          {busy && !slots && <p style={{ color: "var(--bl-muted)" }}>{copy["manage.finding"]}</p>}
          {slots && slots.length === 0 && (
            <p style={{ color: "var(--bl-text-2)" }}>
              {copy["manage.nothing_free"]} {phone ? fill(copy["manage.call_us"], { name: venueName, phone }) : ""}
            </p>
          )}
          {Object.entries(byDay).map(([d, list]) => (
            <div key={d} style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 13, color: "var(--bl-muted)", marginBottom: 6 }}>{day(d, language)}</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {list.map((s) => (
                  <button key={`${s.date}-${s.startMin}`} style={secondary} disabled={busy} onClick={() => move(s)}>
                    {clock(s.startMin)}
                    {s.staffName ? ` · ${s.staffName}` : ""}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <button style={{ ...secondary, marginTop: 8 }} onClick={() => setMode("idle")} disabled={busy}>{copy["manage.keep_time"]}</button>
        </div>
      )}

      {mode === "cancel" && (
        <div>
          <p style={{ fontSize: 15, margin: "0 0 12px" }}>{copy["manage.confirm_cancel"]}</p>
          {policy && <p style={{ fontSize: 14, color: "var(--bl-text-2)", margin: "0 0 14px" }}>{policy}</p>}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button style={{ ...primary, background: "var(--bl-danger)" }} onClick={cancel} disabled={busy}>
              {busy ? copy["manage.cancelling"] : copy["manage.yes_cancel"]}
            </button>
            <button style={secondary} onClick={() => setMode("idle")} disabled={busy}>{copy["manage.keep_it"]}</button>
          </div>
        </div>
      )}

      {message && <p style={{ marginTop: 16, fontSize: 15, color: mode === "done" ? "var(--bl-success)" : "var(--bl-danger)" }}>{message}</p>}
    </div>
  );
}

"use client";

import { useState } from "react";

type Slot = { date: string; startMin: number; staffName?: string };

const clock = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const day = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

const primary: React.CSSProperties = {
  padding: "12px 20px",
  borderRadius: 999,
  background: "#14110D",
  color: "#FBF9F5",
  border: 0,
  fontWeight: 600,
  fontSize: 14,
  cursor: "pointer",
  textDecoration: "none",
};
const secondary: React.CSSProperties = { ...primary, background: "transparent", color: "#14110D", border: "1px solid #D8D1C4" };

export default function ManageBooking({
  token,
  calendarHref,
  policy,
  phone,
  venueName,
}: {
  token: string;
  calendarHref: string;
  policy: string | null;
  phone: string;
  venueName: string;
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
    if (!res.ok) throw new Error(data.error ?? "That didn't work.");
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
      setMessage(`Moved to ${day(slot.date)} at ${clock(slot.startMin)}. A new confirmation is on its way.`);
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
      setMessage(`Cancelled.${data.notice ? ` ${data.notice}` : ""}`);
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
          <button style={primary} onClick={openChange}>Change time</button>
          <a style={secondary} href={calendarHref}>Add to calendar</a>
          <button style={secondary} onClick={() => setMode("cancel")}>Cancel booking</button>
        </div>
      )}

      {mode === "change" && (
        <div>
          <p style={{ fontSize: 15, margin: "0 0 12px" }}>Pick a new time. Your current one stays until you do.</p>
          {busy && !slots && <p style={{ color: "#746C63" }}>Finding free times…</p>}
          {slots && slots.length === 0 && (
            <p style={{ color: "#4A443C" }}>
              Nothing free in the next two weeks online. {phone ? `Call ${venueName} on ${phone}.` : ""}
            </p>
          )}
          {Object.entries(byDay).map(([d, list]) => (
            <div key={d} style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 13, color: "#746C63", marginBottom: 6 }}>{day(d)}</div>
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
          <button style={{ ...secondary, marginTop: 8 }} onClick={() => setMode("idle")} disabled={busy}>Keep my time</button>
        </div>
      )}

      {mode === "cancel" && (
        <div>
          <p style={{ fontSize: 15, margin: "0 0 12px" }}>Cancel this booking?</p>
          {policy && <p style={{ fontSize: 14, color: "#4A443C", margin: "0 0 14px" }}>{policy}</p>}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button style={{ ...primary, background: "#A33327" }} onClick={cancel} disabled={busy}>
              {busy ? "Cancelling…" : "Yes, cancel it"}
            </button>
            <button style={secondary} onClick={() => setMode("idle")} disabled={busy}>Keep it</button>
          </div>
        </div>
      )}

      {message && <p style={{ marginTop: 16, fontSize: 15, color: mode === "done" ? "#2F6B4F" : "#A33327" }}>{message}</p>}
    </div>
  );
}

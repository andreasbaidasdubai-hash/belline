"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Mode = "packs" | "upgrade" | "cap";

/**
 * The owner's choice for 100% of an allowance, in plain words.
 *
 * Every figure shown — pack prices, alert thresholds, the next plan — arrives
 * as props generated from the catalogue on the server. Nothing is charged by
 * this form: it records a choice.
 */
export default function UsagePolicy({
  trial = false,
  locationId,
  mode,
  capAed,
  canEdit,
  packs,
  alerts,
  nextPlan,
}: {
  /** During the trial the choice is recorded now and applies from the first plan. */
  trial?: boolean;
  locationId: string;
  mode: Mode | null;
  capAed: number | null;
  canEdit: boolean;
  packs: string;
  alerts: string;
  nextPlan: string | null;
}) {
  const router = useRouter();
  const [choice, setChoice] = useState<Mode | null>(mode);
  const [cap, setCap] = useState(capAed === null ? "" : String(capAed));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const options: { value: Mode; title: string; detail: string }[] = [
    {
      value: "packs",
      title: "Add a pack automatically",
      detail: `${packs} Added only when an allowance is used up, and never past the monthly cap you set below.`,
    },
    {
      value: "upgrade",
      title: "Move me up a plan",
      detail: nextPlan
        ? `We recommend ${nextPlan} and you confirm it. Until you do, Belline stops at the allowance.`
        : "You are on the largest plan, so this behaves like stopping at the allowance.",
    },
    {
      value: "cap",
      title: "Stop at the allowance",
      detail: "Belline stops answering on that allowance's channels until the next period. Nothing is added to your bill.",
    },
  ];

  async function save() {
    if (!choice) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/billing/policy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locationId, mode: choice, monthlyCapAed: choice === "packs" && cap.trim() !== "" ? cap.trim() : undefined }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setMessage({ ok: false, text: data.error ?? "Could not save that." });
        return;
      }
      setMessage({ ok: true, text: "Saved." });
      router.refresh();
    } catch {
      setMessage({ ok: false, text: "Could not save that." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: "14px 18px 18px", display: "grid", gap: 10 }}>
      {trial && (
        <p className="muted" style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5 }}>
          Choose now and it applies from your first plan. During the trial, Belline stops at the trial allowance and
          nothing is charged.
        </p>
      )}
      {!mode && !trial && (
        <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "var(--warn)" }}>
          Not chosen yet — until you choose, Belline stops at 100% and nothing is added to your bill.
        </p>
      )}
      <div role="radiogroup" aria-label="When an allowance runs out" style={{ display: "grid", gap: 8 }}>
        {options.map((o) => (
          <label
            key={o.value}
            style={{
              display: "grid",
              gridTemplateColumns: "18px 1fr",
              gap: 8,
              alignItems: "start",
              padding: "10px 12px",
              borderRadius: 9,
              border: `1px solid ${choice === o.value ? "var(--text)" : "var(--border)"}`,
              cursor: canEdit ? "pointer" : "default",
            }}
          >
            <input
              type="radio"
              name="usage-policy"
              value={o.value}
              checked={choice === o.value}
              disabled={!canEdit || busy}
              onChange={() => setChoice(o.value)}
              style={{ marginTop: 3 }}
            />
            <span>
              <strong style={{ fontSize: 13 }}>{o.title}</strong>
              <span className="muted" style={{ display: "block", fontSize: 12, marginTop: 3, lineHeight: 1.5 }}>
                {o.detail}
              </span>
            </span>
          </label>
        ))}
      </div>

      {choice === "packs" && (
        <label style={{ display: "grid", gap: 4, fontSize: 12.5 }}>
          <span>Monthly spending cap for packs, in AED (leave empty for no cap)</span>
          <input
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            value={cap}
            disabled={!canEdit || busy}
            onChange={(e) => setCap(e.target.value)}
            style={{ maxWidth: 160, font: "inherit", padding: "6px 8px" }}
          />
        </label>
      )}

      <p className="muted" style={{ fontSize: 12, margin: 0, lineHeight: 1.5 }}>
        {alerts}
      </p>

      {canEdit ? (
        <div>
          <button className="btn" onClick={save} disabled={busy || !choice}>
            {busy ? "Saving…" : "Save choice"}
          </button>
          {message && (
            <p style={{ margin: "8px 0 0", fontSize: 12.5, color: message.ok ? "var(--ok)" : "var(--bad)" }}>{message.text}</p>
          )}
        </div>
      ) : (
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>Only the account owner can change this.</p>
      )}
    </div>
  );
}

"use client";

import { useMemo, useState } from "react";
import { project, type Assumptions, type Base } from "@/lib/sales/projection";

/**
 * The forward view, with the assumptions on the table.
 *
 * Every number the owner can change is an input beside the chart, and the
 * chart moves as they type. A projection whose inputs are hidden is a claim;
 * one whose inputs are on screen is an argument, and arguments are what a
 * plan is for.
 */

const aed = (fils: number) =>
  `AED ${Math.round(fils / 100).toLocaleString("en-AE")}`;

const FIELDS: { key: keyof Assumptions; label: string; hint: string; step: number; pct?: boolean; money?: boolean }[] = [
  { key: "newTrialsPerMonth", label: "New trials, first month", hint: "sign-ups that start a trial", step: 1 },
  { key: "trialGrowth", label: "Growth in new trials", hint: "month on month", step: 1, pct: true },
  { key: "trialConversion", label: "Trial → paid", hint: "share that stays after fourteen days", step: 1, pct: true },
  { key: "monthlyChurn", label: "Churn", hint: "share of paying venues lost a month", step: 0.5, pct: true },
  { key: "arpaFils", label: "Average price per venue", hint: "a month, across the plan mix", step: 1, money: true },
  { key: "minutesPerVenue", label: "Minutes per venue", hint: "billable, a month", step: 5 },
  { key: "vendorCostPerMinuteFils", label: "Our cost per minute", hint: "speech, voice and model", step: 0.05, money: true },
  { key: "fixedCostsFils", label: "Fixed costs", hint: "a month — hosting, numbers, tools", step: 100, money: true },
  { key: "months", label: "Horizon", hint: "months", step: 1 },
];

export default function Projection({ base, defaults }: { base: Base; defaults: Assumptions }) {
  const [a, setA] = useState<Assumptions>(defaults);
  const rows = useMemo(() => project(base, a), [base, a]);
  const last = rows[rows.length - 1];
  const peak = Math.max(1, ...rows.map((r) => r.mrrFils));

  function read(key: keyof Assumptions): string {
    const v = a[key];
    const f = FIELDS.find((x) => x.key === key)!;
    if (f.pct) return String(Math.round(v * 1000) / 10);
    if (f.money) return String(Math.round(v) / 100);
    return String(v);
  }
  function write(key: keyof Assumptions, raw: string) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    const f = FIELDS.find((x) => x.key === key)!;
    setA((prev) => ({ ...prev, [key]: f.pct ? n / 100 : f.money ? Math.round(n * 100) : n }));
  }

  // The chart: MRR by month, one polyline, the last point labelled.
  const W = 640;
  const H = 180;
  const pad = { l: 8, r: 8, t: 14, b: 22 };
  const x = (i: number) => pad.l + (i / Math.max(1, rows.length - 1)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - v / peak) * (H - pad.t - pad.b);
  const path = rows.map((r, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(r.mrrFils).toFixed(1)}`).join(" ");

  return (
    <div className="split" style={{ marginTop: 18, alignItems: "start" }}>
      <div className="panel">
        <div className="panel-head">
          Projection
          <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>
            {a.months} months, from today&rsquo;s book
          </span>
        </div>
        <div style={{ padding: "16px 18px 6px" }}>
          <div className="stats" style={{ marginBottom: 14 }}>
            <Mini label={`MRR in month ${a.months}`} value={last ? aed(last.mrrFils) : "—"} />
            <Mini label="Paying venues" value={last ? String(Math.round(last.paying)) : "—"} />
            <Mini label="Revenue over the period" value={last ? aed(last.cumulativeRevenueFils) : "—"} />
            <Mini
              label={`Monthly profit, month ${a.months}`}
              value={last ? aed(last.profitFils) : "—"}
              tone={last && last.profitFils < 0 ? "warn" : undefined}
            />
          </div>

          <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Monthly recurring revenue by month">
            {[0.25, 0.5, 0.75, 1].map((f) => (
              <line key={f} x1={pad.l} x2={W - pad.r} y1={y(peak * f)} y2={y(peak * f)} stroke="var(--border)" strokeWidth="1" />
            ))}
            <path d={path} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" />
            {last && (
              <>
                <circle cx={x(rows.length - 1)} cy={y(last.mrrFils)} r="4" fill="var(--accent)" />
                <text x={x(rows.length - 1) - 6} y={y(last.mrrFils) - 9} textAnchor="end" fontSize="12" fill="var(--text)">
                  {aed(last.mrrFils)}
                </text>
              </>
            )}
            {rows.map((r, i) =>
              i % Math.max(1, Math.round(rows.length / 6)) === 0 || i === rows.length - 1 ? (
                <text key={r.month} x={x(i)} y={H - 6} textAnchor="middle" fontSize="11" fill="var(--muted)">
                  m{r.month}
                </text>
              ) : null,
            )}
          </svg>

          <div className="table-wrap" tabIndex={0} style={{ marginTop: 10 }}>
            <table>
              <thead>
                <tr>
                  <th>Month</th>
                  <th style={{ textAlign: "right" }}>Trials</th>
                  <th style={{ textAlign: "right" }}>Paying</th>
                  <th style={{ textAlign: "right" }}>MRR</th>
                  <th style={{ textAlign: "right" }}>Vendor cost</th>
                  <th style={{ textAlign: "right" }}>Profit</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.month}>
                    <td className="mono">{r.month}</td>
                    <td className="mono" style={{ textAlign: "right" }}>{Math.round(r.newTrials)}</td>
                    <td className="mono" style={{ textAlign: "right" }}>{Math.round(r.paying)}</td>
                    <td className="mono" style={{ textAlign: "right" }}>{aed(r.mrrFils)}</td>
                    <td className="mono" style={{ textAlign: "right" }}>{aed(r.vendorCostFils)}</td>
                    <td className="mono" style={{ textAlign: "right", color: r.profitFils < 0 ? "var(--warn)" : "var(--text)" }}>
                      {aed(r.profitFils)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted" style={{ fontSize: 11.5, margin: "12px 0 8px", lineHeight: 1.55 }}>
            Trials convert the month after they start. Conversion and churn start as a reasonable prior for
            self-serve software at this price, not a measurement — replace them with your own numbers as
            soon as you have them. Price and minutes start from the real book when there is one.
          </p>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">Assumptions</div>
        <div style={{ padding: "14px 18px", display: "grid", gap: 12 }}>
          {FIELDS.map((f) => (
            <label key={f.key} style={{ display: "grid", gap: 4 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600 }}>
                {f.label}
                <span className="muted" style={{ fontWeight: 400, marginLeft: 6 }}>{f.hint}</span>
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {f.money && <span className="muted" style={{ fontSize: 12 }}>AED</span>}
                <input
                  type="number"
                  step={f.step}
                  min={0}
                  value={read(f.key)}
                  onChange={(e) => write(f.key, e.target.value)}
                  style={{ maxWidth: 140 }}
                />
                {f.pct && <span className="muted" style={{ fontSize: 12 }}>%</span>}
              </span>
            </label>
          ))}
          <button className="btn" type="button" onClick={() => setA(defaults)} style={{ justifySelf: "start" }}>
            Reset to the book
          </button>
        </div>
      </div>
    </div>
  );
}

function Mini({ label, value, tone }: { label: string; value: string; tone?: "warn" }) {
  return (
    <div style={{ padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 10 }}>
      <div className="muted" style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 300, marginTop: 4, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums", color: tone === "warn" ? "var(--warn)" : "var(--text)" }}>
        {value}
      </div>
    </div>
  );
}

"use client";

import { minutesToClock, parseClock } from "@/lib/time";

/**
 * The form vocabulary for the venue setup pages.
 *
 * Three of these are worth explaining, because they are where a settings page
 * usually goes wrong:
 *
 *   - **Blank is a value.** Almost every field here is optional, and "no rule"
 *     has to be typeable. A number input that coerces blank to zero turns
 *     "no deposit" into "a deposit of nothing" and "no notice needed" into a
 *     rule that refuses everything.
 *   - **Minutes are not how anybody thinks.** A venue thinks in "an hour",
 *     "half four", "20 minutes". Storing minutes from midnight is right; making
 *     somebody type 1110 is not.
 *   - **A hint is not decoration.** Every one of these settings changes what a
 *     stranger is told on the phone, and the hint is the only place that
 *     consequence is ever stated.
 */

export function Field({
  label,
  hint,
  children,
  problem,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  problem?: string;
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label>{label}</label>
      {children}
      {problem && (
        <div style={{ color: "var(--bad)", fontSize: 11.5, marginTop: 5 }}>{problem}</div>
      )}
      {hint && !problem && (
        <div className="muted" style={{ fontSize: 11.5, marginTop: 5, lineHeight: 1.45 }}>
          {hint}
        </div>
      )}
    </div>
  );
}

/** A number that may be left empty. Empty means the rule is off. */
export function NumberBox({
  value,
  onChange,
  placeholder,
  suffix,
  min = 0,
  step = 1,
  width,
}: {
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  placeholder?: string;
  suffix?: string;
  min?: number;
  step?: number;
  width?: number;
}) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 7, width: width ? undefined : "100%" }}>
      <input
        type="number"
        min={min}
        step={step}
        value={value ?? ""}
        placeholder={placeholder}
        style={width ? { width } : undefined}
        onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
        // The CSS takes the arrows off; this takes the wheel off. A focused
        // number field in Chrome counts up as you scroll past it, so scrolling
        // a long price list rewrites whatever the pointer happened to be over
        // — silently, and looking exactly like a value somebody typed.
        onWheel={(e) => e.currentTarget.blur()}
      />
      {suffix && (
        <span className="muted" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
          {suffix}
        </span>
      )}
    </span>
  );
}

export function TextBox({
  value,
  onChange,
  placeholder,
  width,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  width?: number;
}) {
  return (
    <input
      value={value}
      placeholder={placeholder}
      style={width ? { width } : undefined}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/**
 * A time of day, typed the way it is said.
 *
 * Accepts "16:00", "4pm", "1600". Stored as minutes from midnight, which is
 * what the engine works in — see the note at the top of types.ts on why times
 * are wall-clock rather than instants.
 */
export function ClockBox({
  value,
  onChange,
  placeholder = "e.g. 4pm",
  width = 110,
}: {
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  placeholder?: string;
  width?: number;
}) {
  return (
    <input
      defaultValue={value === undefined ? "" : minutesToClock(value)}
      placeholder={placeholder}
      style={{ width }}
      onBlur={(e) => {
        const raw = e.target.value.trim();
        if (!raw) {
          onChange(undefined);
          e.target.value = "";
          return;
        }
        const min = parseClock(raw);
        if (min === null) {
          // Put back what was there rather than storing a guess. A time nobody
          // can read is not a time to save silently.
          e.target.value = value === undefined ? "" : minutesToClock(value);
          return;
        }
        onChange(min);
        e.target.value = minutesToClock(min);
      }}
    />
  );
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <label
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        fontSize: 12.5,
        fontWeight: 400,
        letterSpacing: 0,
        textTransform: "none",
        color: "var(--text)",
        marginBottom: 0,
        cursor: "pointer",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        // 13px was the browser default. A thumb needs more than that, and so
        // does anybody over forty reading a rota on a phone.
        style={{ width: 22, height: 22, margin: 0, accentColor: "var(--accent)", flexShrink: 0 }}
      />
      {label}
    </label>
  );
}

export function Panel({
  title,
  hint,
  children,
  right,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div
        className="panel-head"
        style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}
      >
        {title}
        {hint && (
          <span className="muted" style={{ fontWeight: 400, fontSize: 11.5, flex: 1, lineHeight: 1.45 }}>
            {hint}
          </span>
        )}
        {right}
      </div>
      <div style={{ padding: 16 }}>{children}</div>
    </div>
  );
}

/** A repeated thing — one service, one table — with a way to remove it. */
export function Row({
  children,
  onRemove,
  removeLabel = "Remove",
}: {
  children: React.ReactNode;
  onRemove?: () => void;
  removeLabel?: string;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--border-soft)",
        borderRadius: 10,
        padding: 13,
        marginBottom: 10,
        background: "var(--panel-2)",
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
        {children}
        {onRemove && (
          <button
            className="btn btn-danger"
            style={{ padding: "6px 12px", fontSize: 12, marginLeft: "auto" }}
            onClick={onRemove}
          >
            {removeLabel}
          </button>
        )}
      </div>
    </div>
  );
}

/** One labelled control inside a Row, sized to its content. */
export function Cell({
  label,
  width,
  children,
}: {
  label: string;
  width?: number;
  children: React.ReactNode;
}) {
  return (
    <div style={{ width, minWidth: width ? undefined : 0 }}>
      <label style={{ marginBottom: 5 }}>{label}</label>
      {children}
    </div>
  );
}

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Which days something runs. Seven toggles, because that is the question. */
export function DayPicker({
  days,
  onChange,
}: {
  days: number[];
  onChange: (days: number[]) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {WEEKDAYS.map((name, index) => {
        const on = days.includes(index);
        return (
          <button
            key={name}
            className={`btn${on ? " on" : ""}`}
            style={{ padding: "5px 9px", fontSize: 11.5 }}
            aria-pressed={on}
            onClick={() =>
              onChange(
                on ? days.filter((d) => d !== index) : [...days, index].sort((a, b) => a - b),
              )
            }
          >
            {name}
          </button>
        );
      })}
    </div>
  );
}

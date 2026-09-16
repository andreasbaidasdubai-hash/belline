"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { COUNTRIES, countryByIso, normaliseOwnerPhone, readStoredPhone, type PhoneResult } from "@/lib/phone";

/**
 * A phone number, always with its country code.
 *
 * A country picker beside the number, defaulting to the business's own market
 * and showing the dial code. A local entry (050 299 2339) is converted with
 * the chosen country; one typed with +… keeps its own code. What the field
 * hands on is E.164, or an error to show under it: red, the message beneath,
 * and focus back on the number when a save is refused.
 *
 * Controlled from outside by `onValue`, and usable in a plain <form> through
 * the hidden input named `name`, which carries the E.164 number.
 */

export interface PhoneFieldHandle {
  /** Validate now: shows the error under the field and focuses it. True when the number is fine (or empty and optional). */
  check(): boolean;
}

export interface PhoneValue {
  /** E.164, or "" when empty. */
  e164: string;
  /** Why the entry is not a number yet; undefined when fine or empty. */
  error?: string;
}

interface Props {
  id: string;
  label: string;
  /** The stored number: E.164, or an older local one, read with `defaultCountry`. */
  value?: string;
  /** ISO code of the business's own market. */
  defaultCountry: string;
  /** Empty is allowed. */
  optional?: boolean;
  /** Carries E.164 in a plain form submit. */
  name?: string;
  hint?: React.ReactNode;
  /** An error from the server for this field, shown the same way. */
  serverError?: string;
  onValue?: (value: PhoneValue) => void;
  disabled?: boolean;
  compact?: boolean;
}

function evaluate(text: string, country: string, optional: boolean): PhoneValue {
  if (!text.trim()) return optional ? { e164: "" } : { e164: "", error: "Enter a phone number." };
  const out: PhoneResult = normaliseOwnerPhone(text, country);
  return out.ok ? { e164: out.e164 } : { e164: "", error: out.reason };
}

const PhoneField = forwardRef<PhoneFieldHandle, Props>(function PhoneField(
  { id, label, value, defaultCountry, optional = true, name, hint, serverError, onValue, disabled, compact },
  ref,
) {
  const stored = readStoredPhone(value, defaultCountry);
  const [country, setCountry] = useState(stored.country);
  const [text, setText] = useState(stored.text);
  const [shown, setShown] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  const current = evaluate(text, country, optional);

  useEffect(() => {
    onValue?.(current);
    // Report on every change of what is typed or picked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, country]);

  useImperativeHandle(ref, () => ({
    check() {
      const now = evaluate(text, country, optional);
      setShown(true);
      if (now.error) {
        input.current?.focus();
        return false;
      }
      return true;
    },
  }));

  const error = serverError || (shown ? current.error : undefined);
  const dial = countryByIso(country)?.dial ?? "";

  return (
    <div>
      <label htmlFor={id} style={{ textTransform: "none", letterSpacing: 0, fontSize: compact ? 12.5 : 14 }}>
        {label}
      </label>
      <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
        <select
          // Not the field's label: a label lookup for the number must find one input.
          aria-label="Country code"
          value={country}
          onChange={(e) => setCountry(e.target.value)}
          disabled={disabled}
          style={{ width: "auto", maxWidth: 150, flex: "0 0 auto" }}
          data-testid={`${id}-country`}
        >
          {COUNTRIES.map((c) => (
            <option key={c.iso} value={c.iso}>
              {c.iso} +{c.dial}
            </option>
          ))}
        </select>
        <input
          ref={input}
          id={id}
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder={country === "AE" ? "50 123 4567" : `+${dial} …`}
          value={text}
          disabled={disabled}
          onChange={(e) => {
            setText(e.target.value);
            if (shown) setShown(false);
          }}
          onBlur={() => setShown(true)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
          style={{ flex: 1, minWidth: 0, ...(error ? { borderColor: "var(--bad)", outlineColor: "var(--bad)" } : {}) }}
        />
      </div>
      {name && <input type="hidden" name={name} value={current.e164 || text.trim()} />}
      {hint && !error && (
        <p id={`${id}-hint`} className="muted" style={{ fontSize: 12.5, lineHeight: 1.5, margin: "4px 0 0" }}>
          {hint}
        </p>
      )}
      {!error && current.e164 && text.trim() && !text.trim().startsWith("+") && (
        <p className="muted" style={{ fontSize: 12.5, margin: "4px 0 0" }} data-testid={`${id}-saved-as`}>
          Saved as {current.e164}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" style={{ fontSize: 13.5, color: "var(--bad)", margin: "6px 0 0" }}>
          {error}
        </p>
      )}
    </div>
  );
});

export default PhoneField;

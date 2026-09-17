"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

/**
 * Every staff action in the console: one button, and when the action needs a
 * decision, an in-page form under it that names what is about to happen, asks
 * for the reason and any details, and only then posts. No `window.prompt`, no
 * `window.confirm`: a native dialog cannot say which customer a button belongs
 * to, and cannot hold a reason field.
 *
 * On success the page data is refreshed in place (`router.refresh`). Errors,
 * and the guard's reasons when a draft is refused, are shown under the form.
 */

export interface ActionField {
  name: string;
  label: string;
  type: "text" | "number" | "date" | "select" | "textarea" | "email" | "tel";
  options?: { value: string; label: string }[];
  defaultValue?: string;
  required?: boolean;
  min?: number;
  max?: number;
  placeholder?: string;
}

export interface ActionProps {
  endpoint: string;
  method?: "POST" | "DELETE";
  body: Record<string, unknown>;
  label: string;
  /** Shown above the form: what exactly will happen, naming the customer or venue. */
  confirm?: string;
  /** Ask for a reason (required). The label is the question. */
  reason?: string;
  fields?: ActionField[];
  submitLabel?: string;
  tone?: "primary" | "danger" | "plain";
  small?: boolean;
  /** Shown after success, until the next click. */
  done?: string;
  disabled?: boolean;
  /** Where to go after success instead of refreshing. `"$next"` uses the `next` the server answered with. */
  navigate?: string;
}

interface Answer {
  error?: string;
  problems?: string[];
  warnings?: string[];
  link?: string;
  minutes?: number;
  next?: string;
}

export default function Action(props: ActionProps) {
  const router = useRouter();
  const formId = useId();
  const needsForm = Boolean(props.confirm || props.reason || props.fields?.length);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Answer | null>(null);
  const [done, setDone] = useState<Answer | null>(null);
  const [copied, setCopied] = useState(false);

  async function run(values: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await fetch(props.endpoint, {
        method: props.method ?? "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...props.body, ...values }),
      });
      const data = (await res.json().catch(() => ({}))) as Answer;
      if (!res.ok) {
        setError({ ...data, error: data.error ?? `That did not work (${res.status}).` });
        return;
      }
      setOpen(false);
      setDone(data);
      if (props.navigate) {
        window.location.assign(props.navigate === "$next" ? (data.next ?? "/") : props.navigate);
        return;
      }
      router.refresh();
    } catch {
      setError({ error: "Could not reach the server. Nothing was changed." });
    } finally {
      setBusy(false);
    }
  }

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const values: Record<string, unknown> = {};
    for (const [k, v] of form.entries()) values[k] = typeof v === "string" ? v : "";
    void run(values);
  }

  const cls = `btn${props.small ? " btn-row" : ""}${props.tone === "primary" ? " btn-accent" : props.tone === "danger" ? " btn-danger" : ""}`;

  return (
    <div className="staff-action">
      {!open && (
        <button
          type="button"
          className={cls}
          disabled={busy || props.disabled}
          onClick={() => (needsForm ? setOpen(true) : void run({}))}
        >
          {busy ? "Working…" : props.label}
        </button>
      )}

      {open && (
        <form className="staff-action-form" onSubmit={submit} aria-labelledby={`${formId}-q`}>
          {props.confirm && (
            <p id={`${formId}-q`} className="staff-action-question">
              {props.confirm}
            </p>
          )}
          {props.fields?.map((f) => (
            <label key={f.name} className="staff-field">
              <span>{f.label}</span>
              {f.type === "select" ? (
                <select name={f.name} defaultValue={f.defaultValue} required={f.required}>
                  {f.options?.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : f.type === "textarea" ? (
                <textarea name={f.name} defaultValue={f.defaultValue} required={f.required} rows={4} placeholder={f.placeholder} />
              ) : (
                <input name={f.name} type={f.type} defaultValue={f.defaultValue} required={f.required} min={f.min} max={f.max} placeholder={f.placeholder} />
              )}
            </label>
          ))}
          {props.reason && (
            <label className="staff-field">
              <span>{props.reason}</span>
              <textarea name="reason" required minLength={3} maxLength={1000} rows={2} />
            </label>
          )}
          <div className="staff-action-buttons">
            <button type="submit" className={`btn btn-row${props.tone === "danger" ? " btn-danger" : " btn-accent"}`} disabled={busy}>
              {busy ? "Working…" : (props.submitLabel ?? props.label)}
            </button>
            <button type="button" className="btn btn-row" disabled={busy} onClick={() => { setOpen(false); setError(null); }}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {error && (
        <div role="alert" className="staff-action-error">
          {error.error}
          {error.problems && error.problems.length > 0 && (
            <ul>
              {error.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {done?.link && (
        <div className="staff-action-done" role="status">
          <div>
            Link made. It works once, for {done.minutes ?? 30} minutes. Give it to the person yourself: nothing was emailed.
          </div>
          <input readOnly value={done.link} aria-label="Password reset link" onFocus={(e) => e.currentTarget.select()} />
          <button
            type="button"
            className="btn btn-row"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(done.link!);
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
          >
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
      )}
      {done && !done.link && props.done && (
        <div className="staff-action-done" role="status">
          {props.done}
        </div>
      )}
    </div>
  );
}

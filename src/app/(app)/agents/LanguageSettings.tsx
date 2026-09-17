"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { VenueLanguages } from "@/lib/types";
import {
  LANGUAGE_CHANNELS,
  LANGUAGE_CHANNEL_LABELS,
  MAX_ALSO_LANGUAGES,
  type LanguageChannel,
  type LanguageCode,
} from "@/config/languages";

/**
 * The languages a business's customers are answered in.
 *
 * Self-contained: its own state, its own save (PATCH /api/languages), nothing
 * shared with the page around it. Mounted on the agent page today and meant to
 * move to "Your business" as it is.
 *
 * Only languages that are fully built on this deployment are offered — every
 * customer message written and every safety check able to read them — which
 * is what `options` holds (language.ts `selectableLanguages`).
 */

export interface LanguageOption {
  code: LanguageCode;
  name: string;
  nativeName: string;
  formality: { default: string; options: readonly string[] } | null;
}

const PICK_OPTIONS = [
  { id: "auto", label: "Switch automatically (recommended)", hint: "Belle greets in the main language and answers in another one as soon as the customer speaks or writes it." },
  { id: "ask", label: "Ask callers first (phone only)", hint: "The greeting offers each language, and the call carries on in the one the caller picks. Chat always switches automatically." },
] as const;

export default function LanguageSettings({
  locationId,
  initial,
  options,
}: {
  locationId: string;
  initial: VenueLanguages;
  options: LanguageOption[];
}) {
  const router = useRouter();
  const offered = new Set(options.map((o) => o.code));
  const clean = (v: VenueLanguages): VenueLanguages => ({
    main: offered.has(v.main) ? v.main : "en",
    also: v.also.filter((l) => offered.has(l) && l !== v.main).slice(0, MAX_ALSO_LANGUAGES),
    pick: v.pick === "ask" ? "ask" : "auto",
    channels: Object.fromEntries(Object.entries(v.channels ?? {}).filter(([, l]) => l && offered.has(l))),
    formality: v.formality ?? {},
  });
  const [value, setValue] = useState<VenueLanguages>(() => clean(initial));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(value) !== JSON.stringify(clean(initial));

  if (options.length < 2) return null;

  const nameOf = (code: LanguageCode) => options.find((o) => o.code === code)?.name ?? code;
  const update = (next: Partial<VenueLanguages>) => {
    setValue((v) => ({ ...v, ...next }));
    setSaved(false);
    setError(null);
  };

  function setMain(main: LanguageCode) {
    update({ main, also: value.also.filter((l) => l !== main) });
  }

  function toggleAlso(code: LanguageCode, on: boolean) {
    update({ also: on ? [...value.also, code].slice(0, MAX_ALSO_LANGUAGES) : value.also.filter((l) => l !== code) });
  }

  function setChannel(channel: LanguageChannel, code: string) {
    const channels = { ...(value.channels ?? {}) };
    if (code) channels[channel] = code as LanguageCode;
    else delete channels[channel];
    update({ channels });
  }

  function setFormality(code: LanguageCode, form: string) {
    update({ formality: { ...(value.formality ?? {}), [code]: form } });
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/languages", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locationId, languages: value }),
      });
      if (res.ok) {
        setSaved(true);
        router.refresh();
      } else {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "That did not save. Try again.");
      }
    } catch {
      setError("That did not save. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  const spoken = [value.main, ...value.also];
  const withForms = options.filter((o) => o.formality && o.formality.options.length > 1 && spoken.includes(o.code));

  return (
    <section className="panel" style={{ padding: 18, marginBottom: 16 }} aria-labelledby="language-settings-title">
      <h2 id="language-settings-title" style={{ fontSize: 14, margin: "0 0 6px", fontWeight: 700 }}>
        Languages
      </h2>
      <p className="muted" style={{ fontSize: 12, margin: "0 0 14px", lineHeight: 1.45 }}>
        Belle&rsquo;s safety checks only cover these languages, so only these can be chosen. Calls, the website button, chat,
        WhatsApp, and the texts and emails customers get all follow this. Your dashboard stays in English.
      </p>

      <div style={{ marginBottom: 16 }}>
        <label htmlFor="language-main">Main language</label>
        <select id="language-main" value={value.main} onChange={(e) => setMain(e.target.value as LanguageCode)}>
          {options.map((o) => (
            <option key={o.code} value={o.code}>
              {o.name}
              {o.nativeName !== o.name ? ` (${o.nativeName})` : ""}
            </option>
          ))}
        </select>
        <div className="muted" style={{ fontSize: 11.5, marginTop: 5 }}>
          Belle greets in this language. Write the opening line in it too.
        </div>
      </div>

      <fieldset style={{ border: 0, padding: 0, margin: "0 0 16px" }}>
        <legend style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>Also speaks (up to {MAX_ALSO_LANGUAGES})</legend>
        {options
          .filter((o) => o.code !== value.main)
          .map((o) => {
            const on = value.also.includes(o.code);
            const full = !on && value.also.length >= MAX_ALSO_LANGUAGES;
            return (
              <label key={o.code} style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 400, marginBottom: 4 }}>
                <input
                  type="checkbox"
                  checked={on}
                  disabled={full}
                  onChange={(e) => toggleAlso(o.code, e.target.checked)}
                  style={{ width: "auto" }}
                />
                {o.name}
                {o.nativeName !== o.name ? ` (${o.nativeName})` : ""}
              </label>
            );
          })}
      </fieldset>

      {value.also.length > 0 && (
        <fieldset style={{ border: 0, padding: 0, margin: "0 0 16px" }}>
          <legend style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>How Belle picks the language</legend>
          {PICK_OPTIONS.map((p) => (
            <label key={p.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontWeight: 400, marginBottom: 8 }}>
              <input
                type="radio"
                name="language-pick"
                value={p.id}
                checked={value.pick === p.id}
                onChange={() => update({ pick: p.id })}
                style={{ width: "auto", marginTop: 3 }}
              />
              <span>
                {p.label}
                <span className="muted" style={{ display: "block", fontSize: 11.5, lineHeight: 1.45 }}>
                  {p.hint}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      )}

      {withForms.map((o) => (
        <div key={o.code} style={{ marginBottom: 16 }}>
          <label htmlFor={`language-form-${o.code}`}>Form of address in {o.name}</label>
          <select
            id={`language-form-${o.code}`}
            value={value.formality?.[o.code] ?? o.formality!.default}
            onChange={(e) => setFormality(o.code, e.target.value)}
          >
            {o.formality!.options.map((form) => (
              <option key={form} value={form}>
                {form}
                {form === o.formality!.default ? " (usual for businesses)" : ""}
              </option>
            ))}
          </select>
        </div>
      ))}

      <details style={{ marginBottom: 16 }}>
        <summary style={{ cursor: "pointer", fontSize: 12.5, fontWeight: 600 }}>A different main language per channel</summary>
        <div style={{ marginTop: 10 }}>
          {LANGUAGE_CHANNELS.map((channel) => (
            <div key={channel} style={{ marginBottom: 10 }}>
              <label htmlFor={`language-channel-${channel}`}>{LANGUAGE_CHANNEL_LABELS[channel]}</label>
              <select
                id={`language-channel-${channel}`}
                value={value.channels?.[channel] ?? ""}
                onChange={(e) => setChannel(channel, e.target.value)}
              >
                <option value="">Same as the business ({nameOf(value.main)})</option>
                {options.map((o) => (
                  <option key={o.code} value={o.code}>
                    {o.name}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      </details>

      {error && (
        <div role="alert" style={{ color: "var(--bad)", fontSize: 12, marginBottom: 10 }}>
          {error}
        </div>
      )}
      <button className="btn btn-accent" onClick={save} disabled={saving || !dirty}>
        {saving ? "Saving…" : saved && !dirty ? "Saved" : "Save languages"}
      </button>
    </section>
  );
}

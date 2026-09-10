"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { AgentConfig } from "@/lib/types";

interface VoiceOption {
  id: string;
  name: string;
  description: string;
  cloned?: boolean;
}

const MODELS = [
  { id: "claude-opus-5", label: "Opus 5 — best judgement" },
  { id: "claude-sonnet-5", label: "Sonnet 5 — faster, cheaper" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5 — fastest, simple venues" },
];

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label>{label}</label>
      {children}
      {hint && (
        <div className="muted" style={{ fontSize: 11.5, marginTop: 5, lineHeight: 1.45 }}>
          {hint}
        </div>
      )}
    </div>
  );
}

export default function AgentEditor({
  locationId,
  initial,
}: {
  locationId: string;
  initial: AgentConfig;
}) {
  const router = useRouter();
  const [agent, setAgent] = useState<AgentConfig>(initial);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [voiceNote, setVoiceNote] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/voices")
      .then((r) => r.json())
      .then((data: { voices?: VoiceOption[]; note?: string }) => {
        if (cancelled) return;
        setVoices(data.voices ?? []);
        setVoiceNote(data.note ?? null);
      })
      .catch(() => setVoiceNote("Could not load the voice list."));
    return () => {
      cancelled = true;
    };
  }, []);

  async function previewVoice() {
    setPreviewError(null);
    setPreviewing(true);
    try {
      const res = await fetch("/api/voices/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          voiceId: agent.voiceId,
          locationId,
          // Preview the line this voice will actually open with.
          text: agent.greeting,
        }),
      });
      if (!res.ok) {
        const { error } = (await res.json().catch(() => ({}))) as { error?: string };
        setPreviewError(error ?? `Preview failed (${res.status}).`);
        return;
      }
      const url = URL.createObjectURL(await res.blob());
      audioRef.current?.pause();
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play();
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewing(false);
    }
  }

  const knownVoice = voices.some((v) => v.id === agent.voiceId);

  function set<K extends keyof AgentConfig>(key: K, value: AgentConfig[K]) {
    setAgent((a) => ({ ...a, [key]: value }));
    setSaved(false);
  }

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/agent", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locationId, agent }),
      });
      if (res.ok) {
        setSaved(true);
        router.refresh();
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="split">
      <div className="panel" style={{ padding: 18 }}>
        <h2 style={{ fontSize: 14, margin: "0 0 16px", fontWeight: 700 }}>Voice and manner</h2>

        <Field label="Agent name" hint="How it introduces itself.">
          <input value={agent.displayName} onChange={(e) => set("displayName", e.target.value)} />
        </Field>

        <Field
          label="Opening line"
          hint="Spoken the instant the call connects, before the model is involved — which is why pickup feels immediate."
        >
          <textarea
            rows={2}
            value={agent.greeting}
            onChange={(e) => set("greeting", e.target.value)}
          />
        </Field>

        <Field
          label="Opening line for a returning guest"
          hint="Used instead of the line above when the caller's number matches a past booking. {name} becomes the name they booked under. Leave blank to greet everyone the same way."
        >
          <textarea
            rows={2}
            value={agent.returningGreeting ?? ""}
            placeholder="Leave blank to disable"
            onChange={(e) => set("returningGreeting", e.target.value)}
          />
        </Field>

        <Field label="Manner" hint="Folded into the system prompt. Describe a person, not a policy.">
          <textarea rows={3} value={agent.persona} onChange={(e) => set("persona", e.target.value)} />
        </Field>

        <Field
          label="Voice"
          hint={
            voiceNote ??
            "Loaded from your ElevenLabs account, cloned voices first. Preview speaks the opening line above, so you hear it saying the venue's own name."
          }
        >
          <div style={{ display: "flex", gap: 8 }}>
            <select
              value={knownVoice ? agent.voiceId : "__custom"}
              onChange={(e) => {
                if (e.target.value !== "__custom") set("voiceId", e.target.value);
              }}
              style={{ flex: 1 }}
            >
              {voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.cloned ? "★ " : ""}
                  {v.name}
                  {v.description ? ` — ${v.description}` : ""}
                </option>
              ))}
              <option value="__custom">Another voice id…</option>
            </select>
            <button
              className="btn"
              onClick={previewVoice}
              disabled={previewing || !agent.voiceId}
              style={{ flexShrink: 0 }}
            >
              {previewing ? "…" : "▶ Hear it"}
            </button>
          </div>
          {!knownVoice && voices.length > 0 && (
            <input
              value={agent.voiceId}
              placeholder="Paste an ElevenLabs voice id"
              onChange={(e) => set("voiceId", e.target.value)}
              style={{ marginTop: 8 }}
            />
          )}
          {previewError && (
            <div style={{ color: "var(--bad)", fontSize: 11.5, marginTop: 6 }}>
              {previewError}
            </div>
          )}
        </Field>

        <Field
          label="Model"
          hint="Opus reasons best about awkward calls. Haiku answers fastest. Latency difference on a simple booking is roughly 300 ms."
        >
          <select value={agent.model} onChange={(e) => set("model", e.target.value)}>
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </Field>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Max call length (s)">
            <input
              type="number"
              value={agent.maxCallSeconds}
              onChange={(e) => set("maxCallSeconds", Number(e.target.value))}
            />
          </Field>
          <Field label="Book ahead (days)">
            <input
              type="number"
              value={agent.bookingHorizonDays}
              onChange={(e) => set("bookingHorizonDays", Number(e.target.value))}
            />
          </Field>
        </div>

        <Field label="Transfer number" hint="Leave blank to disable transfers entirely.">
          <input
            value={agent.transferNumber ?? ""}
            onChange={(e) => set("transferNumber", e.target.value)}
          />
        </Field>
      </div>

      <div className="panel" style={{ padding: 18 }}>
        <h2 style={{ fontSize: 14, margin: "0 0 16px", fontWeight: 700 }}>Rules and answers</h2>

        <Field
          label="House rules"
          hint="One per line. These are hard constraints — deposits, cut-offs, what it must never promise."
        >
          <textarea
            rows={8}
            value={agent.policies.join("\n")}
            onChange={(e) => set("policies", e.target.value.split("\n"))}
          />
        </Field>

        <label>Common questions</label>
        {agent.faqs.map((faq, i) => (
          <div
            key={i}
            style={{
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: 11,
              marginBottom: 8,
              background: "var(--panel-2)",
            }}
          >
            <input
              value={faq.q}
              placeholder="Question"
              onChange={(e) => {
                const faqs = agent.faqs.slice();
                faqs[i] = { ...faq, q: e.target.value };
                set("faqs", faqs);
              }}
              style={{ marginBottom: 6 }}
            />
            <textarea
              rows={2}
              value={faq.a}
              placeholder="Answer, as it should be said aloud"
              onChange={(e) => {
                const faqs = agent.faqs.slice();
                faqs[i] = { ...faq, a: e.target.value };
                set("faqs", faqs);
              }}
            />
            <button
              className="btn btn-danger"
              style={{ marginTop: 7, padding: "5px 11px", fontSize: 12 }}
              onClick={() => set("faqs", agent.faqs.filter((_, j) => j !== i))}
            >
              Remove
            </button>
          </div>
        ))}
        <button
          className="btn"
          style={{ marginBottom: 18 }}
          onClick={() => set("faqs", [...agent.faqs, { q: "", a: "" }])}
        >
          + Add question
        </button>

        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <button className="btn btn-accent" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
          {saved && (
            <span style={{ color: "var(--ok)", fontSize: 12.5 }}>
              Saved — the next call uses it.
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

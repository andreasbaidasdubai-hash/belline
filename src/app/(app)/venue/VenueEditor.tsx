"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { BookingPolicy, RestaurantConfig, SalonConfig } from "@/lib/types";
import type { Terms } from "@/lib/verticals";
import type { Finding } from "@/lib/booking/config";
import RulesEditor from "./RulesEditor";
import RoomEditor from "./RoomEditor";
import DiaryEditor from "./DiaryEditor";

/**
 * One draft, one save, one version in the history.
 *
 * The three editors below could each have had their own save button, and that
 * would have been easier. It would also have been wrong: a venue adding a
 * service and the person who does it is making *one* change, and splitting it
 * into two saves means the intermediate state — a service nobody can do — is
 * the one that gets validated, refused, and has to be worked around.
 *
 * So the whole venue is held as a draft, checked as a whole, and published as
 * a whole. The server checks it again and is the authority; this copy exists
 * to put the problem next to the field rather than at the bottom of the page.
 */

export interface Draft {
  policy: BookingPolicy;
  restaurant?: RestaurantConfig;
  salon?: SalonConfig;
}

export default function VenueEditor({
  locationId,
  currency,
  terms,
  initial,
  initialFindings,
}: {
  locationId: string;
  currency: string;
  terms: Terms;
  initial: Draft;
  initialFindings: Finding[];
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(initial);
  const [findings, setFindings] = useState<Finding[]>(initialFindings);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState("");
  const [result, setResult] = useState<{ text: string; bad: boolean } | null>(null);

  // Findings are keyed by where they belong so an editor can put the message
  // under the field that caused it. Only the first per field is shown: a form
  // that stacks four complaints on one input is a form people give up on.
  const problems = useMemo(() => {
    const map = new Map<string, string>();
    for (const f of findings) {
      if (f.level === "error" && !map.has(f.where)) map.set(f.where, f.message);
    }
    return map;
  }, [findings]);

  const warnings = findings.filter((f) => f.level === "warning");
  const errors = findings.filter((f) => f.level === "error");

  function update(patch: Partial<Draft>) {
    setDraft((d) => ({ ...d, ...patch }));
    setDirty(true);
    setResult(null);
  }

  async function save() {
    setSaving(true);
    setResult(null);
    try {
      const res = await fetch("/api/venue", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          locationId,
          // Sent whether or not it has anything in it: clearing every rule is
          // an edit, and an absent key would read as "leave it alone".
          policy: Object.keys(draft.policy).length > 0 ? draft.policy : null,
          ...(draft.restaurant ? { restaurant: draft.restaurant } : {}),
          ...(draft.salon ? { salon: draft.salon } : {}),
          note: note.trim() || undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        findings?: Finding[];
        version?: number;
        changed?: boolean;
      };

      setFindings(data.findings ?? []);

      if (!res.ok) {
        setResult({ text: data.error ?? `That did not save (${res.status}).`, bad: true });
        return;
      }

      setDirty(false);
      setNote("");
      setResult({
        text: data.changed
          ? `Saved as version ${data.version}. The next call uses it — nothing to deploy.`
          : "Nothing had changed, so no new version was written.",
        bad: false,
      });
      router.refresh();
    } catch (err) {
      setResult({ text: err instanceof Error ? err.message : String(err), bad: true });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {errors.length > 0 && (
        <div
          className="panel"
          style={{
            padding: "13px 16px",
            marginBottom: 16,
            borderColor: "var(--bad)",
            background: "var(--bad-soft)",
          }}
        >
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
            {errors.length === 1 ? "One thing" : `${errors.length} things`} would stop the diary
            working
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.6 }}>
            {errors.slice(0, 6).map((f, i) => (
              <li key={`${f.where}-${i}`}>{f.message}</li>
            ))}
          </ul>
        </div>
      )}

      {draft.restaurant && (
        <RoomEditor
          config={draft.restaurant}
          onChange={(restaurant) => update({ restaurant })}
          problems={problems}
        />
      )}

      {draft.salon && (
        <DiaryEditor
          config={draft.salon}
          onChange={(salon) => update({ salon })}
          currency={currency}
          t={terms}
          problems={problems}
        />
      )}

      <RulesEditor
        policy={draft.policy}
        onChange={(policy) => update({ policy })}
        currency={currency}
        guestsWord={terms.guests}
        problems={problems}
      />

      {warnings.length > 0 && (
        <div className="panel" style={{ padding: "13px 16px", marginBottom: 16 }}>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
            Worth a look
            <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>
              none of these stop anything
            </span>
          </div>
          <ul className="muted" style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.6 }}>
            {warnings.map((f, i) => (
              <li key={`${f.where}-${i}`}>{f.message}</li>
            ))}
          </ul>
        </div>
      )}

      {/* The save bar. Sticky, because these pages are long and a save button
          at the bottom of a price list with forty services is a save button
          nobody finds. */}
      <div
        className="panel"
        style={{
          position: "sticky",
          bottom: 16,
          padding: "12px 16px",
          display: "flex",
          gap: 12,
          alignItems: "center",
          flexWrap: "wrap",
          boxShadow: "0 6px 20px rgba(20, 17, 13, 0.09)",
        }}
      >
        <input
          value={note}
          placeholder="What changed, in a line — kept with the version"
          onChange={(e) => setNote(e.target.value)}
          style={{ flex: 1, minWidth: 220 }}
        />
        {result && (
          <span style={{ fontSize: 12.5, color: result.bad ? "var(--bad)" : "var(--ok)" }}>
            {result.text}
          </span>
        )}
        {dirty && !result && (
          <span className="muted" style={{ fontSize: 12.5 }}>
            unsaved
          </span>
        )}
        <button className="btn btn-accent" onClick={save} disabled={saving || !dirty}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </>
  );
}

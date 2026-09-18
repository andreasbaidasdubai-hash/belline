"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * The one change of destination a live venue makes from the Calendars page:
 * between booking straight into a connected calendar and taking requests.
 *
 * It posts the same action the setup step does (/api/setup/journey,
 * `destination`), so `recordStep` decides: a calendar can only be chosen while
 * its connection is usable. The page renders a button only when that is
 * already true, and only when the venue has what booking needs (readiness),
 * so the answer here is normally yes; when it is not, the server's sentence is
 * shown as it is.
 */
export default function DestinationSwitch({
  locationId,
  to,
  label,
}: {
  locationId: string;
  to: "requests" | "google" | "outlook" | "calendly";
  label: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function choose() {
    setBusy(true);
    setProblem(null);
    try {
      const res = await fetch("/api/setup/journey", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "destination", locationId, destination: to }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setProblem(data.error ?? "That did not save. Try again.");
        setBusy(false);
        return;
      }
      router.refresh();
    } catch {
      setProblem("Could not reach Belline. Check your connection and try again.");
    }
    setBusy(false);
  }

  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
      <button type="button" className="btn" onClick={choose} disabled={busy}>
        {busy ? "Saving…" : label}
      </button>
      {problem && (
        <span role="alert" style={{ fontSize: 13, color: "var(--bad)" }}>
          {problem}
        </span>
      )}
    </span>
  );
}

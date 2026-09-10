import type { Call, Location } from "./types";
import { id, listCalls, saveCall } from "./store";
import { currentVersion } from "./brain";

export function startCall(
  location: Location,
  channel: Call["channel"],
  from: string,
): Call {
  const call: Call = {
    id: id("call"),
    locationId: location.id,
    channel,
    from,
    startedAt: new Date().toISOString(),
    status: "active",
    outcome: null,
    transcript: [],
    toolCalls: [],
    latenciesMs: [],
    // Stamped at the start, not read at the end: a venue edited mid-call must
    // not retroactively change what this call was answered under.
    brainVersion: currentVersion(location)?.number,
  };
  return saveCall(call);
}

/**
 * Close out calls that were live when the process last stopped.
 *
 * A call record has no end time until someone hangs up, and duration is
 * measured against `now` — so a session killed mid-call leaves a row that
 * reports itself as active and grows by a second every second. Run this at
 * boot, before anything reads the call list.
 */
export function reconcileStaleCalls(): number {
  const stale = listCalls().filter((c) => c.status === "active");
  for (const call of stale) {
    const lastActivity =
      call.transcript[call.transcript.length - 1]?.at ?? call.startedAt;
    saveCall({
      ...call,
      status: "failed",
      endedAt: lastActivity,
      outcome: call.outcome ?? "abandoned",
      summary: call.summary ?? "Interrupted — the server stopped mid-call.",
    });
  }
  return stale.length;
}

export function callDurationSeconds(call: Call): number {
  const end = call.endedAt ? Date.parse(call.endedAt) : Date.now();
  return Math.max(0, Math.round((end - Date.parse(call.startedAt)) / 1000));
}

export function medianLatency(call: Call): number | null {
  if (call.latenciesMs.length === 0) return null;
  const sorted = call.latenciesMs.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

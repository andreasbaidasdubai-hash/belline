import { requireUser } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import { listLocations } from "@/lib/store";
import { seedIfEmpty } from "@/lib/seed";
import { flagState } from "@/lib/flags";
import { videoConfig, missingVideoConfig } from "@/lib/video/config";
import { readVideoControl } from "@/lib/video/control";
import { dailyVideoLimit, venueAllowlisted, videoAvailability, videoSessionsToday } from "@/lib/video/availability";
import { liveVideoSessions } from "@/lib/video/sessions";
import { recentVideoMetrics, type VideoMetricName } from "@/lib/video/metrics";
import { ConsoleHeader, EmptyState, KeyValues, Pill, ago } from "../../ui";
import SettingsTabs from "../SettingsTabs";
import VideoAction from "./VideoControls";

export const dynamic = "force-dynamic";

/**
 * The video receptionist, from Belline's side: is it on, where, and how fast.
 *
 * The switch that turns it off everywhere comes first on purpose. It stops
 * video on every location and ends every live call without a deploy, and the
 * day it is needed nobody should scroll for it. Settings names that are
 * missing are shown; their values never are.
 */

const TIMINGS: { name: VideoMetricName; label: string }[] = [
  { name: "session_created", label: "Room ready" },
  { name: "ready", label: "Visitor joined" },
  { name: "first_frame", label: "Face first seen" },
  { name: "llm_first_token", label: "Reply started" },
  { name: "first_response", label: "First words heard" },
];

const REASON: Record<string, string> = {
  flag_off: "switched off for everyone",
  kill_switch: "turned off everywhere",
  not_allowlisted: "not on the list",
  venue_disabled: "off in the location's settings",
  daily_cap: "today's limit reached",
  not_in_plan: "not in their plan",
};

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export default async function VideoSettings() {
  seedIfEmpty();
  const user = await requireUser();
  if (!isBellineStaff(user)) return <p className="muted">Belline staff only.</p>;

  const state = flagState("video.avatar");
  const config = videoConfig();
  const missing = [...new Set([...state.missing, ...missingVideoConfig(config)])];
  const control = readVideoControl();
  const venues = listLocations({ includeInternal: true }).filter((l) => l.embed?.enabled);
  const live = liveVideoSessions();
  const metrics = recentVideoMetrics();
  const count = (name: VideoMetricName) => metrics.filter((m) => m.name === name).length;

  return (
    <>
      <ConsoleHeader
        title="Settings"
        subtitle={`Video receptionist: ${state.on ? "switched on" : "switched off"}${config.provider === "mock" ? ", using a stand-in face for testing, not a live avatar" : ""} · ${live.length} call${live.length === 1 ? "" : "s"} live`}
      />
      <SettingsTabs active="/sales/settings/video" />

      <section className={`panel staff-section${control.killSwitch.on ? " staff-warning" : ""}`} style={{ marginBottom: 16 }}>
        <div className="panel-head">Turn video off everywhere</div>
        <div className="staff-body" style={{ display: "grid", gap: 10 }}>
          <p className="staff-note">
            {control.killSwitch.on
              ? `Video is off everywhere: turned off by ${control.killSwitch.by ?? "staff"} ${control.killSwitch.at ? ago(control.killSwitch.at) : ""}.`
              : "Video runs wherever it is switched on, the location is on the list below, and the location's own settings allow it."}
          </p>
          <div>
            {control.killSwitch.on ? (
              <VideoAction action="restore" label="Allow video again" confirm="Let video run again wherever it is allowed?" />
            ) : (
              <VideoAction action="kill" label="Turn video off everywhere now" danger confirm="Turn video off on every location and end every live video call?" />
            )}
          </div>
          {missing.length > 0 && <p className="staff-note" style={{ color: "var(--bl-warning)" }}>Missing server settings: {missing.join(", ")}</p>}
        </div>
      </section>

      <section className="panel staff-section" style={{ marginBottom: 16 }}>
        <div className="panel-head">Locations with the website button on</div>
        {venues.length === 0 ? (
          <EmptyState title="No location has the website button on">Video can only be offered where the website button is switched on.</EmptyState>
        ) : (
          <div className="table-wrap" tabIndex={0}>
            <table className="staff-table">
              <thead>
                <tr>
                  <th>Location</th>
                  <th>On the list</th>
                  <th>Offered now</th>
                  <th className="num">Today</th>
                  <th>
                    <span className="sr-only">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {venues.map((v) => {
                  const listed = venueAllowlisted(v, config);
                  const availability = videoAvailability(v);
                  return (
                    <tr key={v.id}>
                      <td style={{ fontWeight: 600 }}>{v.name}</td>
                      <td>{listed ? "Yes" : "No"}</td>
                      <td>{availability.on ? <Pill tone="ok">Yes</Pill> : `No: ${REASON[availability.reason] ?? availability.reason.replace(/_/g, " ")}`}</td>
                      <td className="num">
                        {videoSessionsToday(v)} of {dailyVideoLimit(v, config)}
                      </td>
                      <td>{listed ? <VideoAction action="disallow" locationId={v.id} label="Remove" confirm={`Stop offering video on ${v.name}'s website?`} /> : <VideoAction action="allow" locationId={v.id} label="Allow video" />}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel staff-section" style={{ marginBottom: 16 }}>
        <div className="panel-head">Live calls</div>
        {live.length === 0 ? (
          <EmptyState title="No video call is live" />
        ) : (
          <div className="staff-body" style={{ display: "grid", gap: 8 }}>
            {live.map((s) => (
              <div key={s.id} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: 13 }}>
                <span>{listLocations({ includeInternal: true }).find((l) => l.id === s.locationId)?.name ?? "A location"}</span>
                <span className="muted">started {ago(new Date(s.createdAt).toISOString())}</span>
                <VideoAction action="end" sessionId={s.id} label="End call" confirm="End this live video call now?" danger />
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="panel staff-section">
        <div className="panel-head">How fast, since the server started</div>
        <div className="staff-body">
          <KeyValues
            rows={[
              ...TIMINGS.map((t): [string, string] => {
                const values = metrics.filter((m) => m.name === t.name && typeof m.ms === "number").map((m) => m.ms!);
                const p50 = median(values);
                return [t.label, p50 === null ? "No calls yet" : `${p50} ms typical, over ${values.length} call${values.length === 1 ? "" : "s"}`];
              }),
              ["Calls", `${count("video_selected")} chosen, ${count("session_created")} started, ${count("session_create_failed")} failed to start, ${count("ended")} ended`],
              ["Fell back", `${count("mic_denied")} refused the microphone, ${count("fallback_chat")} moved to chat, ${count("fallback_voice")} to voice`],
              ["Outcomes", `${count("booking_or_lead")} bookings or leads, ${count("handover_requested")} asked for a person`],
            ]}
          />
        </div>
      </section>
    </>
  );
}

import { requireUser } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import { PageHeader } from "@/components/LocationTabs";
import { listLocations } from "@/lib/store";
import { seedIfEmpty } from "@/lib/seed";
import { flagState } from "@/lib/flags";
import { videoConfig, missingVideoConfig } from "@/lib/video/config";
import { readVideoControl } from "@/lib/video/control";
import { venueAllowlisted, videoAvailability, videoSessionsToday } from "@/lib/video/availability";
import { liveVideoSessions } from "@/lib/video/sessions";
import { recentVideoMetrics, type VideoMetricName } from "@/lib/video/metrics";
import VideoAction from "./VideoControls";

export const dynamic = "force-dynamic";

/**
 * The video receptionist, from Belline's side: is it on, where, and how fast.
 *
 * The kill switch is the first thing on the page on purpose. It stops video on
 * every venue and ends every live call without a deploy, and the day it is
 * needed nobody should have to scroll for it. Staff only, checked here as well
 * as in the layout. Env var names are shown when missing; values never are.
 */

const TIMINGS: { name: VideoMetricName; label: string }[] = [
  { name: "session_created", label: "Room created" },
  { name: "ready", label: "Joined (panel)" },
  { name: "first_frame", label: "First frame of the face" },
  { name: "llm_first_token", label: "Model: first words" },
  { name: "first_response", label: "First words heard (panel)" },
];

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export default async function VideoConsole() {
  seedIfEmpty();
  const user = await requireUser();
  if (!isBellineStaff(user)) return <p className="muted">Not available.</p>;

  const state = flagState("video.avatar");
  const config = videoConfig();
  const missing = missingVideoConfig(config);
  const control = readVideoControl();
  const venues = listLocations({ includeInternal: true }).filter((l) => l.embed?.enabled);
  const live = liveVideoSessions();
  const metrics = recentVideoMetrics();
  const count = (name: VideoMetricName) => metrics.filter((m) => m.name === name).length;

  return (
    <>
      <PageHeader
        title="Video receptionist"
        subtitle={`Provider: ${config.provider}${config.provider === "mock" ? " (MOCK — not a live avatar)" : ""} · flag ${state.on ? "on" : `off (${state.reason})`} · ${live.length} live`}
      />

      <section className="panel" style={{ padding: "18px 20px", marginBottom: 16 }}>
        <h2 style={{ fontSize: 15, margin: "0 0 6px" }}>Kill switch</h2>
        <p className="muted" style={{ margin: "0 0 12px", fontSize: 13.5 }}>
          {control.killSwitch.on
            ? `Video is OFF everywhere — switched off by ${control.killSwitch.by ?? "staff"} at ${control.killSwitch.at ?? "an unknown time"}.`
            : "Video runs wherever the flag, the venue list and the venue's own settings allow it."}
        </p>
        {control.killSwitch.on ? (
          <VideoAction action="restore" label="Allow video again" />
        ) : (
          <VideoAction
            action="kill"
            label="Turn video off everywhere now"
            danger
            confirm="Turn video off on every venue and end every live video call?"
          />
        )}
        {(missing.length > 0 || state.missing.length > 0) && (
          <p style={{ margin: "12px 0 0", fontSize: 13, color: "var(--warn)" }}>
            Missing configuration: {[...new Set([...state.missing, ...missing])].join(", ")}
          </p>
        )}
      </section>

      <section className="panel" style={{ padding: "18px 20px", marginBottom: 16 }}>
        <h2 style={{ fontSize: 15, margin: "0 0 10px" }}>Venues with the website widget on</h2>
        <table className="table" style={{ width: "100%" }}>
          <thead>
            <tr>
              <th scope="col">Venue</th>
              <th scope="col">On the list</th>
              <th scope="col">Offered now</th>
              <th scope="col">Today</th>
              <th scope="col">
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
                  <td>
                    {v.name} <span className="muted">({v.id})</span>
                  </td>
                  <td>{listed ? "Yes" : "No"}</td>
                  <td>{availability.on ? "Yes" : `No — ${availability.reason.replace(/_/g, " ")}`}</td>
                  <td>
                    {videoSessionsToday(v)} / {config.maxSessionsPerDay}
                  </td>
                  <td>
                    {listed ? (
                      <VideoAction action="disallow" locationId={v.id} label="Remove" />
                    ) : (
                      <VideoAction action="allow" locationId={v.id} label="Allow video" />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="panel" style={{ padding: "18px 20px", marginBottom: 16 }}>
        <h2 style={{ fontSize: 15, margin: "0 0 10px" }}>Live sessions</h2>
        {live.length === 0 ? (
          <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>
            None.
          </p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {live.map((s) => (
              <li key={s.id} style={{ marginBottom: 6 }}>
                {s.id} · {s.locationId} · {s.provider} · started {new Date(s.createdAt).toISOString()}{" "}
                <VideoAction action="end" sessionId={s.id} label="End" />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel" style={{ padding: "18px 20px" }}>
        <h2 style={{ fontSize: 15, margin: "0 0 10px" }}>Since this server started</h2>
        <table className="table" style={{ width: "100%" }}>
          <tbody>
            {TIMINGS.map((t) => {
              const values = metrics.filter((m) => m.name === t.name && typeof m.ms === "number").map((m) => m.ms!);
              const p50 = median(values);
              return (
                <tr key={t.name}>
                  <th scope="row" style={{ textAlign: "left", fontWeight: 500 }}>
                    {t.label}
                  </th>
                  <td>{p50 === null ? "—" : `${p50} ms median of ${values.length}`}</td>
                </tr>
              );
            })}
            <tr>
              <th scope="row" style={{ textAlign: "left", fontWeight: 500 }}>
                Chosen · created · failed · ended
              </th>
              <td>
                {count("video_selected")} · {count("session_created")} · {count("session_create_failed")} · {count("ended")}
              </td>
            </tr>
            <tr>
              <th scope="row" style={{ textAlign: "left", fontWeight: 500 }}>
                Microphone refused · fell back to chat · to voice
              </th>
              <td>
                {count("mic_denied")} · {count("fallback_chat")} · {count("fallback_voice")}
              </td>
            </tr>
            <tr>
              <th scope="row" style={{ textAlign: "left", fontWeight: 500 }}>
                Bookings or leads taken · handovers
              </th>
              <td>
                {count("booking_or_lead")} · {count("handover_requested")}
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </>
  );
}

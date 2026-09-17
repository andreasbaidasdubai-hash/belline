"use client";

import { useEffect, useMemo, useState } from "react";

/**
 * The video receptionist's face and background (api/agent/video).
 *
 * Beside the voice, because it is the same question — how does Belline come
 * across — asked of the video call. Saves itself: a face or background is not
 * part of the agent's prompt, and the next video call picks it up.
 *
 * The preview is honest about what it can show. A face's Tavus preview has
 * its own room behind it, so here it sits softly faded into the chosen
 * background; in a call, faces marked "Backgrounds" have the room replaced
 * outright. Phoenix-4.5 faces cannot (Tavus's own limit) and keep their room.
 */

interface Face {
  id: string;
  name: string;
  model: string;
  backgrounds: boolean;
  clipUrl: string;
  posterUrl: string;
}
interface Background {
  id: string;
  name: string;
  src: string;
  tone: "light" | "dark";
}

export default function VideoLook({ locationId, agentName }: { locationId: string; agentName: string }) {
  const [faces, setFaces] = useState<Face[]>([]);
  const [backgrounds, setBackgrounds] = useState<Background[]>([]);
  const [confirmed, setConfirmed] = useState(true);
  const [faceId, setFaceId] = useState("");
  const [backgroundId, setBackgroundId] = useState("");
  const [saved, setSaved] = useState<{ faceId: string; backgroundId: string } | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "saving" | "error">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [still, setStill] = useState(false);

  useEffect(() => {
    try {
      setStill(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    } catch {
      /* moving previews, then */
    }
    let cancelled = false;
    fetch(`/api/agent/video?locationId=${encodeURIComponent(locationId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: { faces: Face[]; backgrounds: Background[]; confirmed: boolean; current: { faceId: string; backgroundId: string } }) => {
        if (cancelled) return;
        setFaces(data.faces);
        setBackgrounds(data.backgrounds);
        setConfirmed(data.confirmed);
        setFaceId(data.current.faceId);
        setBackgroundId(data.current.backgroundId);
        setSaved(data.current);
        setState("ready");
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [locationId]);

  const face = faces.find((f) => f.id === faceId);
  const background = backgrounds.find((b) => b.id === backgroundId);
  const showsBackground = Boolean(face?.backgrounds && background?.src);
  const dirty = Boolean(saved && (saved.faceId !== faceId || saved.backgroundId !== backgroundId));
  const ownRoom = useMemo(() => backgrounds.find((b) => !b.src), [backgrounds]);

  async function save() {
    setState("saving");
    setMessage(null);
    const res = await fetch("/api/agent/video", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locationId, faceId, backgroundId }),
    }).catch(() => null);
    const body = (await res?.json().catch(() => ({}))) as { error?: string } | undefined;
    if (res?.ok) {
      setSaved({ faceId, backgroundId });
      setMessage("Saved — the next video call uses it.");
    } else {
      setMessage(body?.error ?? "That did not save. Try again.");
    }
    setState("ready");
  }

  if (state === "loading") return <div className="vl-note">Loading faces…</div>;
  if (state === "error") return <div className="vl-note">Couldn&rsquo;t load the video faces. Reload to try again.</div>;

  return (
    <section className="vl" aria-labelledby="vl-title">
      <style>{CSS}</style>
      <div className="vl-head">
        <h3 id="vl-title">Video face and background</h3>
        <p>How {agentName} looks on a video call from your website.</p>
      </div>

      <div className="vl-body">
        <div className="vl-preview" aria-label="Preview">
          <div className={`vl-circle${showsBackground ? " has-bg" : ""}`} style={showsBackground ? { backgroundImage: `url(${background!.src})` } : undefined}>
            {face?.clipUrl && !still ? (
              <video key={face.id} src={face.clipUrl} poster={face.posterUrl || undefined} muted loop autoPlay playsInline aria-hidden="true" />
            ) : face?.posterUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={face.posterUrl} alt="" aria-hidden="true" />
            ) : (
              <span className="vl-initial" aria-hidden="true">
                {(face?.name ?? agentName).slice(0, 1)}
              </span>
            )}
          </div>
          <p className="vl-caption">
            {!face
              ? ""
              : showsBackground
                ? `In a call, ${background!.name.toLowerCase()} replaces the room behind ${face.name.split(" ·")[0]}.`
                : face.backgrounds
                  ? "The face keeps its own room."
                  : "This face keeps its own room: Tavus can't change the background of its newest (Phoenix-4.5) faces yet."}
          </p>
        </div>

        <div className="vl-pickers">
          <fieldset>
            <legend>Face</legend>
            {!confirmed && <p className="vl-hint">Previews appear once video is connected to Tavus.</p>}
            <div className="vl-faces" role="radiogroup" aria-label="Face">
              {faces.map((f) => (
                <label key={f.id} className={`vl-face${f.id === faceId ? " is-on" : ""}`}>
                  <input type="radio" name="vl-face" value={f.id} checked={f.id === faceId} onChange={() => setFaceId(f.id)} />
                  <span className="vl-thumb">
                    {f.posterUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={f.posterUrl} alt="" loading="lazy" />
                    ) : (
                      <span className="vl-initial small">{f.name.slice(0, 1)}</span>
                    )}
                  </span>
                  <span className="vl-name">{f.name}</span>
                  <span className={`vl-tag${f.backgrounds ? "" : " muted"}`}>{f.backgrounds ? "Backgrounds" : "Own room"}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend>Background</legend>
            <div className="vl-bgs" role="radiogroup" aria-label="Background">
              {backgrounds.map((b) => (
                <label key={b.id} className={`vl-bg${b.id === backgroundId ? " is-on" : ""}`} title={b.name}>
                  <input type="radio" name="vl-bg" value={b.id} checked={b.id === backgroundId} onChange={() => setBackgroundId(b.id)} />
                  <span className={`vl-swatch${b.src ? "" : " own"}`} style={b.src ? { backgroundImage: `url(${b.src})` } : undefined} />
                  <span className="vl-name">{b.name}</span>
                </label>
              ))}
            </div>
            {face && !face.backgrounds && backgroundId !== ownRoom?.id && (
              <p className="vl-hint">Saved for later: it shows once you pick a face marked Backgrounds.</p>
            )}
          </fieldset>

          <div className="vl-save">
            <button type="button" className="vl-button" onClick={save} disabled={!dirty || state === "saving"}>
              {state === "saving" ? "Saving…" : "Save look"}
            </button>
            {message && (
              <span role="status" className="vl-status">
                {message}
              </span>
            )}
          </div>
          <p className="vl-hint">
            Want your own face — a member of your staff, with their written consent? Contact us and we&rsquo;ll set it up.
          </p>
        </div>
      </div>
    </section>
  );
}

const CSS = `
.vl { margin: 4px 0 18px; padding: 16px; border: 1px solid var(--bl-rule); border-radius: var(--bl-radius-card); background: var(--bl-ground); color: var(--bl-ink-900); font-family: var(--bl-font-text) }
.vl-head h3 { margin: 0; font-size: 14px; font-weight: var(--bl-weight-heading) }
.vl-head p { margin: 3px 0 14px; font-size: 12.5px; color: var(--bl-text-2) }
.vl-body { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 20px; align-items: start }
.vl-preview { display: grid; justify-items: center; gap: 10px; position: sticky; top: 12px }
.vl-circle { position: relative; width: 180px; aspect-ratio: 1; border-radius: 50%; overflow: hidden; background: var(--bl-navy); background-size: cover; background-position: center;
  box-shadow: 0 0 0 3px var(--bl-ground), 0 0 0 4px var(--bl-blue-line), var(--bl-elev-float); display: grid; place-items: center }
.vl-circle video, .vl-circle img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover }
.vl-circle.has-bg video, .vl-circle.has-bg img { -webkit-mask-image: radial-gradient(circle at 50% 55%, #000 38%, transparent 66%); mask-image: radial-gradient(circle at 50% 55%, #000 38%, transparent 66%) }
.vl-initial { font-family: var(--bl-font-display); font-size: 56px; font-weight: 600; color: var(--bl-on-navy) }
.has-bg .vl-initial { color: var(--bl-ink-900) }
.vl-initial.small { font-size: 22px; color: var(--bl-accent-text) }
.vl-caption { margin: 0; max-width: 200px; text-align: center; font-size: 12px; line-height: 1.4; color: var(--bl-text-2) }
.vl fieldset { border: 0; margin: 0 0 14px; padding: 0; min-width: 0 }
.vl legend { font-size: 12px; font-weight: 600; letter-spacing: var(--bl-track-label); margin-bottom: 8px; padding: 0 }
.vl input[type=radio] { position: absolute; opacity: 0; width: 1px; height: 1px }
.vl-faces { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 8px }
.vl-face { position: relative; display: grid; justify-items: center; gap: 4px; padding: 10px 6px 8px; border: 1px solid var(--bl-rule); border-radius: 12px; cursor: pointer; background: var(--bl-ground); text-align: center }
.vl-face:hover { background: var(--bl-surface) }
.vl-face.is-on, .vl-bg.is-on { border-color: var(--bl-blue); box-shadow: 0 0 0 1px var(--bl-blue) }
.vl-face:focus-within, .vl-bg:focus-within { outline: var(--bl-focus); outline-offset: var(--bl-focus-offset) }
.vl-thumb { width: 56px; height: 56px; border-radius: 50%; overflow: hidden; background: var(--bl-blue-tint); display: grid; place-items: center }
.vl-thumb img { width: 100%; height: 100%; object-fit: cover }
.vl-name { font-size: 12px; line-height: 1.25; font-weight: 500 }
.vl-tag { font-size: 10.5px; line-height: 1.2; padding: 1px 6px; border-radius: var(--bl-radius-pill); background: var(--bl-blue-tint); color: var(--bl-accent-text) }
.vl-tag.muted { background: var(--bl-surface); color: var(--bl-text-2) }
.vl-bgs { display: grid; grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); gap: 8px }
.vl-bg { position: relative; display: grid; gap: 5px; padding: 6px; border: 1px solid var(--bl-rule); border-radius: 12px; cursor: pointer; text-align: center }
.vl-swatch { display: block; aspect-ratio: 1; border-radius: 8px; background-size: cover; background-position: center; border: 1px solid var(--bl-rule-soft) }
.vl-swatch.own { background: repeating-linear-gradient(135deg, var(--bl-surface) 0 8px, var(--bl-sunken) 8px 16px) }
.vl-save { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 4px 0 10px }
.vl-button { appearance: none; border: 0; border-radius: var(--bl-radius-pill); background: var(--bl-blue); color: var(--bl-white); font: inherit; font-weight: var(--bl-weight-button); font-size: 13.5px; min-height: 40px; padding: 0 18px; cursor: pointer }
.vl-button:hover:not(:disabled) { background: var(--bl-blue-hover) }
.vl-button:disabled { opacity: .45; cursor: default }
.vl-button:focus-visible { outline: var(--bl-focus); outline-offset: var(--bl-focus-offset) }
.vl-status { font-size: 12.5px; color: var(--bl-text-2) }
.vl-hint, .vl-note { margin: 6px 0 0; font-size: 12px; line-height: 1.45; color: var(--bl-text-2) }
@media (max-width: 640px) {
  .vl-body { grid-template-columns: minmax(0, 1fr) }
  .vl-preview { position: static }
  .vl-faces { grid-template-columns: repeat(2, minmax(0, 1fr)) }
  .vl-bgs { grid-template-columns: repeat(3, minmax(0, 1fr)) }
}
@media (prefers-reduced-motion: reduce) { .vl-face, .vl-bg { transition: none } }
`;

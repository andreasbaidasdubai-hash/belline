"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Plays a demo call, line by line, with the transcript following along.
 *
 * One `<audio>` element reused across clips rather than one per line: browsers
 * only let audio start from a user gesture, and creating a new element for the
 * second clip puts it outside that gesture, where `play()` is refused —
 * silently, with the page looking like it simply stopped.
 *
 * The transcript advances with the audio rather than on a timer, so it cannot
 * drift out of step with the voice. That drift is the thing that makes a demo
 * feel fake, and it is the whole reason this is driven by `onended`.
 */

export interface Clip {
  id: string;
  role: "agent" | "caller";
  text: string;
}

export default function DemoPlayer({
  clips,
  business,
  onFirstPlay,
}: {
  clips: Clip[];
  business: string;
  /** Fired once, the first time a human presses play. */
  onFirstPlay?: () => void;
}) {
  const [index, setIndex] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const reported = useRef(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const stop = useCallback(() => {
    audioRef.current?.pause();
    setPlaying(false);
    setIndex(-1);
  }, []);

  const playFrom = useCallback(
    (start: number) => {
      const audio = audioRef.current;
      if (!audio || start >= clips.length) {
        setPlaying(false);
        return;
      }
      setIndex(start);
      audio.src = `/api/demo-audio/${clips[start].id}`;
      const started = audio.play();
      if (started) {
        started.catch(() => {
          // Autoplay refused, or the clip is missing. Either way the honest
          // thing is to say so rather than leave a button that does nothing.
          setFailed(true);
          setPlaying(false);
        });
      }
    },
    [clips],
  );

  const start = useCallback(() => {
    if (playing) {
      stop();
      return;
    }
    if (!reported.current) {
      reported.current = true;
      onFirstPlay?.();
    }
    setFailed(false);
    setPlaying(true);
    playFrom(0);
  }, [playing, stop, playFrom, onFirstPlay]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const next = () => {
      setIndex((i) => {
        const n = i + 1;
        if (n >= clips.length) {
          setPlaying(false);
          return -1;
        }
        audio.src = `/api/demo-audio/${clips[n].id}`;
        void audio.play().catch(() => setFailed(true));
        return n;
      });
    };
    audio.addEventListener("ended", next);
    return () => audio.removeEventListener("ended", next);
  }, [clips]);

  // Keep the speaking line in view without yanking the whole page around.
  useEffect(() => {
    if (index < 0) return;
    bodyRef.current?.querySelector(`[data-line="${index}"]`)?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
    });
  }, [index]);

  return (
    <div className="demo-player">
      <div className="demo-player-bar">
        <button type="button" className="demo-play" onClick={start} aria-pressed={playing}>
          {playing ? "■" : "▶"}
          <span>{playing ? "Stop" : `Hear how Belline would answer for ${business}`}</span>
        </button>
        <span className="demo-live" data-speaking={playing ? "true" : "false"} aria-hidden="true">
          <i /><i /><i /><i /><i />
        </span>
      </div>

      {failed && (
        <p className="demo-failed">
          The audio would not play here. Try a different browser, or call the demo line instead.
        </p>
      )}

      <div className="demo-transcript" ref={bodyRef}>
        {clips.map((clip, i) => (
          <div
            key={clip.id + i}
            data-line={i}
            className={`demo-turn demo-${clip.role}`}
            data-on={i === index ? "true" : "false"}
          >
            <span className="demo-who">{clip.role === "agent" ? "Belline" : "Caller"}</span>
            <span className="demo-text">{clip.text}</span>
          </div>
        ))}
      </div>

      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio ref={audioRef} preload="none" />
    </div>
  );
}

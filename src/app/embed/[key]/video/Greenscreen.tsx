"use client";

import { useEffect, useRef, useState } from "react";
import type { ChromaMode } from "@/lib/video/client/chroma";

/**
 * The face on the venue's chosen background (lib/video/client/chroma.ts).
 *
 * Drawn over the `<video>` in the same circle. The panel shows this canvas
 * instead of the video only once keying has actually started; any fallback —
 * no green in the stream, a slow device, a low battery — hands the circle back
 * to the plain video, which never stopped playing underneath.
 */
export default function Greenscreen({
  videoRef,
  src,
  live,
  onKeyed,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** The background picture, a path on this app. */
  src: string;
  /** The face's first frame has arrived. */
  live: boolean;
  onKeyed: (keyed: boolean) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [mode, setMode] = useState<ChromaMode | "idle">("idle");
  const [reason, setReason] = useState<string>("");

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!live || !video || !canvas || !src) return;
    let handle: { stop(): void } | null = null;
    let cancelled = false;
    const image = new Image();
    image.decoding = "async";
    image.src = src;
    void import("@/lib/video/client/chroma").then(({ startChromaKey }) => {
      if (cancelled) return;
      handle = startChromaKey({
        video,
        canvas,
        background: image,
        onMode: (next, why) => {
          setMode(next);
          setReason(why ?? "");
          onKeyed(next !== "raw");
        },
      });
    });
    return () => {
      cancelled = true;
      handle?.stop();
      onKeyed(false);
    };
    // onKeyed is a state setter from the panel: stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, src, videoRef]);

  return (
    <canvas
      ref={canvasRef}
      className={`bv-face bv-keyed${mode === "webgl" || mode === "2d" ? " is-on" : ""}`}
      data-chroma={mode}
      data-chroma-reason={reason || undefined}
      aria-hidden="true"
    />
  );
}

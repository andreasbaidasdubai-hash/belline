"use client";

import { useEffect, useRef, useState } from "react";

/**
 * "Questions? Ask Belle" on Belline's own public pages: the checkout, /verify
 * and /login.
 *
 * The same bell and the same window as the dashboard's Ask Belle (the
 * `.belle-fab` and `.belle-pop` styles), so Belle looks like one person
 * wherever she appears. Inside is not a second chat: it is Belline's own
 * website chat for `loc_belline`, framed from our own origin, in sales mode.
 * The page it was opened on rides along as `?page=` (and the selected plan on
 * checkout), which the chat route parses to a closed set and turns into a
 * sentence written on the server (belle/knowledge.ts). A visitor editing it
 * can at most switch between those fixed sentences.
 *
 * Nothing loads until the visitor opens it: no frame, no chat token, no call.
 * "Talk on video" shows only when video is on for Belline's venue, and only
 * swaps the frame to the video page, which asks the visitor to press Start
 * before any session exists.
 *
 * Out of the page's flow: fixed bottom right, with a spacer at the end of the
 * page so the last button can always be scrolled clear of it. Open or closed
 * is remembered for this browser session only.
 */

const STORAGE_KEY = "belline.belle.launcher";
const EMBED_KEY = "be_belline_site";
const PHONE = "(max-width: 599px)";

export type LauncherPage = "checkout" | "verify" | "login";

export default function BelleLauncher({
  page,
  plan,
  video = false,
  faceUrl,
}: {
  page: LauncherPage;
  /** The plan selected when the page rendered. On checkout the address bar's current one wins. */
  plan?: string;
  /** Video is available for Belline's own venue right now. */
  video?: boolean;
  /** Belle's face preview (the Belline venue's poster), else the bell. */
  faceUrl?: string;
}) {
  const [open, setOpen] = useState(false);
  /** Mounted once first opened, then kept, so a conversation survives closing. */
  const [started, setStarted] = useState(false);
  const [view, setView] = useState<"chat" | "video">("chat");
  const [chatSrc, setChatSrc] = useState("");
  const [faceFailed, setFaceFailed] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    try {
      // Reopened on the next page of the same visit, but not full screen on a phone.
      if (sessionStorage.getItem(STORAGE_KEY) === "open" && !window.matchMedia(PHONE).matches) show(true, false);
    } catch {
      /* storage is a convenience */
    }
    return () => document.documentElement.removeAttribute("data-belle-open");
    // Once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) show(false, true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function currentPlan(): string | undefined {
    if (page !== "checkout") return undefined;
    try {
      const fromUrl = new URLSearchParams(window.location.search).get("products")?.split(",")[0];
      return fromUrl || plan;
    } catch {
      return plan;
    }
  }

  function show(next: boolean, focus: boolean) {
    if (next && !started) {
      const q = new URLSearchParams({ page });
      const p = currentPlan();
      if (p) q.set("plan", p);
      setChatSrc(`/embed/${EMBED_KEY}/chat?${q.toString()}`);
      setStarted(true);
    }
    setOpen(next);
    // Lets a wide page step aside for the window instead of sitting under it (globals.css).
    document.documentElement.toggleAttribute("data-belle-open", next);
    try {
      sessionStorage.setItem(STORAGE_KEY, next ? "open" : "closed");
    } catch {
      /* storage is a convenience */
    }
    if (focus) requestAnimationFrame(() => (next ? closeRef.current : toggleRef.current)?.focus());
  }

  const face =
    faceUrl && !faceFailed ? (
      // Decorative: her name is written beside it.
      // eslint-disable-next-line @next/next/no-img-element
      <img className="belle-face" src={faceUrl} alt="" onError={() => setFaceFailed(true)} />
    ) : (
      <svg viewBox="0 0 48 48" fill="none" aria-hidden="true" focusable="false">
        <circle cx="24" cy="9.5" r="3.5" fill="currentColor" />
        <path d="M9 31.5a15 15 0 0 1 30 0Z" fill="currentColor" />
        <rect x="5" y="35" width="38" height="5.5" rx="2.75" fill="currentColor" />
      </svg>
    );

  return (
    <>
      {/* Room below the page's last button, so the bell never has to sit on it. */}
      <div className="belle-fab-spacer" aria-hidden="true" />
      <div
        id="belle-launch-pop"
        className="belle-pop belle-launch-pop"
        role="dialog"
        aria-modal="false"
        aria-labelledby="belle-launch-title"
        hidden={!open}
        data-belle-launcher={page}
      >
        <div className="belle-pop-head">
          <div style={{ minWidth: 0 }}>
            <h2 id="belle-launch-title" style={{ margin: 0, fontSize: 15 }}>
              Ask Belle
            </h2>
            <p className="muted" style={{ margin: "2px 0 0", fontSize: 12 }}>
              Belle, Belline&apos;s AI assistant
            </p>
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {video && (
              <button type="button" className="btn btn-row" onClick={() => setView(view === "chat" ? "video" : "chat")}>
                {view === "chat" ? "Talk on video" : "Back to chat"}
              </button>
            )}
            <button ref={closeRef} type="button" className="belle-pop-close" aria-label="Close Ask Belle" onClick={() => show(false, true)}>
              <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
                <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>
        {started && (
          <iframe
            key="chat"
            title="Chat with Belle"
            src={chatSrc}
            className="belle-launch-frame"
            hidden={view !== "chat"}
          />
        )}
        {/* The video page shows what happens and a Start button: no session until that is pressed. */}
        {started && video && view === "video" && (
          <iframe
            key="video"
            title="Video call with Belle"
            src={`/embed/${EMBED_KEY}/video`}
            className="belle-launch-frame"
            allow="camera; microphone; autoplay"
          />
        )}
      </div>
      <button
        ref={toggleRef}
        type="button"
        className="belle-fab belle-launch-fab"
        aria-expanded={open}
        aria-controls="belle-launch-pop"
        onClick={() => show(!open, true)}
      >
        {face}
        <span className="belle-fab-say">Questions? Ask Belle</span>
      </button>
    </>
  );
}

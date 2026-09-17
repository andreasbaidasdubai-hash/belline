"use client";

import { useEffect, useRef, useState } from "react";
import { BelleChat } from "./assistant/SetupAssistant";

/**
 * Belle in a small window over the page, reached by one floating bell.
 *
 * Asking "what should I put here?" used to mean leaving the step for
 * /setup/assistant and coming back. Here the field and the answer are on
 * screen together. It is the same Belle: the same chat component, the same
 * turn endpoint, and the same `step` she is already given by the page, so she
 * opens on the step the owner is stuck on and knows what is saved against it.
 *
 * The way in is Belline's signature button, the floating bell the website
 * uses for "Speak to Belline", bottom right, on every setup step and every
 * dashboard page. It replaced a "Belle" link in the sidebar and an "Ask Belle"
 * link in the setup header, so there is one way in rather than three.
 *
 * She used to be docked as a column beside the page on a wide screen, which
 * squeezed the step, and below that the bell left the page for
 * /setup/assistant. Now the bell opens a chat window above itself, like a
 * support widget, at every width: the page underneath keeps its full width and
 * never reflows. It is a non-modal dialog on a desk, so the owner can still
 * scroll and click the step beside it. On a phone there is no "beside", so the
 * window fills the screen and is modal while it does, with focus kept inside
 * it until it is closed. /setup/assistant is still a page for deep links.
 *
 * Closing hides the window rather than unmounting it, so a half-typed question
 * and the conversation so far are still there when the bell is pressed again.
 *
 * Open or closed is the owner's, and it is remembered: closed the first time so
 * a page is not crowded for somebody who does not need help, then open once
 * they have asked for it. On a phone the remembered "open" is not reapplied on
 * load, as it never was: a full-screen window over every page they visit would
 * hide the page they came for. Escape or the close button closes it and focus
 * goes back to the bell.
 */

const PHONE = "(max-width: 599px)";

export default function BelleDock({
  locationId,
  step,
  greeting,
  storageKey = "belline.setup.belle-dock",
  faceUrl,
  video = false,
  children,
}: {
  locationId: string;
  /** The setup step she is beside. None on a dashboard page. */
  step?: string;
  greeting: string;
  /** Setup and the dashboard remember open or closed separately. */
  storageKey?: string;
  /** Belle's face preview (Belline's own video face), else the bell. */
  faceUrl?: string;
  /** Offer "Talk to Belle on video": only while support video is available. */
  video?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // Chat, or the video page framed in its place. The video page asks for a
  // press on Start before any session exists.
  const [view, setView] = useState<"chat" | "video">("chat");
  const [faceFailed, setFaceFailed] = useState(false);
  const [phone, setPhone] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Focus only follows a press, never a page load: coming back to a step with
  // the window already open should leave the owner at the top of the step.
  const follow = useRef<"panel" | "toggle" | null>(null);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(storageKey);
    } catch {
      // Private browsing, or storage switched off. Closed, every time, is fine.
    }
    if (stored === "open" && !window.matchMedia(PHONE).matches) setOpen(true);
  }, [storageKey]);

  useEffect(() => {
    const mq = window.matchMedia(PHONE);
    const sync = () => setPhone(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    // Into the message box, so the owner can type straight away; the header
    // if the box is somehow not there.
    if (follow.current === "panel" && open) (inputRef.current ?? panelRef.current)?.focus();
    if (follow.current === "toggle" && !open) toggleRef.current?.focus();
    follow.current = null;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      set(false, "toggle");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, storageKey]);

  function set(next: boolean, focus: "panel" | "toggle") {
    follow.current = focus;
    setOpen(next);
    try {
      window.localStorage.setItem(storageKey, next ? "open" : "closed");
    } catch {
      // Not being able to remember it is not a reason to refuse to open it.
    }
  }

  // Full screen on a phone the page behind is out of reach, so Tab goes round
  // the window instead of wandering off into controls nobody can see.
  function trapTab(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!phone || e.key !== "Tab" || !panelRef.current) return;
    const focusable = Array.from(
      panelRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'),
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="belle-host">
      {children}
      {/* Hidden, not unmounted, when closed: the conversation and a half-typed
          question survive closing and reopening on the same page. */}
      <div
        ref={panelRef}
        id="belle-pop"
        className="belle-pop"
        role="dialog"
        aria-modal={phone ? "true" : "false"}
        aria-labelledby="belle-pop-title"
        tabIndex={-1}
        hidden={!open}
        onKeyDown={trapTab}
      >
        <div className="belle-pop-head">
          <div style={{ minWidth: 0, display: "flex", gap: 10, alignItems: "center" }}>
            {faceUrl && !faceFailed && (
              // Decorative: her name is beside it.
              // eslint-disable-next-line @next/next/no-img-element
              <img className="belle-face belle-face-lg" src={faceUrl} alt="" onError={() => setFaceFailed(true)} />
            )}
            <div style={{ minWidth: 0 }}>
              <h2 id="belle-pop-title" style={{ margin: 0, fontSize: 15 }}>
                Ask Belle
              </h2>
              <p className="muted" style={{ margin: "2px 0 0", fontSize: 12 }}>
                Belle, Belline&apos;s AI assistant. {step ? "About this step, or anything else." : "Your account, setup, or anything about Belline."}
              </p>
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flex: "none" }}>
            {video && (
              <button type="button" className="btn btn-row" onClick={() => setView(view === "chat" ? "video" : "chat")}>
                {view === "chat" ? "Talk on video" : "Back to chat"}
              </button>
            )}
            <button type="button" className="belle-pop-close" aria-label="Close Ask Belle" onClick={() => set(false, "toggle")}>
              <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
                <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>
        <div hidden={view !== "chat"} style={{ display: view === "chat" ? "flex" : "none", flexDirection: "column", flex: 1, minHeight: 0 }}>
          <BelleChat fill handover locationId={locationId} step={step} greeting={greeting} inputRef={inputRef} />
        </div>
        {video && view === "video" && (
          <iframe title="Talk to Belle on video" src="/embed/belle/video" className="belle-launch-frame" allow="camera; microphone; autoplay" />
        )}
      </div>
      {/* The bell stays while the window is open, as its toggle: the window sits
          above it, never on it. On a phone the window covers the whole screen,
          bell included, and has its own close button in the header. */}
      <button
        ref={toggleRef}
        type="button"
        className="belle-fab"
        aria-expanded={open}
        aria-controls="belle-pop"
        onClick={() => set(!open, open ? "toggle" : "panel")}
      >
        {faceUrl && !faceFailed ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="belle-face" src={faceUrl} alt="" onError={() => setFaceFailed(true)} />
        ) : (
          <svg viewBox="0 0 48 48" fill="none" aria-hidden="true" focusable="false">
            <circle cx="24" cy="9.5" r="3.5" fill="currentColor" />
            <path d="M9 31.5a15 15 0 0 1 30 0Z" fill="currentColor" />
            <rect x="5" y="35" width="38" height="5.5" rx="2.75" fill="currentColor" />
          </svg>
        )}
        <span className="belle-fab-say">Ask Belle</span>
      </button>
    </div>
  );
}

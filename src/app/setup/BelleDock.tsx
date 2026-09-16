"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BelleChat } from "./assistant/SetupAssistant";

/**
 * Belle beside the page, not instead of it, reached by one floating bell.
 *
 * Asking "what should I put here?" used to mean leaving the step for
 * /setup/assistant and coming back. Docked, the field and the answer are on
 * screen together. It is the same Belle: the same chat component, the same
 * turn endpoint, and the same `step` she is already given by the page, so she
 * opens on the step the owner is stuck on and knows what is saved against it.
 *
 * The way in is Belline's signature button, the floating bell the website
 * uses for "Speak to Belline", bottom right, on every setup step and every
 * dashboard page. It replaced a "Belle" link in the sidebar and an "Ask Belle"
 * link in the setup header, so there is one way in rather than three.
 *
 * From 1024px up it opens the docked panel. Narrower than that a 340px panel
 * leaves the page unreadable, so nothing is docked at all and the bell opens
 * the full page, which is also where every deep link into /setup/assistant
 * still lands.
 *
 * Open or closed is the owner's, and it is remembered: closed the first time so
 * a page is not crowded for somebody who does not need help, then open once
 * they have asked for it. Escape closes the panel and focus goes back to the
 * bell.
 */

const WIDE = "(min-width: 1024px)";

export default function BelleDock({
  locationId,
  step,
  greeting,
  storageKey = "belline.setup.belle-dock",
  children,
}: {
  locationId: string;
  /** The setup step she is beside. None on a dashboard page. */
  step?: string;
  greeting: string;
  /** Setup and the dashboard remember open or closed separately. */
  storageKey?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [wide, setWide] = useState(false);
  const router = useRouter();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Focus only follows a press, never a page load: coming back to a step with
  // the panel already open should leave the owner at the top of the step.
  const follow = useRef<"panel" | "toggle" | null>(null);
  const fullPage = step ? `/setup/assistant?step=${step}` : `/setup/assistant?loc=${encodeURIComponent(locationId)}`;

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(storageKey);
    } catch {
      // Private browsing, or storage switched off. Closed, every time, is fine.
    }
    if (stored === "open") setOpen(true);
  }, [storageKey]);

  useEffect(() => {
    const mq = window.matchMedia(WIDE);
    const sync = () => setWide(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (follow.current === "panel" && open && wide) panelRef.current?.focus();
    if (follow.current === "toggle" && !open) toggleRef.current?.focus();
    follow.current = null;
  }, [open, wide]);

  useEffect(() => {
    if (!open || !wide) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      set(false, "toggle");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, wide]);

  function set(next: boolean, focus: "panel" | "toggle") {
    follow.current = focus;
    setOpen(next);
    try {
      window.localStorage.setItem(storageKey, next ? "open" : "closed");
    } catch {
      // Not being able to remember it is not a reason to refuse to open it.
    }
  }

  const docked = wide && open;

  return (
    <div className="setup-dock">
      <div className="setup-dock-main">{children}</div>
      {docked && (
        <aside id="belle-dock" className="setup-dock-panel" aria-labelledby="belle-dock-title">
          <div ref={panelRef} tabIndex={-1} className="setup-dock-head">
            <div>
              <strong id="belle-dock-title" style={{ fontSize: 14 }}>
                Ask Belle
              </strong>
              <p className="muted" style={{ margin: "2px 0 0", fontSize: 12 }}>
                {step ? "About this step." : "About setting up and changing Belline."} She saves what you tell her.
              </p>
            </div>
            <button type="button" className="btn" onClick={() => set(false, "toggle")} style={{ fontSize: 13, padding: "7px 13px" }}>
              Hide Belle
            </button>
          </div>
          <BelleChat fill locationId={locationId} step={step} greeting={greeting} />
        </aside>
      )}
      {/* While the panel is open it has its own Hide button, and the bell
          would sit on top of its message box. */}
      {!docked && (
        <button
          ref={toggleRef}
          type="button"
          className="belle-fab"
          aria-expanded={wide ? false : undefined}
          onClick={() => (wide ? set(true, "panel") : router.push(fullPage))}
        >
          <svg viewBox="0 0 48 48" fill="none" aria-hidden="true" focusable="false">
            <circle cx="24" cy="9.5" r="3.5" fill="currentColor" />
            <path d="M9 31.5a15 15 0 0 1 30 0Z" fill="currentColor" />
            <rect x="5" y="35" width="38" height="5.5" rx="2.75" fill="currentColor" />
          </svg>
          <span className="belle-fab-say">Ask Belle</span>
        </button>
      )}
    </div>
  );
}

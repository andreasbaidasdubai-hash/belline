"use client";

import { useEffect, useRef, useState } from "react";
import { BelleChat } from "./assistant/SetupAssistant";

/**
 * Belle beside the step, not instead of it.
 *
 * Asking "what should I put here?" used to mean leaving the step for
 * /setup/assistant and coming back. Docked, the field and the answer are on
 * screen together. It is the same Belle: the same chat component, the same
 * turn endpoint, and the same `step` she is already given by the page, so she
 * opens on the step the owner is stuck on and knows what is saved against it.
 *
 * Only from 1024px up. Narrower than that a 340px panel leaves the step column
 * unreadable, so nothing is docked at all and the header's "Ask Belle" opens
 * the full page, which is also where every deep link into /setup/assistant
 * still lands.
 *
 * Open or closed is the owner's, and it is remembered: closed the first time so
 * a step is not crowded for somebody who does not need help, then open through
 * the rest of setup once they have asked for it.
 */

const WIDE = "(min-width: 1024px)";
const KEY = "belline.setup.belle-dock";

export default function BelleDock({
  locationId,
  step,
  greeting,
  children,
}: {
  locationId: string;
  step: string;
  greeting: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [wide, setWide] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Focus only follows a press, never a page load: coming back to a step with
  // the panel already open should leave the owner at the top of the step.
  const follow = useRef<"panel" | "toggle" | null>(null);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(KEY);
    } catch {
      // Private browsing, or storage switched off. Closed, every time, is fine.
    }
    if (stored === "open") setOpen(true);
  }, []);

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
      window.localStorage.setItem(KEY, next ? "open" : "closed");
    } catch {
      // Not being able to remember it is not a reason to refuse to open it.
    }
  }

  const toggle = (
    <button
      ref={toggleRef}
      type="button"
      className="btn"
      aria-expanded={open}
      {...(open ? { "aria-controls": "belle-dock" } : {})}
      onClick={() => set(!open, open ? "toggle" : "panel")}
      style={{ fontSize: 13, padding: "7px 13px" }}
    >
      {open ? "Hide Belle" : "Ask Belle"}
    </button>
  );

  return (
    <div className="setup-dock">
      <div className="setup-dock-main">{children}</div>
      {wide &&
        (open ? (
          <aside id="belle-dock" className="setup-dock-panel" aria-labelledby="belle-dock-title">
            <div ref={panelRef} tabIndex={-1} className="setup-dock-head">
              <div>
                <strong id="belle-dock-title" style={{ fontSize: 14 }}>
                  Ask Belle
                </strong>
                <p className="muted" style={{ margin: "2px 0 0", fontSize: 12 }}>
                  About this step. She saves what you tell her.
                </p>
              </div>
              {toggle}
            </div>
            <BelleChat fill locationId={locationId} step={step} greeting={greeting} />
          </aside>
        ) : (
          <div className="setup-dock-tab">{toggle}</div>
        ))}
    </div>
  );
}

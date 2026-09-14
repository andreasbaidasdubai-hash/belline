"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Ctrl+K (⌘K on a Mac): find a booking, a customer, a location or a page.
 *
 * Arrow keys to move, Enter to open, Escape to close. Also reachable from the
 * sidebar button, for anybody who does not live on a keyboard.
 */

interface Hit {
  kind: "page" | "location" | "booking" | "customer";
  title: string;
  detail: string;
  href: string;
}

const LABEL: Record<Hit["kind"], string> = { booking: "Booking", customer: "Customer", location: "Location", page: "Page" };

export default function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) {
      setQ("");
      setHits([]);
      setActive(0);
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => {
    if (!open || q.trim().length < 1) {
      setHits([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: controller.signal });
        const body = (await res.json()) as { hits?: Hit[] };
        setHits(body.hits ?? []);
        setActive(0);
      } catch {
        /* still typing */
      }
    }, 160);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q, open]);

  function go(hit: Hit | undefined) {
    if (!hit) return;
    setOpen(false);
    router.push(hit.href);
  }

  return (
    <>
      <button type="button" className="palette-trigger" onClick={() => setOpen(true)} aria-label="Search (Ctrl+K)">
        <span>Search…</span>
        <kbd>Ctrl K</kbd>
      </button>

      {open && (
        <div className="palette-scrim" onClick={() => setOpen(false)}>
          <div className="palette" role="dialog" aria-modal="true" aria-label="Search" onClick={(e) => e.stopPropagation()}>
            <input
              ref={input}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActive((a) => Math.min(a + 1, hits.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActive((a) => Math.max(a - 1, 0));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  go(hits[active]);
                }
              }}
              placeholder="Booking reference, customer name or number, a page…"
              aria-label="Search"
            />
            <div className="palette-results" role="listbox">
              {q.trim() && hits.length === 0 && <p className="muted" style={{ padding: "14px 16px", margin: 0, fontSize: 13 }}>Nothing found.</p>}
              {hits.map((hit, i) => (
                <button
                  type="button"
                  key={`${hit.kind}-${hit.href}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  className={i === active ? "on" : undefined}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(hit)}
                >
                  <span className="palette-kind">{LABEL[hit.kind]}</span>
                  <span className="palette-title">{hit.title}</span>
                  <span className="muted palette-detail">{hit.detail}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

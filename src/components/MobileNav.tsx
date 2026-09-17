"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { navItemOn, type NavGroup, type NavItem } from "@/lib/nav-shape";

/**
 * The navigation, on a phone.
 *
 * Below the sidebar breakpoint the nav used to become a horizontally scrolling
 * strip about a hundred pixels wide with its scrollbar hidden. It was
 * swipeable, and nothing about it said so: the screenshots showed "Needs you"
 * and "Overview" and then "Sign out", and a salon owner holding a phone had no
 * reason to believe there were sixteen more links behind them. A menu that
 * cannot be seen is not a menu.
 *
 * This is a button that says Menu and a panel that lists everything at a
 * height a thumb can hit. The one thing that is ever urgent — the attention
 * count — rides on the button, so it is visible without opening anything. It
 * lists exactly what the desktop sidebar lists, groups included, from the same
 * `navFor` answer.
 */
export type { NavItem };

export default function MobileNav({ items, groups = [] }: { items: NavItem[]; groups?: NavGroup[] }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // A navigation closes when it has been used, or the next page loads under
  // an open menu.
  useEffect(() => setOpen(false), [pathname]);

  // Escape used to close the menu and leave focus on <body>, so the next Tab
  // started again from the top of the page.
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      toggleRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const urgent = items.find((i) => i.badge && !i.quiet)?.badge ?? 0;

  const link = (item: NavItem) => {
    const on = navItemOn(item, pathname);
    return (
      <Link key={item.href} href={item.href} className={`mobile-nav-link${on ? " is-on" : ""}`} aria-current={on ? "page" : undefined}>
        {item.label}
        {item.badge ? <span className={`mobile-nav-count${item.quiet ? " is-quiet" : ""}`}>{item.badge}</span> : null}
      </Link>
    );
  };

  return (
    <div className="mobile-nav">
      <button
        ref={toggleRef}
        type="button"
        className="mobile-nav-toggle"
        aria-expanded={open}
        aria-controls="mobile-nav-panel"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "Close" : "Menu"}
        {urgent > 0 && !open && (
          <span className="mobile-nav-badge" aria-label={`${urgent} needing attention`}>
            {urgent}
          </span>
        )}
      </button>

      <div id="mobile-nav-panel" className="mobile-nav-panel" hidden={!open}>
        {items.map(link)}
        {groups.map((group) => (
          <div key={group.title} role="group" aria-label={group.title}>
            <div className="mobile-nav-group" aria-hidden="true">
              {group.title}
            </div>
            {group.items.map(link)}
          </div>
        ))}
      </div>
    </div>
  );
}

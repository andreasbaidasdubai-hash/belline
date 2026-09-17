"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * The tabs inside one menu destination: Inbox, Your business, Channels and
 * Settings each hold a few pages, and this is how the owner moves between them.
 *
 * Real links to real pages rather than a client-side switch, so every tab has
 * an address, the back button works, and each page loads what is saved rather
 * than a copy another tab edited. The venue being looked at (?loc=) rides
 * along, so switching tab never switches venue.
 */
export interface SectionTab {
  href: string;
  label: string;
}

export default function SectionTabs({ tabs, label }: { tabs: SectionTab[]; label: string }) {
  const pathname = usePathname();
  const loc = useSearchParams().get("loc");
  // The longest matching prefix wins, so /channels does not light up on /channels/phone.
  const active = tabs
    .filter((t) => pathname === t.href || pathname.startsWith(`${t.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];
  return (
    <nav className="section-tabs" aria-label={label}>
      {tabs.map((t) => {
        const on = t === active;
        return (
          <Link key={t.href} href={loc ? `${t.href}?loc=${encodeURIComponent(loc)}` : t.href} aria-current={on ? "page" : undefined} className={on ? "is-on" : undefined}>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

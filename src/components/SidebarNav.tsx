"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { navItemOn, type NavGroup, type NavItem } from "@/lib/nav-shape";

/**
 * The navigation, on a desktop.
 *
 * It lived in the server layout, which cannot know the path, so no link was
 * ever marked as the page you are on: not for the eye and not for a screen
 * reader. The phone menu already did this; the same rule applies here. Colour
 * is left to globals.css, because an inline colour would beat the current-page
 * rule.
 *
 * A destination with tabs is marked from any of them (`match`): Inbox stays
 * current on /conversations, Settings on /billing.
 */
export default function SidebarNav({ items, groups = [] }: { items: NavItem[]; groups?: NavGroup[] }) {
  const pathname = usePathname();
  return (
    <>
      {items.map((item) => (
        <NavLink key={item.href} item={item} on={navItemOn(item, pathname)} />
      ))}
      {groups.map((group) => (
        <div key={group.title} role="group" aria-labelledby={`nav-group-${group.title}`} style={{ marginTop: 16, paddingTop: 6, borderTop: "1px solid var(--border)" }}>
          <div id={`nav-group-${group.title}`} className="nav-group-title">
            {group.title}
          </div>
          {group.items.map((item) => (
            <NavLink key={item.href} item={item} on={navItemOn(item, pathname)} />
          ))}
        </div>
      ))}
    </>
  );
}

function NavLink({ item, on }: { item: NavItem; on: boolean }) {
  return (
    <Link
      href={item.href}
      className="navlink"
      aria-current={on ? "page" : undefined}
      style={{
        padding: "8px 10px",
        borderRadius: 8,
        fontSize: 13,
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}
    >
      {item.label}
      {item.badge ? (
        <span
          style={{
            marginLeft: "auto",
            minWidth: 19,
            height: 19,
            padding: "0 6px",
            borderRadius: 999,
            // Only one thing in this product is ever urgent. A recall
            // list is work to get through, not an alarm, and dressing
            // it as one is how a red dot stops meaning anything.
            background: item.quiet ? "var(--accent-soft)" : "var(--bad)",
            color: item.quiet ? "var(--accent)" : "#fff",
            fontSize: 11,
            fontWeight: 700,
            display: "grid",
            placeItems: "center",
            fontVariantNumeric: "tabular-nums",
          }}
          aria-label={item.quiet ? `${item.badge} due back` : `${item.badge} needing attention`}
        >
          {item.badge}
        </span>
      ) : null}
    </Link>
  );
}

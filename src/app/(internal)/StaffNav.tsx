"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** The staff console's menu. A client component only so the page you are on is marked. */

export const STAFF_MENU = [
  { href: "/sales", label: "Today" },
  { href: "/sales/leads", label: "Leads" },
  { href: "/sales/outreach", label: "Outreach" },
  { href: "/sales/customers", label: "Customers" },
  { href: "/sales/issues", label: "Issues" },
  { href: "/sales/revenue", label: "Revenue" },
  { href: "/sales/settings", label: "Settings" },
] as const;

export default function StaffNav() {
  const pathname = usePathname() ?? "";
  return (
    <>
      {STAFF_MENU.map((item) => {
        const on = item.href === "/sales" ? pathname === "/sales" : pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link key={item.href} href={item.href} className="navlink staff-navlink" aria-current={on ? "page" : undefined}>
            {item.label}
          </Link>
        );
      })}
      <div className="staff-nav-foot">
        <Link href="/" className="navlink staff-navlink quiet">
          ← Customer dashboard
        </Link>
      </div>
    </>
  );
}

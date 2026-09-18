import Link from "next/link";

/** The sections of Outreach, as tabs. Same chip style as the rest of the console. */

const TABS = [
  { href: "/sales/outreach", label: "Today" },
  { href: "/sales/outreach/batches", label: "Approve a batch" },
  { href: "/sales/outreach/stages", label: "Stages" },
  { href: "/sales/outreach/replies", label: "Replies" },
  { href: "/sales/outreach/domains", label: "Domains" },
  { href: "/sales/outreach/countries", label: "Countries" },
] as const;

export type OutreachTab = (typeof TABS)[number]["href"];

export default function OutreachTabs({ active }: { active: OutreachTab }) {
  return (
    <nav className="staff-tabs" aria-label="Outreach">
      {TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className={`staff-chip${t.href === active ? " on" : ""}`}
          aria-current={t.href === active ? "page" : undefined}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

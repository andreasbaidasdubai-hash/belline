import Link from "next/link";

/** The sections of Settings, as tabs. Same chip style as every filter in the console. */

const TABS = [
  { href: "/sales/settings", label: "AI sales agents" },
  { href: "/sales/settings/video", label: "Video receptionist" },
  { href: "/sales/settings/demo-lines", label: "Demo lines" },
  { href: "/sales/settings/numbers", label: "Number pool" },
  { href: "/sales/settings/activity", label: "Activity log" },
] as const;

export default function SettingsTabs({ active }: { active: (typeof TABS)[number]["href"] }) {
  return (
    <nav className="staff-tabs" aria-label="Settings">
      {TABS.map((t) => (
        <Link key={t.href} href={t.href} className={`staff-chip${t.href === active ? " on" : ""}`} aria-current={t.href === active ? "page" : undefined}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

import Link from "next/link";
import { requireUser } from "@/lib/auth-server";
import { visibleLocations } from "@/lib/auth";
import { seedIfEmpty } from "@/lib/seed";
import { advancedGroups } from "@/lib/nav";
import { PageHeader } from "@/components/LocationTabs";

export const dynamic = "force-dynamic";

export const metadata = { title: "Everything else" };

/**
 * Every page that is not one of the seven destinations.
 *
 * The honest name for this screen is "the pages we decided most owners should
 * not have to walk past". That is a judgement about the median business, and
 * it is wrong for some of them — so the judgement is reversible in one click
 * rather than enforced by deleting a route.
 *
 * Each group says what it is for. A list of eleven links with no explanation
 * is a worse version of the navigation this replaced.
 */
export default async function AdvancedPage() {
  seedIfEmpty();
  const user = await requireUser();
  const groups = advancedGroups(user, visibleLocations(user));

  return (
    <>
      <PageHeader
        title="Everything else"
        subtitle="Every page in Belline that is not one of the seven on the left. Nothing here has been switched off or taken away — these are the parts most businesses do not need every day, kept one click from the ones they do."
      />

      {groups.map((group) => (
        <section key={group.title} className="panel" style={{ marginBottom: 14 }}>
          <div className="panel-head">{group.title}</div>
          <div style={{ padding: "14px 18px 18px" }}>
            <p className="muted" style={{ margin: "0 0 14px", fontSize: 13, lineHeight: 1.6, maxWidth: "70ch" }}>
              {group.note}
            </p>
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 2 }}>
              {group.items.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    style={{
                      display: "flex",
                      gap: 12,
                      alignItems: "baseline",
                      flexWrap: "wrap",
                      padding: "9px 10px",
                      borderRadius: 8,
                      textDecoration: "none",
                    }}
                  >
                    <span style={{ fontWeight: 600, fontSize: 13.5 }}>{item.label}</span>
                    <span className="muted" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
                      {item.note}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>
      ))}
    </>
  );
}
